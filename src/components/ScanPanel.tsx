import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { scanDirectory, generateThumbnailsBatch } from "../api/photos";
import type { ScanReport, ThumbnailBatchReport } from "../api/types";
import { homeDir } from '@tauri-apps/api/path';

/** Tauri extends the standard File with a native `path` property. */
interface TauriFile extends File {
  path?: string;
}

/** Number of thumbnails to generate per backend call. Kept small to avoid
 *  blocking the UI thread for a long stretch on each batch. */
const THUMB_BATCH_SIZE = 5;

/** Milliseconds to yield to the UI between thumbnail batches. */
const THUMB_BATCH_DELAY_MS = 200;

// ── Recent directories (persisted to localStorage) ────────────────────────────

const RECENT_DIRS_KEY = "photomap_recent_dirs";
const MAX_RECENT_DIRS = 8;

function loadRecentDirs(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_DIRS_KEY);
    return stored ? (JSON.parse(stored) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecentDir(dir: string): string[] {
  const next = [dir, ...loadRecentDirs().filter((d) => d !== dir)].slice(
    0,
    MAX_RECENT_DIRS
  );
  try {
    localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(next));
  } catch {
    /* storage full — ignore */
  }
  return next;
}

export function ScanPanel() {
  const [dir, setDir] = useState("");
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Recently scanned directories loaded from localStorage on mount. */
  const [recentDirs, setRecentDirs] = useState<string[]>(() => loadRecentDirs());

  // Thumbnail generation state
  const [thumbRunning, setThumbRunning] = useState(false);
  const [thumbReport, setThumbReport] = useState<ThumbnailBatchReport | null>(null);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const [thumbTotal, setThumbTotal] = useState(0);
  const [thumbDone, setThumbDone] = useState(0);
  /** Short status message shown during thumbnail generation. */
  const [thumbStatus, setThumbStatus] = useState("");

  async function handleScan(path?: string) {
    const trimmed = (path ?? dir).trim();
    if (!trimmed) return;
    setScanning(true);
    setReport(null);
    setError(null);
    try {
      const result = await scanDirectory(trimmed);
      setReport(result);
      // Persist the directory so it appears in "Recently scanned".
      setRecentDirs(saveRecentDir(trimmed));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function chooseDirectory() {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select a folder to scan", defaultPath: dir || await homeDir() });
      if (typeof selected === "string") {
        setDir(selected);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleGenerateThumbnails() {
    setThumbRunning(true);
    setThumbReport(null);
    setThumbError(null);
    setThumbTotal(0);
    setThumbDone(0);
    setThumbStatus("Starting…");

    try {
      // First call gives us the initial "remaining" to show overall progress.
      let lastReport = await generateThumbnailsBatch(THUMB_BATCH_SIZE);
      const initial = lastReport.processed + lastReport.remaining;
      setThumbTotal(initial);
      setThumbDone(lastReport.processed);

      // Keep batching until nothing is left, yielding between each batch so
      // the UI stays responsive and CPU spikes are smoothed out.
      while (lastReport.remaining > 0) {
        setThumbStatus(`Processing… (${lastReport.remaining} remaining)`);
        await new Promise<void>((resolve) => setTimeout(resolve, THUMB_BATCH_DELAY_MS));
        lastReport = await generateThumbnailsBatch(THUMB_BATCH_SIZE);
        setThumbDone((prev) => prev + lastReport.processed);
      }
      setThumbReport(lastReport);
      setThumbStatus("");
    } catch (e) {
      setThumbError(String(e));
      setThumbStatus("");
    } finally {
      setThumbRunning(false);
    }
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    setReport(null);
    setError(null);

    const files = Array.from(e.dataTransfer?.files || []) as TauriFile[];
    if (files.length === 0) return;

    const first = files[0];
    if (first.path && typeof first.path === "string") {
      const dirPath = first.path.replace(/\/[^/]*$/, "").replace(/\\/g, "/");
      setDir(dirPath);
      void handleScan(dirPath);
    } else {
      setDir(first.name || "");
      void handleScan(first.name || "");
    }
  }

  const thumbPercent =
    thumbTotal > 0 ? Math.round((thumbDone / thumbTotal) * 100) : 0;

  return (
    <div
      className={`scan-panel${dragging ? " scan-panel--dragging" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <h2>Scan a directory</h2>
      <p className="scan-hint">
        Enter the absolute path to a folder containing images, choose a folder,
        or drag & drop a folder or file here. PhotoMap will walk it recursively
        and index every JPEG, PNG, TIFF, HEIC, HEIF, and WebP file it finds.
      </p>

      <div className="scan-input-row">
        <input
          className="scan-path-input"
          type="text"
          placeholder="/home/user/Pictures"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleScan()}
          disabled={scanning}
          aria-label="Directory path"
        />
        <button
          className="scan-button"
          onClick={() => handleScan()}
          disabled={scanning || !dir.trim()}
        >
          {scanning ? "Scanning…" : "Scan"}
        </button>
        <button
          className="scan-choose-button"
          onClick={chooseDirectory}
          disabled={scanning}
          aria-label="Choose directory"
        >
          Choose…
        </button>
      </div>

      {/* ── Recently scanned directories ── */}
      {recentDirs.length > 0 && (
        <div className="recent-dirs">
          <h3 className="recent-dirs-title">Recently scanned</h3>
          <ul className="recent-dirs-list">
            {recentDirs.map((d) => (
              <li key={d}>
                <button
                  className="recent-dir-btn"
                  onClick={() => { setDir(d); void handleScan(d); }}
                  disabled={scanning}
                  title={d}
                >
                  📁 {d}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="scan-error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      {report && (
        <div className="scan-report">
          <h3>Scan complete</h3>
          <div className="report-grid">
            <ReportStat label="Added" value={report.added} colour="green" />
            <ReportStat label="Updated" value={report.updated} colour="blue" />
            <ReportStat label="Removed" value={report.removed} colour="orange" />
            <ReportStat label="Unchanged" value={report.unchanged} colour="gray" />
            <ReportStat
              label="Errors"
              value={report.errors.length}
              colour={report.errors.length > 0 ? "red" : "gray"}
            />
          </div>

          {report.errors.length > 0 && (
            <details className="scan-errors-details">
              <summary>
                {report.errors.length} file
                {report.errors.length !== 1 ? "s" : ""} could not be processed
              </summary>
              <ul className="scan-errors-list">
                {report.errors.map((err, i) => (
                  <li key={i}>
                    <code>{err.file_path}</code>
                    <span className="scan-error-msg">{err.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* ── Thumbnail generation ── */}
      <div className="thumb-section">
        <h2>Generate thumbnails</h2>
        <p className="scan-hint">
          Generate JPEG previews for all indexed photos that don't have one yet.
          Thumbnails are stored in the application data folder and displayed in
          the Library, Map, and Trips views.
        </p>

        <button
          className="scan-button"
          onClick={handleGenerateThumbnails}
          disabled={thumbRunning}
        >
          {thumbRunning ? "Generating…" : "Generate thumbnails"}
        </button>

        {thumbRunning && (
          <div className="thumb-progress">
            <div
              className="thumb-progress-bar"
              style={{ width: thumbTotal > 0 ? `${thumbPercent}%` : "0%" }}
            />
            <span className="thumb-progress-label">
              {thumbTotal > 0
                ? `${thumbDone} / ${thumbTotal} (${thumbPercent}%) — ${thumbStatus}`
                : thumbStatus}
            </span>
          </div>
        )}

        {thumbError && (
          <div className="scan-error" role="alert">
            <strong>Error:</strong> {thumbError}
          </div>
        )}

        {!thumbRunning && thumbReport && (
          <div className="scan-report">
            <h3>Done</h3>
            <div className="report-grid">
              <ReportStat
                label="Generated"
                value={thumbDone}
                colour="green"
              />
              <ReportStat
                label="Errors"
                value={thumbReport.errors.length}
                colour={thumbReport.errors.length > 0 ? "red" : "gray"}
              />
              {thumbReport.needs_review_count > 0 && (
                <ReportStat
                  label="Needs review"
                  value={thumbReport.needs_review_count}
                  colour="orange"
                />
              )}
            </div>
            {thumbReport.needs_review_count > 0 && (
              <p className="scan-hint">
                ⚠️ {thumbReport.needs_review_count} photo
                {thumbReport.needs_review_count !== 1 ? "s" : ""} failed too
                many times and have been flagged for review. Check the Library
                tab for photos marked with ⚠️.
              </p>
            )}
            {thumbReport.errors.length > 0 && (
              <details className="scan-errors-details">
                <summary>
                  {thumbReport.errors.length} file
                  {thumbReport.errors.length !== 1 ? "s" : ""} failed
                </summary>
                <ul className="scan-errors-list">
                  {thumbReport.errors.map((err, i) => (
                    <li key={i}>
                      <code>{err.file_path}</code>
                      <span className="scan-error-msg">
                        {err.message}
                        {err.needs_review && (
                          <span className="scan-needs-review-badge"> ⚠️ flagged for review</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReportStat({
  label,
  value,
  colour,
}: {
  label: string;
  value: number;
  colour: string;
}) {
  return (
    <div className="report-stat">
      <span className="report-stat-value" style={{ color: colour }}>
        {value}
      </span>
      <span className="report-stat-label">{label}</span>
    </div>
  );
}

