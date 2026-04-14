import { useState } from "react";
import { scanDirectory } from "../api/photos";
import type { ScanReport } from "../api/types";

export function ScanPanel() {
  const [dir, setDir] = useState("");
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScan() {
    const trimmed = dir.trim();
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

  return (
    <div className="scan-panel">
      <h2>Scan a directory</h2>
      <p className="scan-hint">
        Enter the absolute path to a folder containing images. PhotoMap will
        walk it recursively and index every JPEG, PNG, TIFF, HEIC, HEIF, and
        WebP file it finds.
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
          onClick={handleScan}
          disabled={scanning || !dir.trim()}
        >
          {scanning ? "Scanning…" : "Scan"}
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
            <ReportStat
              label="Removed"
              value={report.removed}
              colour="orange"
            />
            <ReportStat
              label="Unchanged"
              value={report.unchanged}
              colour="gray"
            />
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
