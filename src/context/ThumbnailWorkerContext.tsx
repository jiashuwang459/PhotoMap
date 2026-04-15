/**
 * Global background thumbnail-generation worker.
 *
 * Wrapping the app in `<ThumbnailWorkerProvider>` gives any component access
 * to the thumbnail-generation loop via `useThumbnailWorker()`.  The loop runs
 * independently of which tab is currently visible: switching tabs does NOT
 * pause or cancel it.
 *
 * ## Usage
 * ```tsx
 * const { isRunning, done, total, status, start, cancel } = useThumbnailWorker();
 * ```
 *
 * - `start()` — begin (or resume) generating thumbnails in the background.
 * - `cancel()` — request cancellation; the loop stops after the current batch.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { generateThumbnailsBatch } from "../api/photos";

/** Number of photos to decode per backend call. Small = less CPU spike per tick. */
const BATCH_SIZE = 5;
/** Milliseconds to yield between batches so the UI thread can repaint. */
const BATCH_DELAY_MS = 200;

// ── Context value shape ───────────────────────────────────────────────────────

export interface ThumbnailWorkerState {
  isRunning: boolean;
  done: number;
  total: number;
  /** Short human-readable status message (empty when idle). */
  status: string;
  /** Start (or restart) the generation loop. */
  start: () => void;
  /** Request cancellation of the running loop. */
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

  /**
   * When set to `true` by `cancel()`, the next iteration of the async loop
   * will exit without scheduling another batch.
   */
  const cancelRef = useRef(false);

  const start = useCallback(() => {
    // Prevent double-starting.
    if (isRunning) return;
    cancelRef.current = false;
    setIsRunning(true);
    setDone(0);
    setTotal(0);
    setStatus("Starting…");

    void (async () => {
      try {
        let lastReport = await generateThumbnailsBatch(BATCH_SIZE);
        const initial = lastReport.processed + lastReport.remaining;
        setTotal(initial);
        setDone(lastReport.processed);

        while (lastReport.remaining > 0 && !cancelRef.current) {
          setStatus(`Processing… (${lastReport.remaining} remaining)`);
          await new Promise<void>((resolve) =>
            setTimeout(resolve, BATCH_DELAY_MS)
          );
          if (cancelRef.current) break;
          lastReport = await generateThumbnailsBatch(BATCH_SIZE);
          setDone((prev) => prev + lastReport.processed);
        }
      } catch {
        setStatus("Error during thumbnail generation");
      } finally {
        setStatus(cancelRef.current ? "Cancelled" : "Done");
        setIsRunning(false);
      }
    })();
  }, [isRunning]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  return (
    <ThumbnailWorkerContext.Provider
      value={{ isRunning, done, total, status, start, cancel }}
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
