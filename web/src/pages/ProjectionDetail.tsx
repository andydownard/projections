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
// (reload / overwrite / save-as-copy). Net income is a derived total — its cell
// is non-pinnable (aria-disabled), enforced server-side too (PRD §14).
//
// A 404 (bad/expired/removed slug) rejects the load; we render a load-failed
// DegradedState rather than spinning "Loading…" forever (issue #146). The model
// version + autosave state are published to the shared TopBar header chips —
// detail-page-only (issue #150).
//
// NO client math: every figure is the server's { display } string.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  fetchProjection,
  type ViewModel,
  type OverrideEntry,
  xlsxHref,
  docxHref,
} from "../api/viewModel";
import { getEditToken, getOwnerToken } from "../api/projections";
import { patchProjection, PatchConflictError } from "../api/patch";
import { ShareModal } from "../components/ShareModal";
import { ProjectionTab, fieldChangeKey, type FieldChangeInfo } from "../components/ProjectionTab";
import type { FieldChangeActor } from "../components/FieldChange";
import { TradeAreaMap } from "../components/TradeAreaMap";
import { EvidencePanel } from "../components/EvidencePanel";
import { SaveConflictModal } from "../components/SaveConflictModal";
import { SettingsTab } from "../components/SettingsTab";
import { KpiStrip } from "../components/KpiStrip";
import { Sparkline } from "../components/Sparkline";
import { DegradedState } from "../components/DegradedState";
import { PennyAssistant } from "../components/PennyDrawer";
import type {
  OverrideAuditItem,
  OverrideCommentTarget,
} from "../components/OverrideAudit";
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

// Epic G (#41): the owner detail page is a Projection | KPIs tablist — Settings is
// MERGED into the KPIs tab (no standalone Settings page).
const DETAIL_TABS = [
  { id: "projection", label: "Projection" },
  { id: "kpis", label: "KPIs" },
] as const;
type DetailTabId = (typeof DETAIL_TABS)[number]["id"];

function sv(v: ServerValue | number | string | undefined): ServerValue {
  if (v && typeof v === "object" && "raw" in v) return v;
  return { raw: typeof v === "number" ? v : 0, display: String(v ?? "") };
}

// PE7 (#126): the per-field "recent change / was X / undo" affordance is DERIVED,
// not computed. We snapshot the editable donor-share cells' SERVER display strings
// and diff them across a mutation (Penny apply or manual) — a string compare, never
// any math (PRD §13). The "previous value" is the prior revision's display string;
// the undo is a normal FORWARD PATCH restoring the prior input value → recompute →
// version++ → a NEW revision (it never erases the revision that introduced the
// change). We scope undo to the donor-share inputs because those map cleanly +
// reversibly to the `inputs.share_y{n}` PATCH key; broader editable rows can
// be added as their reversible PATCH mapping is confirmed.
interface TrackedCell {
  key: string; // fieldChangeKey(node, year)
  display: string; // server display string (verbatim)
  raw: number; // the share input value (0..1) used to revert
  patchKey: string; // share_y1 | share_y2 | share_y3
}

/** The editable donor-share cells of a view-model, snapshotted for diffing. Iterates
 *  Y1..Y5 so a 2.6.0 snapshot tracks all five shares; a legacy 3-year snapshot simply
 *  has no y4/y5 cell and skips them (year-count-agnostic). */
function shareCells(vm: ViewModel): TrackedCell[] {
  const out: TrackedCell[] = [];
  const row = vm.rows.find((r) => r.editable && r.group === "drivers" && /share/i.test(r.label));
  if (!row) return out;
  const node = row.node ?? row.label;
  for (const year of [1, 2, 3, 4, 5] as const) {
    const cell = row[`y${year}` as "y1" | "y2" | "y3" | "y4" | "y5"];
    if (!cell) continue;
    out.push({
      key: fieldChangeKey(node, year),
      display: cell.display,
      raw: cell.raw,
      patchKey: `share_y${year}`,
    });
  }
  return out;
}

