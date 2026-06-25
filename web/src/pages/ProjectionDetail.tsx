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
import type { ConflictBody } from "../state/autosaveReducer";
import type { ServerValue } from "../api/client";
import type { PatchHandlerArgs } from "../components/SettingsTab";
import { readFragmentSecret } from "../router/route";

export interface ProjectionDetailProps {
  slug: string;
  edit: boolean;
  aiOff?: boolean;
}

type SaveLabel = "All changes saved" | "Saving…" | "Save failed — retry" | "";

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
  const [saveLabel, setSaveLabel] = useState<SaveLabel>("");
  const [conflict, setConflict] = useState<ConflictBody | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setSaveLabel("Saving…");
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => {
      doPatch({ name: value }, version)
        .then(() => setSaveLabel("All changes saved"))
        .catch((err) => {
          if (err instanceof PatchConflictError) {
            setConflict(err.conflict);
          } else {
            setSaveLabel("Save failed — retry");
          }
        });
    }, 150);
  }

  async function onSettingsPatch(args: PatchHandlerArgs) {
    setSaveLabel("Saving…");
    try {
      const v = await doPatch(args.body as Record<string, unknown>, args.version);
      setSaveLabel("All changes saved");
      return { version: v, viewModel: vm };
    } catch (err) {
      if (err instanceof PatchConflictError) {
        setConflict(err.conflict);
      } else {
        setSaveLabel("Save failed — retry");
      }
      throw err;
    }
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
    setSaveLabel("All changes saved");
  }

  function resolveOverwrite() {
    const v = conflict?.current_version ?? version;
    setConflict(null);
    doPatch({ name }, v)
      .then(() => setSaveLabel("All changes saved"))
      .catch(() => setSaveLabel("Save failed — retry"));
  }

  function resolveSaveAsCopy() {
    setConflict(null);
    setSaveLabel("All changes saved");
  }

  if (!vm) {
    return <div className="detail detail--loading">Loading…</div>;
  }

  return (
    <div className="detail">
      {edit && (
        <span data-testid="save-label" role="status" aria-live="polite">
          {saveLabel}
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
      <ProjectionTab vm={vm} recomputeStatus={edit ? saveLabel : ""} />

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
          <p>AI narrative is off. The decision and numbers above are computed without AI.</p>
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
