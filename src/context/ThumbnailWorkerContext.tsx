/**
 * Global background thumbnail-generation worker bridge.
 *
 * The actual thumbnail decoding happens on a **dedicated Rust OS thread** that
 * owns its own SQLite connection — it never blocks the main application
 * connection.  This context acts as the React-side bridge: it subscribes to
 * Tauri events emitted by that thread and exposes a clean `start` / `cancel`
 * API to the rest of the UI.
 *
 * ## Events (Tauri → React)
 * | Event                | Payload                                   |
 * |----------------------|-------------------------------------------|
 * | `thumbnail_progress` | `{ done, remaining, total }`              |
 * | `thumbnail_done`     | `{ done, cancelled }`                     |
 * | `thumbnail_error`    | `string`                                  |
 *
 * ## Usage
 * ```tsx
 * const { isRunning, done, total, status, start, cancel } = useThumbnailWorker();
 * ```
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { startThumbnailWorker, cancelThumbnailWorker } from "../api/photos";

/** Photos to process per backend batch. Larger = fewer round-trips. */
const BATCH_SIZE = 10;

// ── Event payload types ───────────────────────────────────────────────────────

interface ThumbnailProgressPayload {
  done: number;
  remaining: number;
  total: number;
}

interface ThumbnailDonePayload {
  done: number;
  cancelled: boolean;
}

// ── Context value shape ───────────────────────────────────────────────────────

export interface ThumbnailWorkerState {
  isRunning: boolean;
  done: number;
  total: number;
  /** Short human-readable status message (empty when idle). */
  status: string;
  /**
   * Increments each time a thumbnail generation run completes (`thumbnail_done`
   * event).  Components can watch this value to automatically refresh their
   * photo lists.
   */
  refreshKey: number;
  /** Start (or restart) the background generation worker. */
  start: () => void;
  /** Request cancellation of the running worker. */
  cancel: () => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ThumbnailWorkerContext = createContext<ThumbnailWorkerState | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function ThumbnailWorkerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isRunning, setIsRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // Track whether we're currently running so callbacks close over latest value.
  const isRunningRef = useRef(false);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  // ── Subscribe to Tauri events once on mount ───────────────────────────────
  useEffect(() => {
    type Unlisten = () => void;
    const unlisteners: Unlisten[] = [];

    void (async () => {
      unlisteners.push(
        await listen<ThumbnailProgressPayload>(
          "thumbnail_progress",
          (event) => {
            const { done: d, remaining, total: t } = event.payload;
            setDone(d);
            setTotal(t);
            setStatus(`Processing… (${remaining} remaining)`);
          }
        )
      );

      unlisteners.push(
        await listen<ThumbnailDonePayload>("thumbnail_done", (event) => {
          setDone(event.payload.done);
          setStatus(event.payload.cancelled ? "Cancelled" : "Done");
          setIsRunning(false);
          setRefreshKey((k) => k + 1);
        })
      );

      unlisteners.push(
        await listen<string>("thumbnail_error", (event) => {
          setStatus(`Error: ${event.payload}`);
          setIsRunning(false);
        })
      );
    })();

    return () => {
      for (const unlisten of unlisteners) unlisten();
    };
  }, []); // run once on mount

  // ── Public API ────────────────────────────────────────────────────────────

  const start = useCallback(() => {
    if (isRunningRef.current) {
      // Re-start: the worker will reset its counters.
      void startThumbnailWorker(BATCH_SIZE);
      return;
    }
    setIsRunning(true);
    setDone(0);
    setTotal(0);
    setStatus("Starting…");
    void startThumbnailWorker(BATCH_SIZE);
  }, []);

  const cancel = useCallback(() => {
    void cancelThumbnailWorker();
  }, []);

  return (
    <ThumbnailWorkerContext.Provider
      value={{ isRunning, done, total, status, refreshKey, start, cancel }}
    >
      {children}
    </ThumbnailWorkerContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/** Access the global thumbnail-generation worker state. */
export function useThumbnailWorker(): ThumbnailWorkerState {
  const ctx = useContext(ThumbnailWorkerContext);
  if (!ctx) {
    throw new Error(
      "useThumbnailWorker must be used inside <ThumbnailWorkerProvider>"
    );
  }
  return ctx;
}
