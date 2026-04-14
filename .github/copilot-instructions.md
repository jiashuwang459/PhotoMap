# GitHub Copilot Instructions — PhotoMap

## Project overview

PhotoMap is a cross-platform desktop application for managing and exploring photos by location and date. It is built with:

- **Tauri 2** — native shell, system APIs, and IPC bridge
- **React 18 + TypeScript** — frontend UI (bundled by Vite 5)
- **Rust (2021 edition)** — backend logic split across two crates:
  - `photomap-core` — pure library: SQLite DB layer, file scanner, EXIF parsing
  - `src-tauri` (crate name `photomap`) — Tauri application shell and command handlers
- **SQLite** (via `rusqlite` with the bundled feature) — local database; no server required

## Repository layout

```
PhotoMap/
├── src/                      # React + TypeScript frontend
│   ├── api/
│   │   ├── photos.ts         # Typed wrappers for every Tauri command
│   │   └── types.ts          # Shared TypeScript interfaces (mirrors Rust structs)
│   ├── components/
│   │   ├── FilterBar.tsx     # Date-range filter UI
│   │   ├── MapView.tsx       # Interactive Leaflet map tab
│   │   ├── PhotoCard.tsx     # Single photo metadata card
│   │   ├── PhotoGrid.tsx     # Paginated photo grid with filter wiring
│   │   └── ScanPanel.tsx     # Directory scanner form + report display
│   ├── App.tsx               # Root component: tab navigation (Library | Map | Scan)
│   └── main.tsx
├── src-tauri/                # Tauri application crate
│   ├── src/
│   │   ├── commands.rs       # #[tauri::command] handlers
│   │   ├── db/               # Re-exports core DB types into the Tauri crate
│   │   └── lib.rs            # App setup: DB open, state management, command registration
│   └── tauri.conf.json
├── photomap-core/            # Pure Rust library crate (no Tauri dependency)
│   └── src/
│       ├── db/
│       │   ├── mod.rs        # Re-exports all public DB symbols
│       │   ├── photos.rs     # All SQL queries and DB helpers
│       │   └── schema.rs     # DDL migrations as string constants
│       ├── scanner.rs        # Background file scanner (SHA-256, EXIF, DB sync)
│       └── lib.rs            # Public re-exports
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── Cargo.toml                # Workspace root
```

## Coding conventions

### Rust

- All public APIs must have doc comments (`///`).
- Error types implement `thiserror::Error` and `serde::Serialize` (so Tauri can forward them to the frontend as JSON strings).
- Database functions live in `photomap-core` and accept a `&rusqlite::Connection` directly — they never open their own connection.
- `photomap-core` must not depend on Tauri; keep it a pure Rust library so it can be unit-tested without a running app.
- Use `prepare_cached` for every SQL statement that will be called repeatedly.
- New DB columns must be introduced with an `add_column_if_missing` migration (not `IF NOT EXISTS` on `ALTER TABLE`, which requires SQLite ≥ 3.37).
- All `SELECT` queries must be paginated via the shared `Page` type (max 500 rows).

### TypeScript / React

- All Tauri commands must have a corresponding typed wrapper in `src/api/photos.ts`.
- Types in `src/api/types.ts` must exactly mirror the Rust structs serialised by Tauri (snake_case field names, `number | null` for `Option<f64>`/`Option<i64>`, etc.).
- No raw `invoke` calls outside of `src/api/`.
- Use `strict` TypeScript — no `any`, no unused variables.

## Adding a new Tauri command

1. Add the business logic to `photomap-core/src/` (DB function or domain logic).
2. Re-export it from `photomap-core/src/lib.rs`.
3. Add a `#[tauri::command]` fn in `src-tauri/src/commands.rs`.
4. Register it in the `invoke_handler!` macro inside `src-tauri/src/lib.rs`.
5. Add a typed wrapper function in `src/api/photos.ts`.
6. Add / update the relevant TypeScript interface in `src/api/types.ts`.

## Keeping documentation current

Whenever you add, remove, or change any of the following, update **both**
`.github/copilot-instructions.md` and `README.md` in the same commit:

- A new Tauri command or API wrapper
- A new `photomap-core` public function or type
- A change to the repository layout (new files / directories)
- A change to the build, run, or test commands
- A new runtime dependency (Rust crate or npm package)

Small fixes (typos, phrasing) only need the affected document updated.

## Running tests

```bash
# Rust unit tests (fast, no Tauri runtime needed)
cargo test -p photomap-core

# TypeScript type-check
npm run build
```

## Building and running the app

See `README.md` for full setup and run instructions.