/** A §12.2 guardrail (net-margin / Y1 share out of band) demanding a justification
 *  note that travels into the packet. Read VERBATIM from the server `flags` — the
 *  client never decides the policy, only surfaces the prompt (PRD §12.2/§14). */
function guardrailRequiresNote(vm: ViewModel): boolean {
  const flags = (vm.flags ?? {}) as Record<string, { requires_note?: boolean } | undefined>;
  return Boolean(
    flags.net_margin_out_of_band?.requires_note || flags.share_y1_out_of_band?.requires_note,
  );
}

/** Title-case a bare engine node id as a fallback human label ("payroll" → "Payroll"). */
function prettyNode(node: string): string {
  const s = node.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A display string for the override's calculated value (it may arrive as a
 *  {raw,display} or as a bare "N/A" string); rendered verbatim, never recomputed. */
function calculatedDisplay(c: OverrideEntry["calculated"]): string | undefined {
  if (c == null) return undefined;
  if (typeof c === "string") return c;
  return c.display;
}

/** Build the Override audit (relocated from the eliminated Override Inspector) from
 *  the view-model's `overrides[]` — the SERVER display string of every pinned cell,
 *  rendered VERBATIM (no client math). The label comes from the matching row; the
 *  stale-upstream flag from `staleNodes`; `needsNote` lights up when a §12.2 guardrail
 *  requires a justification the pin doesn't yet carry. */
function auditItems(vm: ViewModel): OverrideAuditItem[] {
  const overrides = vm.overrides ?? [];
  if (overrides.length === 0) return [];
  // node id → human row label (component rows carry `node`; fall back to a pretty id).
  const labelByNode = new Map<string, string>();
  for (const row of vm.rows) {
    if (row.node) labelByNode.set(row.node, row.label);
  }
  const stale = new Set(vm.staleNodes ?? []);
  const needNote = guardrailRequiresNote(vm);
  return overrides.map((o) => {
    const base = labelByNode.get(o.node) ?? prettyNode(o.node);
    const note = o.note ?? "";
    return {
      node: o.node,
      year: o.year,
      label: `${base}, Year ${o.year}`,
      value: o.value.display,
      calculated: calculatedDisplay(o.calculated),
      note: note || undefined,
      stale: stale.has(o.node),
      needsNote: needNote && note.length === 0,
    };
  });
}

/** Build the SettingsTab view-model from the server settings map. The 2.6.0 / E2
 *  drivers (shareY4/Y5, donationValue, basket, donationsPerHouseholdPerYear) are
 *  included ONLY when the snapshot carries them, so a legacy 3-year snapshot renders
 *  just the drivers it actually has (the merged grid filters on presence). */
function settingsVm(s: ViewModel["settings"]) {
  const has = (k: string) => s[k] !== undefined && s[k] !== null;
  return {
    laborPct: sv(s.laborPct),
    marketingPct: sv(s.marketingPct),
    suppliesPct: sv(s.suppliesPct),
    cardPct: sv(s.cardPct),
    payrollTaxPct: sv(s.payrollTaxPct),
    salvagePct: sv(s.salvagePct),
    escalator: sv(s.escalator),
    shareY1: sv(s.shareY1),
    shareY2: sv(s.shareY2),
    shareY3: sv(s.shareY3),
    ...(has("shareY4") ? { shareY4: sv(s.shareY4) } : {}),
    ...(has("shareY5") ? { shareY5: sv(s.shareY5) } : {}),
    ...(has("donationValue") ? { donationValue: sv(s.donationValue) } : {}),
    ...(has("basket") ? { basket: sv(s.basket) } : {}),
    ...(has("donationsPerHouseholdPerYear")
      ? { donationsPerHouseholdPerYear: sv(s.donationsPerHouseholdPerYear) }
      : {}),
  };
}

/** Format an ISO timestamp as a short "Updated MMM D, YYYY" string for the header.
 *  Display only; rendered ONLY when the server provides `updated_at` (never a
 *  fabricated date). Returns null for a missing/unparseable value. */
