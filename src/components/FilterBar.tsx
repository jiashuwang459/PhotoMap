/** Props for {@link FilterBar}. */
export interface FilterState {
  mode: "all" | "date";
  /** ISO date string (YYYY-MM-DD) or empty */
  fromDate: string;
  /** ISO date string (YYYY-MM-DD) or empty */
  toDate: string;
}

interface FilterBarProps {
  filter: FilterState;
  onChange: (f: FilterState) => void;
  onApply: () => void;
}

export function FilterBar({ filter, onChange, onApply }: FilterBarProps) {
  return (
    <div className="filter-bar">
      <label className="filter-mode-label">
        <input
          type="radio"
          name="filter-mode"
          value="all"
          checked={filter.mode === "all"}
          onChange={() => onChange({ ...filter, mode: "all" })}
        />
        All photos
      </label>

      <label className="filter-mode-label">
        <input
          type="radio"
          name="filter-mode"
          value="date"
          checked={filter.mode === "date"}
          onChange={() => onChange({ ...filter, mode: "date" })}
        />
        By date range
      </label>

      {filter.mode === "date" && (
        <div className="filter-dates">
          <label className="filter-date-label">
            From
            <input
              type="date"
              value={filter.fromDate}
              onChange={(e) => onChange({ ...filter, fromDate: e.target.value })}
            />
          </label>
          <label className="filter-date-label">
            To
            <input
              type="date"
              value={filter.toDate}
              onChange={(e) => onChange({ ...filter, toDate: e.target.value })}
            />
          </label>
        </div>
      )}

      <button className="filter-apply-button" onClick={onApply}>
        Apply
      </button>
    </div>
  );
}
