import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { scanDirectory } from "../api/photos";
import type { ScanReport } from "../api/types";
import { homeDir } from '@tauri-apps/api/path';
import { useThumbnailWorker } from "../context/ThumbnailWorkerContext";

/** Tauri extends the standard File with a native `path` property. */
interface TauriFile extends File {
  path?: string;
}

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

  // Thumbnail generation is handled by the global background worker.
  const { isRunning: thumbRunning, done: thumbDone, total: thumbTotal, status: thumbStatus, start: startThumbnails, cancel: cancelThumbnails } = useThumbnailWorker();

  const thumbPercent = thumbTotal > 0 ? Math.round((thumbDone / thumbTotal) * 100) : 0;

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
          Thumbnails continue generating in the background even when you switch
          tabs — use the progress bar in the header to monitor or cancel.
        </p>

        <div className="scan-input-row">
          <button
            className="scan-button"
            onClick={startThumbnails}
            disabled={thumbRunning}
          >
            {thumbRunning ? "Generating…" : "Generate thumbnails"}
          </button>
          {thumbRunning && (
            <button
              className="scan-choose-button"
              onClick={cancelThumbnails}
            >
              Cancel
            </button>
          )}
        </div>

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

        {!thumbRunning && thumbDone > 0 && (
          <div className="scan-report">
            <h3>Done</h3>
            <div className="report-grid">
              <ReportStat label="Generated" value={thumbDone} colour="green" />
            </div>
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

