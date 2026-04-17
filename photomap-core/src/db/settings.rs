//! Settings store, home-location inference, and move-event detection.
//!
//! # Settings table
//! A simple key–value store (`settings`) persists per-library configuration
//! (currently: `home_lat` and `home_lon`).
//!
//! # Home-location inference
//! `infer_home_location` bins all GPS-tagged photos into a coarse ~10 km grid
//! and returns the centroid of the most-populated cell — the user's "home base".
//! This baseline is used by [`crate::db::trips::auto_group_trips`] to distinguish
//! trip clusters (far from home or unusually dense) from everyday home snapshots.
//!
//! # Move-event detection
//! `detect_home_transitions` analyses the photo timeline with a rolling 90-day
//! window.  When consecutive windows show a dominant location shift of more than
//! 100 km that persists for at least 30 days, the event is recorded as an
//! unconfirmed [`HomeTransition`] for the user to review.

use rusqlite::{Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};

use super::photos::DbError;

// ── Domain types ──────────────────────────────────────────────────────────────

/// A home (base) location inferred from or set by the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeLocation {
    /// WGS-84 latitude in decimal degrees.
    pub lat: f64,
    /// WGS-84 longitude in decimal degrees.
    pub lon: f64,
}

/// A detected "move" event: the user's dominant GPS location shifted to a new
/// city or region.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeTransition {
    pub id: i64,
    /// Unix epoch seconds of the approximate transition date.
    pub transition_ts: i64,
    /// Previous home latitude; `None` for the very first home entry.
    pub old_lat: Option<f64>,
    /// Previous home longitude; `None` for the very first home entry.
    pub old_lon: Option<f64>,
    /// New home latitude after the move.
    pub new_lat: f64,
    /// New home longitude after the move.
    pub new_lon: f64,
    /// Whether the user has confirmed (accepted) this detected transition.
    pub is_confirmed: bool,
}

// ── Settings keys ─────────────────────────────────────────────────────────────

const KEY_HOME_LAT: &str = "home_lat";
const KEY_HOME_LON: &str = "home_lon";

// ── Home-location CRUD ────────────────────────────────────────────────────────

/// Read the stored home location from the `settings` table.
///
/// Returns `None` when no home location has been saved yet.
pub fn get_home_location(conn: &Connection) -> Result<Option<HomeLocation>, DbError> {
    let lat = get_setting(conn, KEY_HOME_LAT)?;
    let lon = get_setting(conn, KEY_HOME_LON)?;
    match (lat, lon) {
        (Some(lat_s), Some(lon_s)) => {
            if let (Ok(lat), Ok(lon)) = (lat_s.parse::<f64>(), lon_s.parse::<f64>()) {
                Ok(Some(HomeLocation { lat, lon }))
            } else {
                Ok(None)
            }
        }
        _ => Ok(None),
    }
}

/// Persist a home location to the `settings` table.
///
/// Overwrites any previously stored value.
pub fn set_home_location(conn: &Connection, lat: f64, lon: f64) -> Result<(), DbError> {
    set_setting(conn, KEY_HOME_LAT, &lat.to_string())?;
    set_setting(conn, KEY_HOME_LON, &lon.to_string())?;
    Ok(())
}

/// Compute the home location by binning all GPS-tagged photos into a coarse
/// ~10 km grid and returning the centroid of the most-populated cell.
///
/// Binning: `cell_key = (floor(lat × 9), floor(lon × 9))`, producing cells
/// roughly 11 km × (7–11 km) in the latitude range 0°–45°.  Photos without
/// GPS coordinates are ignored.
///
/// Returns `None` when the library contains fewer than 5 GPS-tagged photos
/// (insufficient data to infer a home reliably).
pub fn infer_home_location(conn: &Connection) -> Result<Option<HomeLocation>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT latitude, longitude FROM photos
         WHERE  latitude IS NOT NULL AND longitude IS NOT NULL",
    )?;

    struct GridCell {
        count: usize,
        lat_sum: f64,
        lon_sum: f64,
    }

    let mut grid: std::collections::HashMap<(i64, i64), GridCell> =
        std::collections::HashMap::new();
    let mut total = 0usize;

    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?))
    })?;

    for row in rows {
        let (lat, lon) = row?;
        total += 1;
        let cell_lat = (lat * 9.0).floor() as i64;
        let cell_lon = (lon * 9.0).floor() as i64;
        let entry = grid.entry((cell_lat, cell_lon)).or_insert(GridCell {
            count: 0,
            lat_sum: 0.0,
            lon_sum: 0.0,
        });
        entry.count += 1;
        entry.lat_sum += lat;
        entry.lon_sum += lon;
    }

    if total < 5 {
        return Ok(None);
    }

    let best = grid.values().max_by_key(|c| c.count);
    match best {
        Some(cell) => {
            let n = cell.count as f64;
            Ok(Some(HomeLocation {
                lat: cell.lat_sum / n,
                lon: cell.lon_sum / n,
            }))
        }
        None => Ok(None),
    }
}

