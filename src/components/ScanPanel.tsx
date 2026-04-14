import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { scanDirectory, generateThumbnailsBatch } from "../api/photos";
import type { ScanReport, ThumbnailBatchReport } from "../api/types";
import { homeDir } from '@tauri-apps/api/path';

/** Tauri extends the standard File with a native `path` property. */
interface TauriFile extends File {
  path?: string;
}

const THUMB_BATCH_SIZE = 20;

export function ScanPanel() {
  const [dir, setDir] = useState("");
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Thumbnail generation state
  const [thumbRunning, setThumbRunning] = useState(false);
  const [thumbReport, setThumbReport] = useState<ThumbnailBatchReport | null>(null);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const [thumbTotal, setThumbTotal] = useState(0);
  const [thumbDone, setThumbDone] = useState(0);

  async function handleScan(path?: string) {
    const trimmed = (path ?? dir).trim();
    if (!trimmed) return;
    setScanning(true);
    setReport(null);
    setError(null);
    try {
      const result = await scanDirectory(trimmed);
      setReport(result);
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

    try {
      // First call gives us the initial "remaining" to show overall progress.
      let lastReport = await generateThumbnailsBatch(THUMB_BATCH_SIZE);
      const initial = lastReport.processed + lastReport.remaining;
      setThumbTotal(initial);
      setThumbDone(lastReport.processed);

      // Keep batching until nothing is left.
      while (lastReport.remaining > 0) {
        lastReport = await generateThumbnailsBatch(THUMB_BATCH_SIZE);
        setThumbDone((prev) => prev + lastReport.processed);
      }
      setThumbReport(lastReport);
    } catch (e) {
      setThumbError(String(e));
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

        {thumbRunning && thumbTotal > 0 && (
          <div className="thumb-progress">
            <div
              className="thumb-progress-bar"
              style={{ width: `${thumbPercent}%` }}
            />
            <span className="thumb-progress-label">
              {thumbDone} / {thumbTotal} ({thumbPercent}%)
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
            </div>
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
                      <span className="scan-error-msg">{err.message}</span>
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

