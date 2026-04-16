//! Background thumbnail-generation worker thread.
//!
//! # Architecture
//!
//! At application startup a dedicated OS thread is spawned (`thumbnail_worker_loop`).
//! The thread owns its own [`rusqlite::Connection`] and never touches the shared
//! [`super::commands::DbState`] mutex.  Because SQLite is opened in WAL mode,
//! the background connection can read and write concurrently with the main
//! application connection without long-term lock contention.
//!
//! Commands are sent to the thread via a [`std::sync::mpsc`] channel:
//!
//! * [`ThumbnailCommand::Start`] — begin (or restart) the generation loop.
//! * [`ThumbnailCommand::Cancel`] — stop after the current batch finishes.
//!
//! Progress is reported back to the frontend via Tauri's event bus:
//!
//! | Event                  | Payload type             |
//! |------------------------|--------------------------|
//! | `thumbnail_progress`   | [`ThumbnailProgress`]    |
//! | `thumbnail_done`       | [`ThumbnailDone`]        |
//! | `thumbnail_error`      | `String`                 |

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

use photomap_core::{generate_thumbnails_batch, count_pending_thumbnails};

// ── Commands sent *to* the worker ─────────────────────────────────────────────

/// Commands the frontend (via Tauri) can send to the background worker.
pub enum ThumbnailCommand {
    /// Begin generating thumbnails in batches of `batch_size`.
    Start { batch_size: u32 },
    /// Stop the current run after the in-progress batch completes.
    Cancel,
}

// ── Events emitted *from* the worker ──────────────────────────────────────────

/// Emitted after each successfully processed batch.
#[derive(Clone, Serialize)]
pub struct ThumbnailProgress {
    /// Total thumbnails generated so far in this run.
    pub done: u32,
    /// Photos still waiting to be processed.
    pub remaining: u32,
    /// Estimated total at the start of the run (`done + remaining` on first
    /// batch; frozen afterwards so the progress bar doesn't shrink).
    pub total: u32,
}

/// Emitted when the worker finishes a full run or is cancelled.
#[derive(Clone, Serialize)]
pub struct ThumbnailDone {
    /// Total thumbnails generated in this run.
    pub done: u32,
    /// `true` when the run was stopped early by a [`ThumbnailCommand::Cancel`].
    pub cancelled: bool,
}

// ── Worker loop ───────────────────────────────────────────────────────────────

/// Entry point for the background thread.
///
/// Blocks indefinitely, waiting for [`ThumbnailCommand`]s.  Returns only when
/// the command channel is dropped (i.e. the application exits).
pub fn thumbnail_worker_loop(
    conn: Connection,
    thumbnail_dir: PathBuf,
    rx: Receiver<ThumbnailCommand>,
    app: AppHandle,
) {
    loop {
        // ── Wait for a Start command ──────────────────────────────────────────
        let batch_size = loop {
            match rx.recv() {
                Ok(ThumbnailCommand::Start { batch_size }) => break batch_size,
                Ok(ThumbnailCommand::Cancel) => continue, // idle → ignore
                Err(_) => return,                          // channel closed → exit
            }
        };

        let mut done: u32 = 0;
        let mut cancelled = false;

        // ── Count pending work upfront ────────────────────────────────────────
        // Knowing the total before the first batch lets the UI show an accurate
        // progress bar from the start and avoids the "stuck on Starting" symptom
        // caused by React batching the first thumbnail_progress + thumbnail_done
        // events when there is only one batch of work.
        let total: u32 = match count_pending_thumbnails(&conn) {
            Ok(n) => n,
            Err(e) => {
                let _ = app.emit("thumbnail_error", e.to_string());
                continue;
            }
        };

        // ── Short-circuit when there is nothing to do ─────────────────────────
        if total == 0 {
            let _ = app.emit("thumbnail_done", ThumbnailDone { done: 0, cancelled: false });
            continue;
        }

        // Emit the initial progress so the UI shows the correct total before
        // any decode work begins.
        let _ = app.emit(
            "thumbnail_progress",
            ThumbnailProgress {
                done: 0,
                remaining: total,
                total,
            },
        );

        // ── Generation loop ───────────────────────────────────────────────────
        loop {
            // Non-blocking poll for a new command.
            match rx.try_recv() {
                Ok(ThumbnailCommand::Cancel) => {
                    cancelled = true;
                    break;
                }
                Ok(ThumbnailCommand::Start { .. }) => {
                    // Re-start: reset counters and continue.
                    done = 0;
                    total = 0;
                }
                Err(TryRecvError::Empty) => {}        // nothing pending
                Err(TryRecvError::Disconnected) => return, // app exiting
            }

            let report = match generate_thumbnails_batch(&conn, &thumbnail_dir, batch_size) {
                Ok(r) => r,
                Err(e) => {
                    let _ = app.emit("thumbnail_error", e.to_string());
                    break;
                }
            };

            done += report.processed;

            let _ = app.emit(
                "thumbnail_progress",
                ThumbnailProgress {
                    done,
                    remaining: report.remaining,
                    total,
                },
            );

            if report.remaining == 0 {
                break;
            }

            // Brief sleep so we don't saturate the CPU between batches.
            std::thread::sleep(Duration::from_millis(50));
        }

        // ── Notify the frontend that this run has finished ────────────────────
        let _ = app.emit("thumbnail_done", ThumbnailDone { done, cancelled });
    }
}
