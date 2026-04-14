# PhotoMap

A cross-platform desktop application for managing and exploring your photo library by **location** and **date**.  Built with [Tauri 2](https://tauri.app), [React](https://react.dev), and [Rust](https://www.rust-lang.org).

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Running in development](#running-in-development)
- [Using the app](#using-the-app)
- [Building for production](#building-for-production)
- [Running tests](#running-tests)
- [Architecture notes](#architecture-notes)

---

## Features

- **Library browser** — paginated photo grid showing all indexed photos with name, date, and GPS badge; filter by date range.
- **Directory scanner** — recursively indexes a folder of photos, extracting EXIF timestamps and GPS coordinates via SHA-256 content hashing for fast incremental re-scans; displays an add/update/remove/error summary.
- **Time-range queries** — retrieve photos by date range, paginated and ordered by timestamp.
- **Bounding-box queries** — retrieve geotagged photos by map viewport (WGS-84 lat/lon bounding box).
- **Local SQLite database** — no cloud account required; all data stays on your machine.

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) |
| Frontend | [React 18](https://react.dev) + [TypeScript 5](https://www.typescriptlang.org) |
| Frontend bundler | [Vite 5](https://vitejs.dev) |
| Backend (core library) | Rust 2021 — `photomap-core` crate |
| Backend (app crate) | Rust 2021 — `src-tauri` crate |
| Database | [SQLite](https://www.sqlite.org) via [`rusqlite`](https://crates.io/crates/rusqlite) (bundled) |
| EXIF parsing | [`kamadak-exif`](https://crates.io/crates/kamadak-exif) |
| File hashing | [`sha2`](https://crates.io/crates/sha2) (SHA-256) |
| Directory traversal | [`walkdir`](https://crates.io/crates/walkdir) |

---

## Project structure

```
PhotoMap/
├── src/                      # React + TypeScript frontend
│   ├── api/
│   │   ├── photos.ts         # Typed wrappers for every Tauri command
│   │   └── types.ts          # TypeScript interfaces mirroring Rust structs
│   ├── components/
│   │   ├── FilterBar.tsx     # Date-range filter UI
│   │   ├── PhotoCard.tsx     # Single photo metadata card
│   │   ├── PhotoGrid.tsx     # Paginated photo grid with filter wiring
│   │   └── ScanPanel.tsx     # Directory scanner form + report display
│   ├── App.tsx               # Root component: tab navigation (Library | Scan)
│   └── main.tsx
├── src-tauri/                # Tauri application crate
│   ├── src/
│   │   ├── commands.rs       # #[tauri::command] handlers
│   │   ├── db/               # Re-exports core DB helpers
│   │   └── lib.rs            # App setup, DB initialisation, command registration
│   └── tauri.conf.json
├── photomap-core/            # Pure Rust library (no Tauri dependency)
│   └── src/
│       ├── db/
│       │   ├── mod.rs        # Re-exports all public DB symbols
│       │   ├── photos.rs     # SQL queries, upserts, migrations
│       │   └── schema.rs     # DDL as string constants
│       ├── scanner.rs        # Background scanner (SHA-256, EXIF, DB sync)
│       └── lib.rs
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── Cargo.toml                # Cargo workspace root
```

---

## Prerequisites

| Tool | Minimum version | Install |
|---|---|---|
| [Node.js](https://nodejs.org) | 18 LTS | [nodejs.org](https://nodejs.org/en/download) |
| [Rust](https://www.rust-lang.org) | 1.77 (stable) | `curl https://sh.rustup.rs -sSf \| sh` |
| [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) | — | See platform-specific guide |

On **Linux** you will also need a WebKit2GTK dev package (e.g. `libwebkit2gtk-4.1-dev` on Ubuntu/Debian). On **macOS** and **Windows** the system WebView is used and no extra packages are needed.

---

## Getting started

```bash
# Clone the repository
git clone https://github.com/jiashuwang459/PhotoMap.git
cd PhotoMap

# Install JavaScript dependencies
npm install
```

---

## Running in development

```bash
npm run tauri dev
```

This command:
1. Starts the Vite dev server on `http://localhost:1420` with hot-module replacement.
2. Compiles the Rust backend in debug mode.
3. Opens the application window.

The Rust backend recompiles automatically when you save Rust files.  Frontend changes are reflected instantly via HMR.

---

## Using the app

The application has two tabs accessible from the header navigation:

| Tab | Purpose |
|---|---|
| **Library** | Browse all indexed photos in a paginated grid. Use the date-range filter to narrow results. |
| **Scan** | Enter an absolute directory path and click **Scan** to index images. A summary shows how many files were added, updated, removed, or skipped. |

**Typical first-run workflow:**
1. Open the **Scan** tab.
2. Paste the absolute path to your photo folder (e.g. `/home/alice/Pictures`).
3. Click **Scan** and wait for the report.
4. Switch to **Library** to browse your indexed photos.

---

## Building for production

```bash
npm run tauri build
```

Produces a platform-native installer (`.dmg` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.AppImage` on Linux) in `src-tauri/target/release/bundle/`.

---

## Running tests

### Rust unit tests

The core library has a comprehensive unit-test suite that runs without a Tauri runtime or a real filesystem (uses in-memory SQLite and `tempfile`):

```bash
cargo test -p photomap-core
```

Tests cover:
- Database migrations (idempotency)
- Photo upsert and update
- Time-range, bounding-box, and `query_all_photos` queries
- Pagination and limit capping
- `file_hash` storage and change detection
- SHA-256 hashing (determinism, known empty-file digest)
- EXIF datetime parsing (valid dates, edge cases, invalid input)
- Image extension detection
- Scanner: add, update, unchanged, remove, recursive subdirectory, and error cases

### TypeScript type-check

```bash
npm run build
```

This runs `tsc` in strict mode before the Vite build, catching any type errors across the frontend.

---

## Architecture notes

### Two-crate Rust layout

- **`photomap-core`** is a pure Rust library with no Tauri dependency. All SQL, file scanning, and EXIF logic lives here. This makes it fast to test with a plain `cargo test`.
- **`src-tauri`** is the Tauri application crate. It only contains command handlers that accept managed state (`DbState`) and delegate to `photomap-core`.

### Database

- SQLite is used in WAL mode with a ~16 MB page cache for read-heavy workloads.
- All migrations are idempotent (`CREATE … IF NOT EXISTS` + `PRAGMA table_info`-guarded `ALTER TABLE`).
- Incremental scans are efficient: unchanged files are detected by comparing the stored SHA-256 hash and skipped without re-reading EXIF data.

### Scanner

The background scanner (`photomap-core::scanner::scan_directory`) performs two passes:

1. **Walk** — for every image file on disk, compute its SHA-256. If the hash matches the stored value, skip it; otherwise read EXIF and upsert the record.
2. **Prune** — query all DB records whose `file_path` starts with the scanned directory and remove any whose file no longer exists on disk.

Supported image extensions: `.jpg`, `.jpeg`, `.png`, `.tiff`, `.tif`, `.heic`, `.heif`, `.webp`.
