import { useState } from "react";
import { PhotoGrid } from "./components/PhotoGrid";
import { ScanPanel } from "./components/ScanPanel";
import "./App.css";

type Tab = "library" | "scan";

function App() {
  const [tab, setTab] = useState<Tab>("library");

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
            className={`nav-tab${tab === "scan" ? " nav-tab--active" : ""}`}
            onClick={() => setTab("scan")}
          >
            Scan
          </button>
        </nav>
      </header>

      <main className="app-content">
        {tab === "library" ? <PhotoGrid /> : <ScanPanel />}
      </main>
    </div>
  );
}

export default App;
