// web/src/components/NarrativeCanvas.tsx — epic-N N7: inline narrative editor.
//
// An inline editor OVER the rendered (server-sanitized) markdown prose that backs
// the board packet (API_SPEC §6.1). The editing surface is deliberately minimal:
// a toolbar of exactly bold / italic / list / link — the SAME tag set the server
// bleach allowlist keeps (strong, em, ul-li, a). No raw-HTML / image / heading
// escape hatch reaches the wire; the server re-sanitizes on PUT regardless
// (defense in depth — stored XSS = localStorage token theft, SECURITY.md §5).
//
// States (data-state): clean -> edited (hand-edited) -> stale (computed_json
// moved under it) -> regenerating. Staleness shows the server's was->now diff and
// a Regenerate action and NEVER auto-overwrites the user's prose (PRD §17).
//
// A11y: the whole surface is a labelled role=region; a polite aria-live status
// announces saves + decision (stale/regenerating) changes; Esc blurs the editor
// WITHOUT discarding the edit; the toolbar is a role=toolbar with labelled
// buttons; motion is gated behind prefers-reduced-motion in CSS.
//
// The PUT/If-Match autosave + the regenerate POST live in the API client and are
// injected as onSave/onRegenerate so this component stays presentation + a11y.
import { useEffect, useRef, useState } from "react";

import type { Narrative } from "../api/narrative";

export interface NarrativeCanvasProps {
  narrative: Narrative;
  /** Persist the edited body_md (the client adds Authorization/If-Match). */
  onSave: (bodyMd: string) => void | Promise<void>;
  /** Regenerate from current computed_json (confirm-before-discard handled upstream). */
  onRegenerate: () => void | Promise<void>;
  /** True while a regenerate POST is in flight. */
  regenerating?: boolean;
}

type FormatCommand = "bold" | "italic" | "list" | "link";

// The toolbar is the bleach allowlist made visible: bold/italic/list/link only.
const TOOLBAR: { cmd: FormatCommand; label: string; glyph: string }[] = [
  { cmd: "bold", label: "Bold", glyph: "B" },
  { cmd: "italic", label: "Italic", glyph: "I" },
  { cmd: "list", label: "Bulleted list", glyph: "•" },
  { cmd: "link", label: "Link", glyph: "🔗" },
];

function deriveState(n: Narrative, regenerating: boolean | undefined): string {
  if (regenerating) return "regenerating";
  if (n.stale) return "stale";
  if (n.edited) return "edited";
  return "clean";
}

export function NarrativeCanvas({
  narrative,
  onSave,
  onRegenerate,
  regenerating,
}: NarrativeCanvasProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);
  const state = deriveState(narrative, regenerating);

  // Seed the editor with the server-sanitized prose. Re-seed only when the
  // stored body changes (never clobber an in-progress edit).
  useEffect(() => {
    if (editorRef.current && !dirty) {
      editorRef.current.innerHTML = narrative.body_md || "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrative.body_md]);

  function applyFormat(cmd: FormatCommand) {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    try {
      if (cmd === "bold") document.execCommand("bold");
      else if (cmd === "italic") document.execCommand("italic");
      else if (cmd === "list") document.execCommand("insertUnorderedList");
      else if (cmd === "link") {
        const href = window.prompt?.("Link URL (http/https/mailto only)") || "";
        if (href) document.execCommand("createLink", false, href);
      }
    } catch {
      /* execCommand is a no-op in jsdom; the real save still re-sanitizes. */
    }
    setDirty(true);
  }

  function settle() {
    const el = editorRef.current;
    if (!el) return;
    if (!dirty) return; // nothing changed -> never fire a (possibly empty) save
    setDirty(false);
    void onSave(el.innerHTML);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      // Esc BLURS — it must never discard the in-progress edit (N7).
      e.preventDefault();
      editorRef.current?.blur();
    }
  }

  // The polite status line announces saves + decision (stale/regenerating).
  let status = "";
  if (state === "regenerating") status = "Regenerating narrative…";
  else if (state === "stale") status = "Narrative is out of date.";
  else if (state === "edited") status = "Edited.";

  return (
    <section
      className="narrative-canvas"
      data-testid="narrative-canvas"
      data-state={state}
      role="region"
      aria-label="Narrative"
    >
      <div
        className="narrative-canvas__status sr-status"
        data-testid="narrative-save-status"
        role="status"
        aria-live="polite"
      >
        {status}
      </div>

      <div
        className="narrative-canvas__toolbar"
        role="toolbar"
        aria-label="Formatting"
      >
        {TOOLBAR.map((t) => (
          <button
            key={t.cmd}
            type="button"
            className="narrative-canvas__tool"
            aria-label={t.label}
            title={t.label}
            disabled={!!regenerating}
            onMouseDown={(e) => e.preventDefault() /* keep editor selection */}
            onClick={() => applyFormat(t.cmd)}
          >
            <span aria-hidden="true">{t.glyph}</span>
          </button>
        ))}
      </div>

      {narrative.stale && (
        <div
          className="narrative-canvas__stale"
          data-testid="narrative-stale-notice"
          role="status"
          aria-live="polite"
        >
          <p className="narrative-canvas__stale-headline">
            The figures moved since this narrative was written.
          </p>
          <ul className="narrative-canvas__stale-diff">
            {narrative.stale_diff.map((d, i) => (
              <li key={d.field ?? d.label ?? i}>
                <span className="narrative-canvas__field">
                  {d.label ?? d.field}
                </span>{" "}
                <span className="narrative-canvas__was">{d.was}</span>
                {" → "}
                <span className="narrative-canvas__now">{d.now}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="narrative-canvas__regenerate"
            onClick={() => void onRegenerate()}
            disabled={!!regenerating}
          >
            Regenerate
          </button>
        </div>
      )}

      <div
        ref={editorRef}
        className="narrative-canvas__editor"
        role="textbox"
        aria-label="Narrative prose"
        aria-multiline="true"
        contentEditable={!regenerating}
        suppressContentEditableWarning
        onInput={() => setDirty(true)}
        onBlur={settle}
        onKeyDown={onKeyDown}
      />

      <aside className="narrative-canvas__grounded" aria-label="Grounded figures">
        <h3 className="narrative-canvas__grounded-title">Grounded figures</h3>
        <ul data-testid="grounded-figures" className="narrative-canvas__grounded-list">
          {narrative.grounded_figures.map((g) => (
            <li key={`${g.raw}:${g.display}`}>
              {g.variants.map((v) => (
                <span key={v} className="narrative-canvas__figure">
                  {v}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}

export default NarrativeCanvas;
