import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { generateThumbnailForPhoto } from "../api/photos";
import type { Photo } from "../api/types";

// ── helpers ───────────────────────────────────────────────────────────────────

function formatDate(ts: number | null): string {
  if (ts === null) return "No date";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
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
  /** Called with the updated photo after a thumbnail is successfully generated. */
  onThumbnailGenerated: (updatedPhoto: Photo) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Full-screen modal for viewing the original image and its metadata.
 *
 * - Shows the original file via Tauri's asset-protocol (`convertFileSrc`).
 * - If no thumbnail exists yet, shows a "Generate thumbnail" button.
 * - If the photo is flagged for review (needs_review), shows a "Retry thumbnail"
 *   button that re-attempts generation ignoring retry limits.
 */
export function PhotoViewer({
  photo,
  onClose,
  onThumbnailGenerated,
}: PhotoViewerProps) {
  const [generatingThumb, setGeneratingThumb] = useState(false);
  const [thumbError, setThumbError] = useState<string | null>(null);

  // Close on backdrop click (not on content click).
  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  async function handleGenerateThumbnail() {
    setGeneratingThumb(true);
    setThumbError(null);
    try {
      const newPath = await generateThumbnailForPhoto(photo.id);
      onThumbnailGenerated({
        ...photo,
        thumbnail_path: newPath,
        thumbnail_needs_review: false,
        thumbnail_retry_count: 0,
      });
    } catch (e) {
      setThumbError(String(e));
    } finally {
      setGeneratingThumb(false);
    }
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
                  ⚠️ Failed after retries
                </span>
              ) : (
                "Not generated"
              )}
            </span>
          </div>
        </div>

        {/* ── Thumbnail actions ── */}
        {(!hasThumbnail || needsReview) && (
          <div className="photo-viewer-actions">
            <button
              className="btn-primary"
              onClick={handleGenerateThumbnail}
              disabled={generatingThumb}
            >
              {generatingThumb
                ? "Generating…"
                : needsReview
                ? "Retry thumbnail"
                : "Generate thumbnail"}
            </button>
            {thumbError && (
              <span className="photo-viewer-error" role="alert">
                {thumbError}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
