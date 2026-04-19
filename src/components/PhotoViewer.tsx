import { convertFileSrc } from "@tauri-apps/api/core";
import type { Photo } from "../api/types";

// ── helpers ───────────────────────────────────────────────────────────────────

function formatDate(ts: number | null): string {
  if (ts === null) return "No date";
  // Timestamps are stored as "camera local time treated as UTC", so display
  // in UTC to recover the original camera clock reading.
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatGps(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return "";
  return `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface PhotoViewerProps {
  photo: Photo;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Full-screen modal for viewing the original image and its metadata.
 *
 * Thumbnail generation is handled exclusively by the background worker
 * (started from the Scan tab).  This viewer is read-only.
 */
export function PhotoViewer({
  photo,
  onClose,
}: PhotoViewerProps) {
  // Close on backdrop click (not on content click).
  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  const gps = formatGps(photo.latitude, photo.longitude);
  const hasThumbnail = Boolean(photo.thumbnail_path);
  const needsReview = photo.thumbnail_needs_review;

  return (
    <div
      className="photo-viewer-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={basename(photo.file_path)}
    >
      <div className="photo-viewer">
        {/* ── Header ── */}
        <div className="photo-viewer-header">
          <span className="photo-viewer-title">{basename(photo.file_path)}</span>
          <button
            className="photo-viewer-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* ── Image ── */}
        <div className="photo-viewer-image-wrap">
          <img
            src={convertFileSrc(photo.file_path)}
            alt={basename(photo.file_path)}
            className="photo-viewer-image"
          />
        </div>

        {/* ── Metadata ── */}
        <div className="photo-viewer-meta">
          <div className="photo-viewer-meta-row">
            <span className="photo-viewer-meta-label">Date</span>
            <span className="photo-viewer-meta-value">
              {formatDate(photo.timestamp)}
            </span>
          </div>
          {gps && (
            <div className="photo-viewer-meta-row">
              <span className="photo-viewer-meta-label">GPS</span>
              <span className="photo-viewer-meta-value">📍 {gps}</span>
            </div>
          )}
          <div className="photo-viewer-meta-row">
            <span className="photo-viewer-meta-label">Path</span>
            <span
              className="photo-viewer-meta-value photo-viewer-path"
              title={photo.file_path}
            >
              {photo.file_path}
            </span>
          </div>
          <div className="photo-viewer-meta-row">
            <span className="photo-viewer-meta-label">Thumbnail</span>
            <span className="photo-viewer-meta-value">
              {hasThumbnail ? (
                "✓ Generated"
              ) : needsReview ? (
                <span className="photo-viewer-needs-review">
                  ⚠️ Failed after retries — use Generate thumbnails in Scan tab
                </span>
              ) : (
                "Not generated — use Generate thumbnails in Scan tab"
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
