// web/src/api/feedback.ts — POST /api/feedback (API_SPEC §8.1, PRD §22).
//
// The client sends ONLY the title/description/type + the redacted route. The
// server strips any slug/fragment and returns a random support_id. The client
// never sends a view_slug, token, or financial field in the body.

export interface FeedbackInput {
  title: string;
  description: string;
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
      title: input.title,
      description: input.description,
      // Route is sent without a fragment; the server redacts the slug too.
      route: input.route ?? window.location.pathname,
    }),
  });
  if (!resp.ok) throw new Error(`feedback failed: ${resp.status}`);
  return (await resp.json()) as FeedbackResponse;
}
