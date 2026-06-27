// web/src/pages/ProjectionDetail.tsx — read + edit a projection (M2/M4).
//
// READ (/p/<slug>): renders the stored decision verbatim — banner, KPIs, monthly
// cash-flow, .xlsx export. No editable affordance, no settings tab. With ai=off a
// narrative-disabled placeholder renders (the surface degrades, never crashes).
//
// EDIT (/p/<slug>/edit#<edit-secret>): the fragment secret is read once then
// scrubbed from the address bar (SECURITY.md §2.5). Owner/edit token drives the
// autosave PATCH (If-Match: version) — for the OWNER the fallback owner token in
// localStorage authorizes it, so the editable surface is reachable from the list
// with no secret in the URL (issue #143). A stale save → the 409 SaveConflictModal
// (reload / overwrite / save-as-copy). Net profit is a derived total — its cell
// is non-pinnable (aria-disabled), enforced server-side too (PRD §14).
//
// A 404 (bad/expired/removed slug) rejects the load; we render a load-failed
// DegradedState rather than spinning "Loading…" forever (issue #146). The model
// version + autosave state are published to the shared TopBar header chips —
// detail-page-only (issue #150).
//
// NO client math: every figure is the server's { display } string.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { fetchProjection, type ViewModel, xlsxHref } from "../api/viewModel";
import { patchProjection, PatchConflictError } from "../api/patch";
import { submitFeedback } from "../api/feedback";
import { ProjectionTab } from "../components/ProjectionTab";
import { TradeAreaMap } from "../components/TradeAreaMap";
import { EvidencePanel } from "../components/EvidencePanel";
import { FeedbackModal } from "../components/FeedbackModal";
import { SaveConflictModal } from "../components/SaveConflictModal";
import { SettingsTab } from "../components/SettingsTab";
import { DegradedState } from "../components/DegradedState";
import type { SaveState } from "../components/TopBar";
import type { ConflictBody } from "../state/autosaveReducer";
import { clearDetailHeader, setDetailHeader } from "../state/detailHeader";
import type { ServerValue } from "../api/client";
import type { PatchHandlerArgs } from "../components/SettingsTab";
import { readFragmentSecret } from "../router/route";

export interface ProjectionDetailProps {
  slug: string;
  edit: boolean;
  aiOff?: boolean;
}

type SaveLabel = "All changes saved" | "Saving…" | "Save failed — retry" | "";

/** Map the in-page autosave label to the TopBar save-state enum (header chip). */
function labelToSaveState(label: SaveLabel): SaveState {
  switch (label) {
    case "Saving…":
      return "saving";
    case "All changes saved":
      return "saved";
    case "Save failed — retry":
      return "error";
    default:
      return "idle";
  }
}

/** SPA-navigate home (the shell re-renders on popstate). */
function goHome() {
  window.history.pushState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const DETAIL_TABS = [
  { id: "projection", label: "Projection" },
  { id: "settings", label: "Settings" },
] as const;
type DetailTabId = (typeof DETAIL_TABS)[number]["id"];

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
  const [activeTab, setActiveTab] = useState<DetailTabId>("projection");
  const [loadError, setLoadError] = useState(false);

  // Roving tab navigation (WAI-ARIA tabs): Left/Right move + focus the next tab.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = DETAIL_TABS.findIndex((t) => t.id === activeTab);
    const n = DETAIL_TABS.length;
    const next = DETAIL_TABS[e.key === "ArrowRight" ? (i + 1) % n : (i - 1 + n) % n];
    setActiveTab(next.id);
    document.getElementById(`detail-tab-${next.id}`)?.focus();
  }
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
    setLoadError(false);
    void fetchProjection(slug)
      .then((data) => {
        if (cancelled) return;
        setVm(data);
        setVersion(data.version);
        setName(data.name);
      })
      .catch(() => {
        // 404 / network failure: degrade to a labelled error state, never spin.
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Publish the detail-only header chips (model version + autosave state) to the
  // shared TopBar (#150). The shell also gates these on the detail route, but we
  // reset on unmount so nothing lingers after navigating away.
  useEffect(() => {
    setDetailHeader({ modelVersion: vm?.model_version });
  }, [vm?.model_version]);
  useEffect(() => {
    setDetailHeader({ saveState: edit ? labelToSaveState(saveLabel) : "idle" });
  }, [edit, saveLabel]);
  useEffect(() => clearDetailHeader, []);

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

  if (loadError) {
    return (
      <div className="detail">
        <DegradedState
          kind="load-failed"
          onAction={goHome}
          actionLabel="Back to your projections"
        />
      </div>
    );
  }

  if (!vm) {
    return <div className="detail detail--loading">Loading…</div>;
  }

  return (
    <div className="detail">
      {/* The autosave status is now a header chip in the shared TopBar (#150);
          ProjectionTab keeps its own recompute live-region for SR users. */}
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

      {/* Projection content: the stored view-model verbatim (decision banner +
          tiles, KPI strip, cash-flow SVG, 3-year table — no client math), the
          trade-area map, and the evidence/confidence panel. In edit mode it's the
          first of a Projection | Settings tablist; read mode shows it directly. */}
      {(() => {
        const projection = (
          <>
            <ProjectionTab key={slug} vm={vm} recomputeStatus={edit ? saveLabel : ""} />
            <TradeAreaMap
              slug={slug}
              location={vm.location}
              basis={vm.trade_area?.basis}
              geography={vm.trade_area?.geography_name}
              size="detail"
            />
            <EvidencePanel evidence={vm.evidence ?? []} />
          </>
        );
        if (!edit) return projection;
        return (
          <div className="detail__tabs">
            <div role="tablist" aria-label="Projection views" className="tabs">
              {DETAIL_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`detail-tab-${t.id}`}
                  aria-selected={activeTab === t.id}
                  aria-controls={`detail-panel-${t.id}`}
                  tabIndex={activeTab === t.id ? 0 : -1}
                  className={activeTab === t.id ? "tabs__tab tabs__tab--active" : "tabs__tab"}
                  onClick={() => setActiveTab(t.id)}
                  onKeyDown={onTabKey}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id="detail-panel-projection"
              aria-labelledby="detail-tab-projection"
              className="detail__panel"
              hidden={activeTab !== "projection"}
            >
              {projection}
            </div>
            <div
              role="tabpanel"
              id="detail-panel-settings"
              aria-labelledby="detail-tab-settings"
              className="detail__panel"
              hidden={activeTab !== "settings"}
            >
              <div data-testid="settings-tab">
                <SettingsTab
                  settings={settingsVm(vm.settings)}
                  version={version}
                  onPatch={onSettingsPatch}
                  onSaveAsCopy={resolveSaveAsCopy}
                />
              </div>
            </div>
          </div>
        );
      })()}

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