function updatedLabel(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `Updated ${d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
}

/** The 4-cell header metric bar (D1): Income sparkline · Capital required (RED) ·
 *  Payback · Break-even. Carries the e2e/detail `metric-*` + `decision-banner`
 *  testids the rest of the app reads. Every figure is the server's display string
 *  (no client math); the sparkline geometry comes from the server's incomeSeries. */
function MetricBar({ vm }: { vm: ViewModel }) {
  const { metrics, milestones, incomeSeries, year5Income } = vm;
  const breakeven = milestones?.breakEven ?? metrics.breakeven;
  const payback = milestones?.payback;
  const points = (incomeSeries ?? []).map((s) => s.raw);
  return (
    <section
      className="metric-bar decision-banner"
      data-testid="decision-banner"
      aria-label="Key decision metrics"
    >
      {incomeSeries && incomeSeries.length > 0 && (
        <div className="metric-bar__cell metric-bar__cell--income" data-testid="metric-income">
          <span className="metric-bar__label">Income</span>
          <Sparkline
            points={points}
            y5Label={year5Income?.display}
            aria-label={`Annual net income Year 1 to Year ${points.length}${
              year5Income ? `, ending at ${year5Income.display}` : ""
            }`}
          />
        </div>
      )}
      <div className="metric-bar__cell">
        <span className="metric-bar__label">Capital required</span>
        <span
          className="metric-bar__value metric-bar__value--capital num"
          data-testid="metric-capital"
        >
          {metrics.capital.display}
        </span>
        <span className="metric-bar__sub">money to raise</span>
      </div>
      {payback && (
        <div className="metric-bar__cell">
          <span className="metric-bar__label">Payback</span>
          <span className="metric-bar__value num" data-testid="metric-payback">
            {payback.display}
          </span>
          {payback.raw == null && payback.reason && (
            <span className="metric-bar__sub">{payback.reason}</span>
          )}
        </div>
      )}
      <div className="metric-bar__cell">
        <span className="metric-bar__label">Break-even</span>
        <span className="metric-bar__value num" data-testid="metric-breakeven">
          {breakeven.display}
        </span>
      </div>
    </section>
  );
}

export function ProjectionDetail({ slug, edit, aiOff = false }: ProjectionDetailProps) {
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [version, setVersion] = useState(0);
  const [name, setName] = useState("");
  const [saveLabel, setSaveLabel] = useState<SaveLabel>("");
  const [conflict, setConflict] = useState<ConflictBody | null>(null);
  // D1 / Decision 13: the always-on "Store name" input is replaced by an inline
  // pencil-to-rename. `renaming` reveals the inline input; committing returns to the
  // heading. The input keeps aria-label "Store name" so it stays addressable.
  const [renaming, setRenaming] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTabId>("projection");
  const [loadError, setLoadError] = useState(false);
  // EPIC SHARE (Decision 12): the unified Share panel. The editable link's capability
  // (the edit token) is held in localStorage on the owner's device only — never minted
  // here and never in a URL path/query (it rides the fragment in the link the panel
  // builds). Absent ⇒ the panel offers the read-only link alone.
  const [shareOpen, setShareOpen] = useState(false);

  // PE7: the recent per-field changes (keyed by fieldChangeKey) + the refs that
  // derive them. `prevCellsRef` is the editable-share snapshot from the last vm;
  // `revertRef` remembers the prior value to PATCH back for an inline undo;
  // `pendingActorRef` carries the attribution (penny / user / undo) for the NEXT
  // vm diff. The badge persists in `fieldChanges` until acknowledged/superseded.
  const [fieldChanges, setFieldChanges] = useState<Record<string, FieldChangeInfo>>({});
  const prevCellsRef = useRef<Map<string, TrackedCell>>(new Map());
  const revertRef = useRef<Map<string, { patchKey: string; raw: number }>>(new Map());
  const pendingActorRef = useRef<{ by: FieldChangeActor; reverted: boolean } | null>(null);

  // Epic G2 (#42): the Override Inspector is eliminated — Penny slides OUT to capture
  // an override justification, so the detail page controls Penny's open state and the
  // override currently being justified. `autoPromptedRef` debounces the guardrail
  // auto-open so Penny only nags once per pin, not on every recompute.
  const [pennyOpen, setPennyOpen] = useState(false);
  const [commentTarget, setCommentTarget] = useState<OverrideCommentTarget | null>(null);
  const autoPromptedRef = useRef<Set<string>>(new Set());

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
  // hash. Fall back to the per-slug stored edit token (set by App's capture effect
  // BEFORE the Clerk gate shows, so it's available after a sign-in round-trip), then
  // to the owner token. Then scrub the fragment from the URL so the secret never
  // lands in history/logs (SECURITY.md §2.5).
  const token = useRef<string | null>(
    edit
      ? readFragmentSecret(window.location.hash) ?? getEditToken(slug) ?? getOwnerToken()
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

  // Publish the detail-only autosave chip to the shared TopBar (#150). The shell
  // also gates this on the detail route, but we reset on unmount so nothing lingers
  // after navigating away. The model_version is NO LONGER displayed (#38) — it
  // stays on vm.model_version / computed_json, just never rendered as a chip.
  useEffect(() => {
    setDetailHeader({ saveState: edit ? labelToSaveState(saveLabel) : "idle" });
  }, [edit, saveLabel]);
  useEffect(() => clearDetailHeader, []);

  // #203 — give every projection its own page title (was the static
  // "Thrift Store Projection" for all of them) so AT/tab/history identify it.
  useEffect(() => {
    if (!vm) return;
    const named = (name || vm.name || "").trim();
    document.title = named
      ? `${named} — Thrift Store Projection`
      : "Thrift Store Projection";
  }, [vm, name]);

  // PE7: derive the per-field change badges by diffing the editable-share display
  // strings whenever the view-model settles. `pendingActorRef` (set by the mutation
  // that triggered this settle) attributes the change; on the initial load there is
  // no actor, so we only seed the snapshot. No client math — display strings only.
  useEffect(() => {
    if (!vm) return;
    const cells = shareCells(vm);
    const prev = prevCellsRef.current;
    const meta = pendingActorRef.current;
    if (meta && prev.size > 0) {
      const next: Record<string, FieldChangeInfo> = {};
      for (const c of cells) {
        const p = prev.get(c.key);
        if (p && p.display !== c.display) {
          next[c.key] = { previous: p.display, by: meta.by, reverted: meta.reverted };
          revertRef.current.set(c.key, { patchKey: c.patchKey, raw: p.raw });
        }
      }
      if (Object.keys(next).length > 0) setFieldChanges((cur) => ({ ...cur, ...next }));
    }
    prevCellsRef.current = new Map(cells.map((c) => [c.key, c]));
    pendingActorRef.current = null;
  }, [vm]);

  // Epic G2 (#42): when a §12.2 guardrail demands a justification an override doesn't
  // yet carry, SLIDE Penny OUT with the focused prompt — the note that travels into
  // the board packet is captured in the drawer, not a standalone inspector. Debounced
  // per pin (autoPromptedRef) so a later recompute never re-nags a pin the owner is
  // already — or has finished — justifying.
  useEffect(() => {
    if (!edit || !vm) return;
    const needing = auditItems(vm).find((o) => o.needsNote);
    if (!needing) return;
    const key = `${needing.node}#${needing.year}`;
    if (autoPromptedRef.current.has(key)) return;
    autoPromptedRef.current.add(key);
    setCommentTarget({ node: needing.node, year: needing.year, label: needing.label });
    setPennyOpen(true);
  }, [vm, edit]);

  // PE7: per-field inline undo — a FORWARD PATCH restoring the share input to its
  // prior value (carries Bearer + If-Match), producing a NEW revision. Never erases
  // the revision that introduced the change; re-undoable (the revert is itself a
  // recent change the next diff surfaces as "reverted — was …").
  function onUndoField(node: string, year: number) {
    const revert = revertRef.current.get(fieldChangeKey(node, year));
    if (!revert) return;
    pendingActorRef.current = { by: "user", reverted: true };
    setSaveLabel("Saving…");
    doPatch({ inputs: { [revert.patchKey]: revert.raw } }, version)
      .then(() => setSaveLabel("All changes saved"))
      .catch((err) => {
        if (err instanceof PatchConflictError) setConflict(err.conflict);
        else setSaveLabel("Save failed — retry");
      });
  }

  // Epic G2 (#42) / P1 regression (#284): commit an inline edit from a 3-year-table
  // cell. The standalone Override Inspector that used to host value entry is gone, so
  // the cell itself is the entry point again. A share-driver cell routes to its
  // inputs.share_yN key (consistent with the Settings sliders, Penny, and the
  // per-field undo); every other editable component cell PINS the typed value through
  // the EXISTING override contract (overrides.set {node,year,value}). When the
  // recompute trips a §12.2 guardrail, the auto-prompt effect above slides Penny OUT
  // to capture the justification note — no data-model or server-contract change.
  function onEditCell(node: string, year: number, value: string) {
    if (!vm) return;
    const v = value.trim();
    if (!v) return;
    const share = shareCells(vm).find((c) => c.key === fieldChangeKey(node, year));
    const num = Number(v);
    const body =
      share && Number.isFinite(num)
        ? { inputs: { [share.patchKey]: num } }
        : { overrides: { set: [{ node, year, value: v }] } };
    pendingActorRef.current = { by: "user", reverted: false };
    setSaveLabel("Saving…");
    doPatch(body, version)
      .then(() => setSaveLabel("All changes saved"))
      .catch((err) => {
        if (err instanceof PatchConflictError) setConflict(err.conflict);
        else setSaveLabel("Save failed — retry");
      });
  }

  // Epic G2 (#42): reset a pin — a host-owned FORWARD edit clearing the override
  // (PATCH overrides.clear → recompute → version++ → new revision). The data model
  // and server contract are untouched; only WHERE this is triggered moved (the
  // eliminated Inspector → the relocated audit in Penny / the KPIs tab).
  function onResetPin(node: string, year: number) {
    pendingActorRef.current = { by: "user", reverted: false };
    setSaveLabel("Saving…");
    if (commentTarget && commentTarget.node === node && commentTarget.year === year) {
      setCommentTarget(null);
    }
    doPatch({ overrides: { clear: [{ node, year }] } }, version)
      .then(() => setSaveLabel("All changes saved"))
      .catch((err) => {
        if (err instanceof PatchConflictError) setConflict(err.conflict);
        else setSaveLabel("Save failed — retry");
      });
  }

  // Slide Penny OUT with the focused "why did you override {node} {year}?" prompt for
  // a specific pin. Opening the drawer is the whole point (decision #42): the comment
  // is captured in Penny, not a standalone inspector.
  function openComment(node: string, year: number) {
    const base = vm?.rows.find((r) => r.node === node)?.label ?? prettyNode(node);
    setCommentTarget({ node, year, label: `${base}, Year ${year}` });
    setPennyOpen(true);
  }

  // Persist the justification ONTO the override exactly as today: re-pin the SAME
  // value with the note via the EXISTING overrides.set contract ({node,year,value,
  // note}). No data-model change — only the capture surface moved into Penny. The
  // stored note travels into the board packet on the next export (server-side).
  function onCommentOverride(node: string, year: number, note: string) {
    const ov = (vm?.overrides ?? []).find((o) => o.node === node && o.year === year);
    if (!ov) return;
    setCommentTarget(null);
    pendingActorRef.current = { by: "user", reverted: false };
    setSaveLabel("Saving…");
    doPatch(
      { overrides: { set: [{ node, year, value: String(ov.value.raw), note }] } },
      version,
    )
      .then(() => setSaveLabel("All changes saved"))
      .catch((err) => {
        if (err instanceof PatchConflictError) setConflict(err.conflict);
        else setSaveLabel("Save failed — retry");
      });
  }

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

  // Re-read the stored snapshot after Penny applies an edit (server-side, inside
  // the tool-use loop's normal PATCH/If-Match path). This is the ONLY way a
  // decision-metric delta reaches the screen — the client never streams a number
  // (Spec B §2/§5.1). It also re-syncs `version` so a later manual autosave carries
  // the correct If-Match.
  function refreshViewModel() {
    // The next vm settle is a Penny-applied edit (PE7 attribution).
    pendingActorRef.current = { by: "penny", reverted: false };
    void fetchProjection(slug)
      .then((data) => {
        setVm(data);
        setVersion(data.version);
        setName(data.name);
      })
      .catch(() => {
        /* a transient read failure leaves the prior snapshot in place */
      });
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
    // A manual settings edit (PE7 attribution: actor user).
    pendingActorRef.current = { by: "user", reverted: false };
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
      {/* Subtle back-nav to the owner's projections list (route "/"). A real
          anchor (keyboard-focusable, right-click/new-tab works); a plain left
          click SPA-navigates via goHome so there is no full reload. */}
      <a
        href="/"
        data-testid="back-to-projections"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          goHome();
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.25rem",
          margin: "0 0 0.75rem",
          fontSize: "0.8125rem",
          color: "var(--text-muted)",
          textDecoration: "none",
        }}
      >
        <span aria-hidden="true">←</span> Back to projections
      </a>

      {/* Page header (D1): the projection name (h1) with an inline pencil-to-rename
          in edit mode, the address (muted), the updated date, then the 4-cell metric
          bar — all on the LEFT; the trade-area map in the upper-RIGHT as a roughly
          square box. The header/metric-bar/map/downloads sit OUTSIDE the tab panels
          so toggling Projection ↔ KPIs re-renders only the panel (D13). */}
      <div className="detail__header">
        <div className="detail__header-main">
          <div className="detail__title-row">
            {/* #203 — a visible top-level page heading naming the projection (WCAG
                1.3.1 / 2.4.6). */}
            <h1 className="detail__name-heading">
              {(name || vm.name || "").trim() || "Thrift store projection"}
            </h1>
            {edit && !renaming && (
              <button
                type="button"
                className="detail__rename-btn"
                data-testid="rename-projection"
                aria-label="Rename projection"
                onClick={() => setRenaming(true)}
              >
                <span aria-hidden="true">✎</span>
              </button>
            )}
            {edit && renaming && (
              <input
                className="detail__name-input"
                aria-label="Store name"
                value={name}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onChange={(e) => onNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape") setRenaming(false);
                }}
                onBlur={() => setRenaming(false)}
              />
            )}

            {/* D9: the .xlsx + .docx downloads live at the TOP, next to the name.
                EPIC SHARE: the unified Share control sits alongside them (Decision 12). */}
            <div className="detail__downloads" data-testid="detail-downloads">
              <a
                className="btn btn--download"
                role="button"
                data-testid="download-xlsx"
                href={xlsxHref(slug)}
                download
              >
                <span aria-hidden="true" className="btn__icon">▦</span> Excel
              </a>
              <a
                className="btn btn--download"
                role="button"
                data-testid="download-docx"
                href={docxHref(slug)}
                download
              >
                <span aria-hidden="true" className="btn__icon">▤</span> Word
              </a>
              <button
                type="button"
                className="btn btn--download"
                data-testid="share-projection"
                aria-haspopup="dialog"
                onClick={() => setShareOpen(true)}
              >
                <span aria-hidden="true" className="btn__icon">↗</span> Share
              </button>
            </div>
          </div>

          {/* Address (muted) — the server's resolved formatted address. */}
          {vm.location?.formatted_address && (
            <p className="detail__address" data-testid="detail-address">
              {vm.location.formatted_address}
            </p>
          )}
          {/* Updated date — rendered ONLY when the server provides it (never a
              fabricated date). */}
          {updatedLabel(vm.updated_at) && (
            <p className="detail__updated" data-testid="detail-updated">
              {updatedLabel(vm.updated_at)}
            </p>
          )}

          {/* The 4-cell metric bar (D1). */}
          <MetricBar vm={vm} />
        </div>
        <div className="detail__map" data-testid="detail-map">
          <TradeAreaMap
            slug={slug}
            location={vm.location}
            basis={vm.trade_area?.basis}
            geography={vm.trade_area?.geography_name}
            size="detail"
          />
        </div>
      </div>

      {/* Detail content (#40/#41). The "Decision & 3-year projection" heading is
          GONE; the verdict no longer repeats here. The Projection panel = 3-year
          table (top) → high-level tiles → first-year cash-flow detail. The 2nd tile
          set (KpiStrip) + the Settings sliders live in the KPIs tab (edit). Read
          mode shows the projection then the KPIs inline (no Settings to merge). */}
      {(() => {
        const projection = (
          <ProjectionTab
            key={slug}
            vm={vm}
            recomputeStatus={edit ? saveLabel : ""}
            fieldChanges={fieldChanges}
            onEditCell={edit ? onEditCell : undefined}
            onUndoField={edit ? onUndoField : undefined}
          />
        );
        if (!edit) {
          return (
            <>
              {projection}
              <KpiStrip kpis={vm.kpis} />
            </>
          );
        }
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
              id="detail-panel-kpis"
              aria-labelledby="detail-tab-kpis"
              className="detail__panel"
              hidden={activeTab !== "kpis"}
            >
              {/* a11y: a section heading so the KPIs panel keeps the h1→h2 chain. */}
              <h2 className="detail__panel-heading">Key metrics &amp; settings</h2>
              {/* D11: the KPI strip + the settings sliders are MERGED into ONE compact
                  grid — derived KPIs read-only, drivers editable. D10: the standalone
                  "Pinned overrides" audit block is removed (override justification
                  lives in Penny's drawer). */}
              <div data-testid="settings-tab">
                <SettingsTab
                  kpis={vm.kpis}
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

      {/* Evidence / confidence — page level so it stays visible in both modes/tabs. */}
      <EvidencePanel evidence={vm.evidence ?? []} />

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

      {/* D8: the bottom Feedback button is REMOVED (app-suggestion lives only in the
          topbar). D9: the .xlsx/.docx downloads moved to the header (next to the
          name), so the bottom actions row is gone too. */}

      {conflict && (
        <SaveConflictModal
          onReload={resolveReload}
          onOverwrite={resolveOverwrite}
          onSaveAsCopy={resolveSaveAsCopy}
          message={conflict.message}
        />
      )}

      {/* EPIC SHARE (Decision 12): the unified Share panel. The read-only link is the
          view_slug URL (exports authorize by slug alone — recipients pull the .xlsx +
          .docx with no account). The editable link carries the edit token in the URL
          FRAGMENT only, and only when this device holds it. */}
      {shareOpen && (
        <ShareModal slug={slug} editToken={getEditToken(slug)} onClose={() => setShareOpen(false)} />
      )}

      {/* Penny — the LEFT slide-out assistant (apply-immediately + narrate, Spec B
          §2/§5.1). Mounted only in edit mode (her mutate path needs the owner/edit
          token); with ?ai=off she degrades to the muted Settings FAB (never a
          dead-end). Her applied edits flow back through onApplied → refreshViewModel,
          which the PE7 diff (above) surfaces as the per-field "recent change / was X
          / undo" affordance on the share cells. */}
      {/* Epic G2 (#42): the standalone right-edge Override Inspector is ELIMINATED.
          Penny is now the only side panel; she slides OUT (controlled open) to capture
          an override justification through the focused "why did you override …?" prompt
          and hosts the relocated audit (reset + add/edit justification). The note
          persists on the pin through the EXISTING overrides contract — no data-model or
          server-contract change — and travels into the packet exactly as today. */}
      {edit && (
        <PennyAssistant
          viewSlug={slug}
          token={token.current ?? ""}
          aiEnabled={!aiOff}
          settingsHref={`/p/${encodeURIComponent(slug)}/edit`}
          onApplied={() => refreshViewModel()}
          overrides={auditItems(vm)}
          onResetPin={onResetPin}
          onComment={openComment}
          commentTarget={commentTarget}
          commentInitial={
            commentTarget
              ? vm.overrides?.find(
                  (o) => o.node === commentTarget.node && o.year === commentTarget.year,
                )?.note ?? ""
              : ""
          }
          onSubmitComment={onCommentOverride}
          onCancelComment={() => setCommentTarget(null)}
          open={pennyOpen}
          onOpenChange={setPennyOpen}
        />
      )}
    </div>
  );
}

export default ProjectionDetail;
