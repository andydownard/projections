// web/src/api/feedback.ts — POST /api/feedback (API_SPEC §8.1, PRD §22).
//
// The client sends ONLY the description (+ optional title/email/type) and the
// redacted route. The server strips any slug/fragment and returns a random
// support_id. The client never sends a view_slug, token, or financial field.
//
// An idea is just a description: it carries NO title, so `title` is omitted from
// the body entirely (the server requires a title only for bug reports).

export interface FeedbackInput {
  description: string;
  /** Bug reports carry a title; an idea omits it. */
  title?: string;
  /** Optional reply-to address (server-only; never reaches GitHub). */
  email?: string;
  type?: "bug" | "idea";
  route?: string;
}

export interface FeedbackResponse {
  support_id: string;
  github_issue_url: string | null;
}

const BASE = "/api";

export async function submitFeedback(input: FeedbackInput): Promise<FeedbackResponse> {
  const resp = await fetch(`${BASE}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: input.type ?? "bug",
      // Omit `title` for an idea so the payload truly carries no title.
      ...(input.title !== undefined ? { title: input.title } : {}),
      description: input.description,
      ...(input.email ? { email: input.email } : {}),
      // Route is sent without a fragment; the server redacts the slug too.
      route: input.route ?? window.location.pathname,
    }),
  });
  if (!resp.ok) throw new Error(`feedback failed: ${resp.status}`);
  return (await resp.json()) as FeedbackResponse;
}
