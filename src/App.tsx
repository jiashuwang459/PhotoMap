import { useState } from "react";
import { PhotoGrid } from "./components/PhotoGrid";
import { ScanPanel } from "./components/ScanPanel";
import { MapView } from "./components/MapView";
import { TripsPanel } from "./components/TripsPanel";
import { ThumbnailWorkerProvider, useThumbnailWorker } from "./context/ThumbnailWorkerContext";
import "./App.css";

type Tab = "library" | "map" | "trips" | "scan";

// ── Thumbnail progress mini-bar shown in the nav when worker is active ────────

function ThumbnailProgressBadge() {
  const { isRunning, done, total, status, cancel } = useThumbnailWorker();
  if (!isRunning) return null;

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="thumb-badge" role="status">
      <div className="thumb-badge-bar">
        <div className="thumb-badge-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="thumb-badge-label">
        {total > 0 ? `Thumbnails ${pct}%` : status}
      </span>
      <button
        className="thumb-badge-cancel"
        onClick={cancel}
        title="Cancel thumbnail generation"
        aria-label="Cancel thumbnail generation"
      >
        ✕
      </button>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────

function AppShell() {
  const [tab, setTab] = useState<Tab>("library");
  const [tripsVersion, setTripsVersion] = useState(0);

  function handleTripsChanged() {
    setTripsVersion((v) => v + 1);
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo">📷</span>
        <h1 className="app-title">PhotoMap</h1>
        <nav className="app-nav">
          <button
            className={`nav-tab${tab === "library" ? " nav-tab--active" : ""}`}
            onClick={() => setTab("library")}
          >
            Library
          </button>
          <button
            className={`nav-tab${tab === "map" ? " nav-tab--active" : ""}`}
            onClick={() => setTab("map")}
          >
            Map
          </button>
          <button
            className={`nav-tab${tab === "trips" ? " nav-tab--active" : ""}`}
            onClick={() => setTab("trips")}
          >
            Trips
          </button>
          <button
            className={`nav-tab${tab === "scan" ? " nav-tab--active" : ""}`}
            onClick={() => setTab("scan")}
          >
            Scan
          </button>
        </nav>
        <ThumbnailProgressBadge />
      </header>

      {/*
        Keep ALL tab panels mounted at all times so that background thumbnail
        generation continues even while the user browses other tabs.
        Each panel is hidden via CSS when its tab is not active.
      */}
      <main className={`app-content${tab === "map" ? " app-content--map" : ""}`}>
        <div className={tab === "library" ? "" : "tab-hidden"}>
          <PhotoGrid />
        </div>
        <div className={tab === "map" ? "tab-map-active" : "tab-hidden"}>
          <MapView isActive={tab === "map"} tripsVersion={tripsVersion} />
        </div>
        <div className={tab === "trips" ? "" : "tab-hidden"}>
          <TripsPanel onTripsChanged={handleTripsChanged} />
        </div>
        <div className={tab === "scan" ? "" : "tab-hidden"}>
          <ScanPanel />
        </div>
      </main>
    </div>
  );
}

function App() {
  return (
    <ThumbnailWorkerProvider>
      <AppShell />
    </ThumbnailWorkerProvider>
  );
}

export default App;