/// Compute and persist the home location in one call.
///
/// Delegates to [`infer_home_location`] and, if a location is found, saves it
/// with [`set_home_location`].  Returns the inferred location or `None` when
/// the library has too few GPS-tagged photos.
pub fn infer_and_save_home_location(
    conn: &Connection,
) -> Result<Option<HomeLocation>, DbError> {
    let home = infer_home_location(conn)?;
    if let Some(ref h) = home {
        set_home_location(conn, h.lat, h.lon)?;
    }
    Ok(home)
}

// ── Home transitions ──────────────────────────────────────────────────────────

/// Return the effective home location for a given Unix timestamp.
///
/// Respects confirmed move events: if any confirmed transitions exist at or
/// before `at_ts`, the most recent one's `new_lat`/`new_lon` is returned.
/// Falls back to the settings-stored home if no qualifying transition exists.
///
/// Returns `None` if no home location can be determined.
pub fn home_at(conn: &Connection, at_ts: i64) -> Result<Option<HomeLocation>, DbError> {
    let result: rusqlite::Result<(f64, f64)> = conn.query_row(
        "SELECT new_lat, new_lon FROM home_transitions
         WHERE  is_confirmed = 1 AND transition_ts <= ?1
         ORDER  BY transition_ts DESC
         LIMIT  1",
        rusqlite::params![at_ts],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    match result {
        Ok((lat, lon)) => return Ok(Some(HomeLocation { lat, lon })),
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(e) => return Err(DbError::from(e)),
    }
    get_home_location(conn)
}

/// Return all home transitions ordered by `transition_ts` ascending.
pub fn list_home_transitions(conn: &Connection) -> Result<Vec<HomeTransition>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, transition_ts, old_lat, old_lon, new_lat, new_lon, is_confirmed
         FROM   home_transitions
         ORDER  BY transition_ts ASC",
    )?;
    let rows = stmt.query_map([], map_transition_row)?;
    rows.collect::<SqlResult<Vec<_>>>().map_err(DbError::from)
}

