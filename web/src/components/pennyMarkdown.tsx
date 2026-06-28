// web/src/components/pennyMarkdown.tsx — render Penny's assistant Markdown as a
// SAFE, allowlisted subset of React elements (NO raw HTML, ever).
//
// SECURITY (CLAUDE.md "No raw HTML" / SECURITY.md §5): Penny's replies reach the
// DOM, and the owner bearer token lives in localStorage — a single rendered XSS =
// token theft = full projection takeover. This renderer NEVER parses or injects
// HTML and NEVER uses `dangerouslySetInnerHTML`. It recognizes a tiny Markdown
// subset (bold, italic, inline code, fenced code, bullet/numbered lists,
// paragraphs, links) and emits React elements; every other character — including a
// literal `<script>` a reply might contain — becomes an ESCAPED text node by
// construction (React escapes all string children). Links carry a strict scheme
// allowlist (http/https/mailto); any other scheme renders as inert text.
//
// It computes/derives NOTHING from numbers — it only FORMATS the server's final,
// already-grounded prose (CLAUDE.md: the server is the one math + formatting
// authority), a presentation effect that never invents or reshapes a figure.
import type { CSSProperties, ReactNode } from "react";

/** Only these URL schemes survive on a link; anything else is defanged to text. */
const ALLOWED_LINK_SCHEME = /^(?:https?:|mailto:)/i;

// Inline tokens, tried in order so bold (`**`/`__`) wins over italic (`*`/`_`).
const INLINE_RE =
  /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|`([^`]+?)`|\[([^\]]+?)\]\(([^)\s]+?)\)|\*([^*]+?)\*|_([^_]+?)_/;

const inlineCodeStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: "0.9em",
  background: "var(--surface, #eceeec)",
  borderRadius: "4px",
  padding: "0.05rem 0.3rem",
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: "0.5rem 0.625rem",
  background: "var(--surface, #eceeec)",
  borderRadius: "8px",
  overflowX: "auto",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: "0.85em",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const paragraphStyle: CSSProperties = { margin: 0 };
const listStyle: CSSProperties = { margin: 0, paddingInlineStart: "1.25rem" };
const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

/** Render inline Markdown (bold/italic/code/links) within a single block of text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[1], key)}</strong>);
    } else if (m[2] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[2], key)}</strong>);
    } else if (m[3] !== undefined) {
      // Inline code is literal — never re-parsed for nested markers.
      out.push(
        <code key={key} style={inlineCodeStyle}>
          {m[3]}
        </code>,
      );
    } else if (m[4] !== undefined) {
      const label = m[4];
      const href = m[5];
      if (ALLOWED_LINK_SCHEME.test(href)) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {label}
          </a>,
        );
      } else {
        // Defang an unsafe scheme (javascript:/data:/…): keep the text, drop the URL.
        out.push(label);
      }
    } else if (m[6] !== undefined) {
      out.push(<em key={key}>{renderInline(m[6], key)}</em>);
    } else if (m[7] !== undefined) {
      out.push(<em key={key}>{renderInline(m[7], key)}</em>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const BULLET_RE = /^\s*[-*+]\s+/;
const ORDERED_RE = /^\s*\d+\.\s+/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*```/;

/**
 * Render Penny's assistant Markdown as a SAFE subset of React elements. Returns
 * `null` for empty input. No raw HTML is ever produced — see the file header.
 */
export function renderMarkdown(text: string): ReactNode {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line → block separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block.
    if (FENCE_RE.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      blocks.push(
        <pre key={key++} style={preStyle}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Unordered list.
    if (BULLET_RE.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        const itemText = lines[i].replace(BULLET_RE, "");
        const liKey = `ul-${key}-${items.length}`;
        items.push(<li key={liKey}>{renderInline(itemText, liKey)}</li>);
        i++;
      }
      blocks.push(
        <ul key={key++} style={listStyle}>
          {items}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (ORDERED_RE.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && ORDERED_RE.test(lines[i])) {
        const itemText = lines[i].replace(ORDERED_RE, "");
        const liKey = `ol-${key}-${items.length}`;
        items.push(<li key={liKey}>{renderInline(itemText, liKey)}</li>);
        i++;
      }
      blocks.push(
        <ol key={key++} style={listStyle}>
          {items}
        </ol>,
      );
      continue;
    }

    // Heading → a bold paragraph (kept at body size; no oversized <h1>).
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const hKey = `h-${key}`;
      blocks.push(
        <p key={key++} style={paragraphStyle}>
          <strong>{renderInline(heading[2], hKey)}</strong>
        </p>,
      );
      i++;
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !BULLET_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const pKey = `p-${key}`;
    blocks.push(
      <p key={key++} style={paragraphStyle}>
        {renderInline(para.join(" "), pKey)}
      </p>,
    );
  }

  if (blocks.length === 0) return null;
  return <div style={rootStyle}>{blocks}</div>;
}

/**
 * Strip Markdown markers to readable plain text for the typewriter reveal phase
 * (cosmetic only — the settled render uses {@link renderMarkdown}). Keeps bullets
 * as a "• " prefix so the typing pass reads naturally.
 */
export function markdownToPlainText(md: string): string {
  return (md ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/```([\s\S]*?)```/g, (_m, code: string) => code)
    .replace(/`([^`]+?)`/g, "$1")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    .replace(/\*([^*]+?)\*/g, "$1")
    .replace(/_([^_]+?)_/g, "$1")
    .replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
