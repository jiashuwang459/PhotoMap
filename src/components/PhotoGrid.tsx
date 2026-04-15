import { useEffect, useState, useCallback } from "react";
import { queryAllPhotos, queryByTimeRange } from "../api/photos";
import type { Page, Photo } from "../api/types";
import { PhotoCard } from "./PhotoCard";
import { PhotoViewer } from "./PhotoViewer";
import type { FilterState } from "./FilterBar";
import { FilterBar } from "./FilterBar";

const PAGE_SIZE = 50;

/** Convert a local YYYY-MM-DD date string to a Unix epoch (seconds) at UTC midnight. */
function dateToTs(dateStr: string, endOfDay = false): number {
  const d = new Date(dateStr + (endOfDay ? "T23:59:59Z" : "T00:00:00Z"));
  return Math.floor(d.getTime() / 1000);
}

export function PhotoGrid() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  const [filter, setFilter] = useState<FilterState>({
    mode: "all",
    fromDate: "",
    toDate: "",
  });

  /** Fetch a page of photos according to the current filter. */
  const fetchPage = useCallback(
    async (currentOffset: number, reset: boolean) => {
      setLoading(true);
      setError(null);
      const page: Page = { limit: PAGE_SIZE, offset: currentOffset };
      try {
        let results: Photo[];
        if (filter.mode === "date" && filter.fromDate && filter.toDate) {
          results = await queryByTimeRange(
            dateToTs(filter.fromDate, false),
            dateToTs(filter.toDate, true),
            page
          );
        } else {
          results = await queryAllPhotos(page);
        }

        setPhotos((prev) => (reset ? results : [...prev, ...results]));
        setHasMore(results.length === PAGE_SIZE);
        setOffset(currentOffset + results.length);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [filter]
  );

  /** Load the first page on mount and whenever the filter is applied. */
  useEffect(() => {
    void fetchPage(0, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleApply() {
    void fetchPage(0, true);
  }

  function handleLoadMore() {
    void fetchPage(offset, false);
  }

  /** When a thumbnail is generated from the viewer, update the cached photo. */
  function handleThumbnailGenerated(updated: Photo) {
    setPhotos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setSelectedPhoto(updated);
  }

  return (
    <div className="photo-grid-container">
      <FilterBar filter={filter} onChange={setFilter} onApply={handleApply} />

      {error && (
        <div className="grid-error" role="alert">
          {error}
        </div>
      )}

      {!loading && photos.length === 0 && !error && (
        <div className="grid-empty">
          <p>No photos found.</p>
          <p>
            Switch to the <strong>Scan</strong> tab to index a folder.
          </p>
        </div>
      )}

      <div className="photo-grid">
        {photos.map((p) => (
          <PhotoCard key={p.id} photo={p} onClick={setSelectedPhoto} />
        ))}
      </div>

      {loading && <div className="grid-loading">Loading…</div>}

      {hasMore && !loading && (
        <button className="load-more-button" onClick={handleLoadMore}>
          Load more
        </button>
      )}

      {selectedPhoto && (
        <PhotoViewer
          photo={selectedPhoto}
          onClose={() => setSelectedPhoto(null)}
          onThumbnailGenerated={handleThumbnailGenerated}
        />
      )}
    </div>
  );
}
