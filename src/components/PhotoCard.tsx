import { convertFileSrc } from "@tauri-apps/api/core";
import type { Photo } from "../api/types";

/** Format a Unix epoch (seconds) as a human-readable local date string. */
function formatDate(ts: number | null): string {
  if (ts === null) return "No date";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
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
}

export function PhotoCard({ photo }: PhotoCardProps) {
  const gps = formatGps(photo.latitude, photo.longitude);

  return (
    <div className="photo-card" title={photo.file_path}>
      <div className="photo-card-thumb" aria-hidden="true">
        {photo.thumbnail_path ? (
          <img
            className="photo-card-thumb-img"
            src={convertFileSrc(photo.thumbnail_path)}
            alt=""
            loading="lazy"
          />
        ) : (
          <span className="photo-card-thumb-icon">🖼</span>
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
