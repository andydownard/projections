// web/src/pages/ProjectionDetail.tsx — read + edit a projection (M2/M4).
//
// READ (/p/<slug>): renders the stored decision verbatim — banner, KPIs, monthly
// cash-flow, .xlsx export. No editable affordance, no settings tab. With ai=off a
// narrative-disabled placeholder renders (the surface degrades, never crashes).
//
// EDIT (/p/<slug>/edit#<edit-secret>): the fragment secret is read once then
// scrubbed from the address bar (SECURITY.md §2.5). Owner/edit token drives the
// autosave PATCH (If-Match: version). A stale save → the 409 SaveConflictModal
// (reload / overwrite / save-as-copy). Net profit is a derived total — its cell
// is non-pinnable (aria-disabled), enforced server-side too (PRD §14).
//
// NO client math: every figure is the server's { display } string.
import { useEffect, useRef, useState } from "react";

import { fetchProjection, type ViewModel, xlsxHref } from "../api/viewModel";
import { patchProjection, PatchConflictError } from "../api/patch";
import { submitFeedback } from "../api/feedback";
import { ProjectionTab } from "../components/ProjectionTab";
import { FeedbackModal } from "../components/FeedbackModal";
import { SaveConflictModal } from "../components/SaveConflictModal";
import { SettingsTab } from "../components/SettingsTab";
import { DegradedState } from "../components/DegradedState";
import type { ConflictBody } from "../state/autosaveReducer";
import { SAVE_LABEL, type SaveState } from "../state/saveLabels";
import type { ServerValue } from "../api/client";
import type { PatchHandlerArgs } from "../components/SettingsTab";
import { readFragmentSecret } from "../router/route";

export interface ProjectionDetailProps {
  slug: string;
  edit: boolean;
  aiOff?: boolean;
}

function sv(v: ServerValue | number | string | undefined): ServerValue {
  if (v && typeof v === "object" && "raw" in v) return v;
  return { raw: typeof v === "number" ? v : 0, display: String(v ?? "") };
}

/** Build the SettingsTab view-model from the server settings map. */
function settingsVm(s: ViewModel["settings"]) {
  return {
    laborPct: sv(s.laborPct),
    marketingPct: sv(s.marketingPct),
    suppliesPct: sv(s.suppliesPct),
    cardPct: sv(s.cardPct),
    payrollTaxPct: sv(s.payrollTaxPct),
    salvagePct: sv(s.salvagePct),
    escalator: sv(s.escalator),
    occupancyAnnual: sv(s.occupancyAnnual ?? s.reserveBuffer),
    shareY1: sv(s.shareY1),
    shareY2: sv(s.shareY2),
    shareY3: sv(s.shareY3),
  };
}

