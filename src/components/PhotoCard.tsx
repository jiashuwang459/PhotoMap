import { convertFileSrc } from "@tauri-apps/api/core";
import type { Photo } from "../api/types";

/** Format a Unix epoch (seconds) as a human-readable local date and time string. */
function formatDate(ts: number | null): string {
  if (ts === null) return "No date";
  // Timestamps are stored as "camera local time treated as UTC", so display
  // in UTC to recover the original camera clock reading.
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Format decimal degrees as a compact lat/lon string. */
function formatGps(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return "";
  return `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
}

/** Extract the file name from an absolute path. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

interface PhotoCardProps {
  photo: Photo;
  onClick?: (photo: Photo) => void;
}

export function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const gps = formatGps(photo.latitude, photo.longitude);

  return (
    <div
      className={`photo-card${onClick ? " photo-card--clickable" : ""}`}
      title={photo.file_path}
      onClick={onClick ? () => onClick(photo) : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick(photo);
            }
          : undefined
      }
    >
      <div className="photo-card-thumb" aria-hidden="true">
        {photo.thumbnail_path ? (
          <img
            className="photo-card-thumb-img"
            src={convertFileSrc(photo.thumbnail_path)}
            alt=""
            loading="lazy"
          />
        ) : (
          <span className="photo-card-thumb-icon">
            {photo.thumbnail_needs_review ? "⚠️" : "🖼"}
          </span>
        )}
      </div>
      <div className="photo-card-body">
        <span className="photo-card-name">{basename(photo.file_path)}</span>
        <span className="photo-card-date">{formatDate(photo.timestamp)}</span>
        {gps && <span className="photo-card-gps">📍 {gps}</span>}
        <span className="photo-card-path">{photo.file_path}</span>
      </div>
    </div>
  );
}
