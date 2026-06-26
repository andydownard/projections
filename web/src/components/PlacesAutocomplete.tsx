// web/src/components/PlacesAutocomplete.tsx — accessible address typeahead.
//
// A WAI-ARIA combobox: type a store address, pick a prediction, and the SERVER
// resolves it to a Census-derived trade area (PlacesAutocomplete never sees a
// key). Debounced autocomplete, keyboard navigable (↑/↓/Enter/Esc), with a
// per-search session token for Places billing. It owns search only — the caller
// decides what to do with the resolved trade area (households are editable).
import { useEffect, useId, useRef, useState } from "react";

import {
  newSessionToken,
  placesAutocomplete,
  placesResolve,
  ResolveError,
  type Prediction,
  type ResolveErrorKind,
  type TradeAreaResolved,
} from "../api/places";

export interface PlacesAutocompleteProps {
  label: string;
  /** Resolve uses this basis; the result also carries city+county alternatives. */
  basis: string;
  onResolved: (result: TradeAreaResolved) => void;
  onError: (kind: ResolveErrorKind) => void;
}

const DEBOUNCE_MS = 250;
const MIN_LEN = 3;

export function PlacesAutocomplete({ label, basis, onResolved, onError }: PlacesAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const tokenRef = useRef<string>(newSessionToken());
  const selectingRef = useRef(false);
  const listId = useId();

  // Debounced autocomplete. Two guards keep stale results from re-opening the
  // list: the timer is cleared on each keystroke (live flag drops late responses),
  // and selecting a prediction sets selectingRef so the setQuery it triggers does
  // NOT re-fire a search (which would reopen the dropdown over the chosen value).
  useEffect(() => {
    if (selectingRef.current) {
      selectingRef.current = false;
      setPredictions([]);
      setOpen(false);
      return;
    }
    const q = query.trim();
    if (q.length < MIN_LEN) {
      setPredictions([]);
      setOpen(false);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      const preds = await placesAutocomplete(q, tokenRef.current);
      if (!live) return;
      setPredictions(preds);
      setOpen(preds.length > 0);
      setActive(preds.length > 0 ? 0 : -1);
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  async function select(p: Prediction) {
    selectingRef.current = true; // the setQuery below must NOT re-open the list
    setOpen(false);
    setActive(-1);
    setQuery(p.description);
    setBusy(true);
    try {
      const result = await placesResolve(p.place_id, basis, tokenRef.current);
      onResolved(result);
    } catch (e) {
      onError(e instanceof ResolveError ? e.kind : "network");
    } finally {
      setBusy(false);
      tokenRef.current = newSessionToken(); // a resolve ends the billing session
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || predictions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % predictions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + predictions.length) % predictions.length);
    } else if (e.key === "Enter") {
      if (active >= 0) {
        e.preventDefault();
        void select(predictions[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="places">
      <label className="wizard__field places__field">
        {label}
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
          autoComplete="off"
          placeholder="Start typing a store address…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
        />
      </label>
      {busy && (
        <p className="places__status" role="status">
          Looking up the trade area…
        </p>
      )}
      {open && (
        <ul className="places__list" id={listId} role="listbox" aria-label={label}>
          {predictions.map((p, i) => (
            <li
              key={p.place_id}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "places__option places__option--active" : "places__option"}
              onMouseDown={(e) => {
                e.preventDefault();
                void select(p);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {p.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default PlacesAutocomplete;