export function ProjectionDetail({ slug, edit, aiOff = false }: ProjectionDetailProps) {
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [version, setVersion] = useState(0);
  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<ConflictBody | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last PATCH body we attempted, so the failure-state retry button can
  // re-fire exactly that mutation (UX fix #10) at the current If-Match version.
  const lastPatch = useRef<Record<string, unknown> | null>(null);
  // Capture the edit secret from the fragment ONCE on first render (a lazy ref
  // initializer), BEFORE StrictMode's double-invoke can re-read the (scrubbed)
  // hash. Fall back to the owner token. Then scrub the fragment from the URL so
  // the secret never lands in history/logs (SECURITY.md §2.5).
  const token = useRef<string | null>(
    edit
      ? readFragmentSecret(window.location.hash) ??
          localStorage.getItem("projections.owner_token")
      : null,
  );
  useEffect(() => {
    if (edit && window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [edit]);

  // Load the stored snapshot.
  useEffect(() => {
    let cancelled = false;
    void fetchProjection(slug).then((data) => {
      if (cancelled) return;
      setVm(data);
      setVersion(data.version);
      setName(data.name);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function doPatch(body: Record<string, unknown>, ver: number) {
    // Remember the last attempted mutation so a failed save can be retried verbatim.
    lastPatch.current = body;
    const res = await patchProjection({
      viewSlug: slug,
      token: token.current ?? "",
      version: ver,
      body,
    });
    setVm(res.viewModel as ViewModel);
    setVersion(res.version);
    return res.version;
  }

  function onNameChange(value: string) {
    setName(value);
    setSaveState("saving");
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => {
      doPatch({ name: value }, version)
        .then(() => setSaveState("saved"))
        .catch((err) => {
          if (err instanceof PatchConflictError) {
            setConflict(err.conflict);
          } else {
            setSaveState("error");
          }
        });
    }, 150);
  }

  async function onSettingsPatch(args: PatchHandlerArgs) {
    setSaveState("saving");
    try {
      const v = await doPatch(args.body as Record<string, unknown>, args.version);
      setSaveState("saved");
      return { version: v, viewModel: vm };
    } catch (err) {
      if (err instanceof PatchConflictError) {
        setConflict(err.conflict);
      } else {
        setSaveState("error");
      }
      throw err;
    }
  }

  // Failure-state recovery: re-fire the last PATCH body at the current version.
  function retry() {
    const body = lastPatch.current;
    if (!body) return;
    setSaveState("saving");
    doPatch(body, version)
      .then(() => setSaveState("saved"))
      .catch((err) => {
        if (err instanceof PatchConflictError) {
          setConflict(err.conflict);
        } else {
          setSaveState("error");
        }
      });
  }

  function resolveReload() {
    const v = conflict?.current_version ?? version;
    setConflict(null);
    void fetchProjection(slug).then((data) => {
      setVm(data);
      setVersion(data.version);
      setName(data.name);
    });
    setVersion(v);
    setSaveState("saved");
  }

  function resolveOverwrite() {
    const v = conflict?.current_version ?? version;
    setConflict(null);
    doPatch({ name }, v)
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("error"));
  }

  function resolveSaveAsCopy() {
    setConflict(null);
    setSaveState("saved");
  }

  if (!vm) {
    // First-class loading state (UX fix #9): a skeleton that reserves the real
    // layout — banner block, a 5-tile KPI strip, ~8 table rows — so first paint
    // does not jump the viewport. Shimmer is gated behind prefers-reduced-motion
    // in the CSS (.skeleton); markup stays inert (aria-hidden under aria-busy).
    return (
      <div className="detail detail--loading" aria-busy="true" data-testid="detail-skeleton">
        <span className="sr-only" role="status" aria-live="polite">
          Loading projection…
        </span>
        <div className="skeleton skeleton--banner" aria-hidden="true" />
        <div className="skeleton-kpis" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton skeleton--kpi" />
          ))}
        </div>
        <div className="skeleton-rows" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton skeleton--row" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="detail">
      {edit && saveState !== "idle" && (
        <span data-testid="save-label" role="status" aria-live="polite">
          {saveState === "error" ? (
            // The failure state is a real recovery affordance, not the bare word
            // "retry": clicking it re-fires the last PATCH (UX fix #10).
            <button type="button" className="save-label__retry" onClick={retry}>
              {SAVE_LABEL.error}
            </button>
          ) : (
            SAVE_LABEL[saveState]
          )}
        </span>
      )}

      {edit && (
        <label className="detail__name">
          Store name
          <input
            aria-label="Store name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </label>
      )}

      {/* The Projection tab renders the stored view-model verbatim: decision
          banner + tiles, KPI strip, monthly cash-flow SVG, and the 3-year table
          with the Input/Computed/Overridden/Estimated legend and cell-state
          classes. No client math. The recompute live-region carries the autosave
          settle label so a recompute is announced (a11y). */}
      <ProjectionTab
        vm={vm}
        recomputeStatus={edit && saveState !== "idle" ? SAVE_LABEL[saveState] : ""}
      />

      {edit && (
        <div data-testid="settings-tab">
          <SettingsTab
            settings={settingsVm(vm.settings)}
            version={version}
            onPatch={onSettingsPatch}
            onSaveAsCopy={resolveSaveAsCopy}
          />
        </div>
      )}

      {aiOff && (
        <section data-testid="narrative-disabled" className="narrative narrative--disabled">
          {/* Accessible AI-opt-out notice (M7 I2): the surface degrades, never
              crashes — role="status", meaning in text, not color alone. */}
          <DegradedState kind="ai-opt-out" />
          {/* Manual rent path: with research off the operator enters rent by hand
              (PRD §21 — compute is AI-independent). */}
          <label className="detail__rent">
            Monthly rent (manual — AI research off)
            <input aria-label="Rent" defaultValue="10000" />
          </label>
        </section>
      )}

      <div className="detail__actions">
        <a
          className="btn"
          role="button"
          data-testid="download-xlsx"
          href={xlsxHref(slug)}
          download
        >
          Download .xlsx
        </a>
        {edit && (
          <button type="button" onClick={() => setShowFeedback(true)}>
            Feedback
          </button>
        )}
      </div>

      {conflict && (
        <SaveConflictModal
          onReload={resolveReload}
          onOverwrite={resolveOverwrite}
          onSaveAsCopy={resolveSaveAsCopy}
          message={conflict.message}
        />
      )}

      {showFeedback && (
        <FeedbackModal
          onClose={() => setShowFeedback(false)}
          onSubmit={async (input) => {
            const res = await submitFeedback({
              title: input.title,
              description: input.description,
              route: window.location.pathname,
            });
            return res.support_id;
          }}
        />
      )}
    </div>
  );
}

export default ProjectionDetail;