/// Mark a home transition as confirmed (user accepted the detected move).
///
/// Returns `true` if the transition was found and updated, `false` otherwise.
pub fn confirm_home_transition(conn: &Connection, id: i64) -> Result<bool, DbError> {
    let n = conn.execute(
        "UPDATE home_transitions SET is_confirmed = 1 WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(n > 0)
}

/// Insert a new confirmed home-transition record and return it.
///
/// Use this to manually record a "moved to" event.  The transition is
/// pre-confirmed (`is_confirmed = 1`) and is immediately honoured by
/// [`auto_group_trips`] when deciding what counts as an away trip.
/// `old_lat` / `old_lon` are stored as `NULL`; the prior location can be
/// inferred from earlier transitions when needed.
pub fn create_home_transition(
    conn: &Connection,
    transition_ts: i64,
    new_lat: f64,
    new_lon: f64,
) -> Result<HomeTransition, DbError> {
    let id: i64 = conn.query_row(
        "INSERT INTO home_transitions
             (transition_ts, old_lat, old_lon, new_lat, new_lon, is_confirmed)
         VALUES (?1, NULL, NULL, ?2, ?3, 1)
         RETURNING id",
        rusqlite::params![transition_ts, new_lat, new_lon],
        |row| row.get(0),
    )?;
    Ok(HomeTransition {
        id,
        transition_ts,
        old_lat: None,
        old_lon: None,
        new_lat,
        new_lon,
        is_confirmed: true,
    })
}

/// Delete a home transition (user rejected the detected move).
///
/// Returns `true` if the transition was found and deleted, `false` otherwise.
pub fn dismiss_home_transition(conn: &Connection, id: i64) -> Result<bool, DbError> {
    let n = conn.execute(
        "DELETE FROM home_transitions WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(n > 0)
}

/// Analyse the photo timeline for sustained changes in the dominant GPS
/// location and populate the `home_transitions` table with newly detected
/// (unconfirmed) move events.
///
/// # Algorithm
/// 1. Load all GPS-tagged, timestamped photos ordered by timestamp.
/// 2. Slide a 90-day window forward in 30-day increments.
/// 3. For each window find the most-populated ~10 km grid cell ("window home").
/// 4. When consecutive window homes are more than 100 km apart **and** the new
///    home dominates for at least 30 days, record a transition at the midpoint
///    between the two windows.
/// 5. All previously detected **unconfirmed** transitions are cleared and
///    re-detected; **confirmed** transitions are preserved.
///
/// Returns the full list of transitions (confirmed + newly detected) after the
/// update.
///
/// # Errors
/// Returns a [`DbError`] on any SQLite failure.
pub fn detect_home_transitions(conn: &Connection) -> Result<Vec<HomeTransition>, DbError> {
    const WINDOW_DAYS: i64 = 90;
    const STEP_DAYS: i64 = 30;
    const SHIFT_KM: f64 = 100.0;
    const MIN_PERSIST_DAYS: i64 = 30;
    const SECS_PER_DAY: i64 = 86_400;

    struct GpsPhoto {
        timestamp: i64,
        lat: f64,
        lon: f64,
    }

    let mut stmt = conn.prepare_cached(
        "SELECT timestamp, latitude, longitude FROM photos
         WHERE  timestamp IS NOT NULL
           AND  latitude  IS NOT NULL
           AND  longitude IS NOT NULL
         ORDER  BY timestamp ASC",
    )?;

    let photos: Vec<GpsPhoto> = stmt
        .query_map([], |row| {
            Ok(GpsPhoto {
                timestamp: row.get(0)?,
                lat: row.get(1)?,
                lon: row.get(2)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    if photos.len() < 10 {
        return list_home_transitions(conn);
    }

    let first_ts = photos.first().unwrap().timestamp;
    let last_ts = photos.last().unwrap().timestamp;
    let total_days = (last_ts - first_ts) / SECS_PER_DAY;

    if total_days < WINDOW_DAYS {
        return list_home_transitions(conn);
    }

    // ── Compute the dominant home cell for each rolling window ────────────────

    struct WindowHome {
        window_start: i64,
        lat: f64,
        lon: f64,
    }

    let mut window_homes: Vec<WindowHome> = Vec::new();
    let mut window_start = first_ts;

    while window_start + WINDOW_DAYS * SECS_PER_DAY <= last_ts {
        let window_end = window_start + WINDOW_DAYS * SECS_PER_DAY;

        // Collect photos inside this window.
        let mut cell_counts: std::collections::HashMap<(i64, i64), (usize, f64, f64)> =
            std::collections::HashMap::new();

        for p in &photos {
            if p.timestamp < window_start || p.timestamp >= window_end {
                continue;
            }
            let ck = (
                (p.lat * 9.0).floor() as i64,
                (p.lon * 9.0).floor() as i64,
            );
            let entry = cell_counts.entry(ck).or_insert((0, 0.0, 0.0));
            entry.0 += 1;
            entry.1 += p.lat;
            entry.2 += p.lon;
        }

        if cell_counts.len() >= 1 {
            // Find the most-populated cell.
            if let Some((_, (cnt, lat_sum, lon_sum))) =
                cell_counts.iter().max_by_key(|(_, v)| v.0)
            {
                let n = *cnt as f64;
                window_homes.push(WindowHome {
                    window_start,
                    lat: lat_sum / n,
                    lon: lon_sum / n,
                });
            }
        }

        window_start += STEP_DAYS * SECS_PER_DAY;
    }

    if window_homes.len() < 2 {
        return list_home_transitions(conn);
    }

    // ── Detect sustained shifts ───────────────────────────────────────────────

    // Clear previously detected unconfirmed transitions so we start fresh.
    conn.execute(
        "DELETE FROM home_transitions WHERE is_confirmed = 0",
        [],
    )?;

    let mut insert_stmt = conn.prepare_cached(
        "INSERT INTO home_transitions
             (transition_ts, old_lat, old_lon, new_lat, new_lon, is_confirmed)
         VALUES (?1, ?2, ?3, ?4, ?5, 0)",
    )?;

    let mut i = 0usize;
    while i + 1 < window_homes.len() {
        let prev = &window_homes[i];
        let next = &window_homes[i + 1];

        if haversine_km(prev.lat, prev.lon, next.lat, next.lon) > SHIFT_KM {
            // Verify the new location persists for MIN_PERSIST_DAYS.
            let persist_end = next.window_start + MIN_PERSIST_DAYS * SECS_PER_DAY;
            let persists = window_homes[i + 1..]
                .iter()
                .take_while(|w| w.window_start < persist_end)
                .all(|w| haversine_km(next.lat, next.lon, w.lat, w.lon) < SHIFT_KM / 2.0);

            if persists {
                let ts = (prev.window_start + next.window_start) / 2;
                insert_stmt.execute(rusqlite::params![
                    ts,
                    prev.lat,
                    prev.lon,
                    next.lat,
                    next.lon,
                ])?;

                // Advance past the persistence window to avoid duplicate detection.
                while i + 1 < window_homes.len()
                    && window_homes[i + 1].window_start < persist_end
                {
                    i += 1;
                }
            }
        }
        i += 1;
    }

    list_home_transitions(conn)
}

// ── Private helpers ───────────────────────────────────────────────────────────

fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, DbError> {
    let result: rusqlite::Result<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    );
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::from(e)),
    }
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// Great-circle distance in kilometres (haversine formula).
fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_KM: f64 = 6_371.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    EARTH_RADIUS_KM * 2.0 * a.sqrt().asin()
}

fn map_transition_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HomeTransition> {
    Ok(HomeTransition {
        id: row.get(0)?,
        transition_ts: row.get(1)?,
        old_lat: row.get(2)?,
        old_lon: row.get(3)?,
        new_lat: row.get(4)?,
        new_lon: row.get(5)?,
        is_confirmed: row.get::<_, i64>(6)? != 0,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::photos::{run_migrations, upsert_photo, InsertPhoto};
    use rusqlite::Connection;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn insert_gps(conn: &Connection, path: &str, ts: i64, lat: f64, lon: f64) {
        upsert_photo(
            conn,
            &InsertPhoto {
                file_path: path.to_owned(),
                timestamp: Some(ts),
                latitude: Some(lat),
                longitude: Some(lon),
                thumbnail_path: None,
                blur_score: None,
                trip_id: None,
                file_hash: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn get_home_location_returns_none_when_unset() {
        let conn = mem_db();
        assert!(get_home_location(&conn).unwrap().is_none());
    }

    #[test]
    fn set_and_get_home_location_roundtrip() {
        let conn = mem_db();
        set_home_location(&conn, 51.5, -0.1).unwrap();
        let home = get_home_location(&conn).unwrap().unwrap();
        assert!((home.lat - 51.5).abs() < 1e-9);
        assert!((home.lon - (-0.1)).abs() < 1e-9);
    }

    #[test]
    fn infer_home_returns_none_for_few_photos() {
        let conn = mem_db();
        // Only 3 photos — below the 5-photo threshold.
        for i in 0..3i64 {
            insert_gps(&conn, &format!("/p{i}.jpg"), i * 1000, 51.5, -0.1);
        }
        assert!(infer_home_location(&conn).unwrap().is_none());
    }

    #[test]
    fn infer_home_finds_densest_cell() {
        let conn = mem_db();
        // 8 photos near London, 2 near Paris.
        for i in 0..8i64 {
            insert_gps(&conn, &format!("/lon{i}.jpg"), i * 1000, 51.5, -0.12 + i as f64 * 0.001);
        }
        insert_gps(&conn, "/par1.jpg", 100_000, 48.85, 2.35);
        insert_gps(&conn, "/par2.jpg", 200_000, 48.86, 2.36);

        let home = infer_home_location(&conn).unwrap().unwrap();
        // Home should be near London (lat ~51.5, lon ~ -0.11), not Paris.
        assert!(home.lat > 50.0, "home should be near London");
        assert!(home.lon < 0.0, "home should be west of Greenwich");
    }

    #[test]
    fn confirm_and_dismiss_transition() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO home_transitions
                 (transition_ts, old_lat, old_lon, new_lat, new_lon, is_confirmed)
             VALUES (1000, 51.5, -0.1, 48.85, 2.35, 0)",
            [],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM home_transitions", [], |r| r.get(0))
            .unwrap();

        assert!(confirm_home_transition(&conn, id).unwrap());
        let tr = list_home_transitions(&conn).unwrap();
        assert!(tr[0].is_confirmed);

        assert!(dismiss_home_transition(&conn, id).unwrap());
        assert!(list_home_transitions(&conn).unwrap().is_empty());
    }

    #[test]
    fn home_at_returns_settings_fallback_when_no_transitions() {
        let conn = mem_db();
        set_home_location(&conn, 51.5, -0.1).unwrap();
        let home = home_at(&conn, 9_999_999_999).unwrap().unwrap();
        assert!((home.lat - 51.5).abs() < 1e-9);
    }

    #[test]
    fn home_at_respects_confirmed_transition() {
        let conn = mem_db();
        set_home_location(&conn, 51.5, -0.1).unwrap();
        // Confirmed transition at ts=500 → new home is Paris.
        conn.execute(
            "INSERT INTO home_transitions
                 (transition_ts, old_lat, old_lon, new_lat, new_lon, is_confirmed)
             VALUES (500, 51.5, -0.1, 48.85, 2.35, 1)",
            [],
        )
        .unwrap();

        // Before transition → settings home (London).
        let before = home_at(&conn, 499).unwrap().unwrap();
        assert!((before.lat - 51.5).abs() < 1e-9);

        // After transition → Paris.
        let after = home_at(&conn, 501).unwrap().unwrap();
        assert!((after.lat - 48.85).abs() < 1e-9);
    }
}
