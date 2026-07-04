// web/src/components/ShareModal.test.tsx — the unified Share affordance (EPIC SHARE).
//
// Decision 12: a read-only deep link (view_slug) AND an editable link (edit token in
// the URL FRAGMENT). Hard rules under test:
//   • the read-only link is the /p/<slug> view_slug URL (no token),
//   • the editable link carries the edit token in the FRAGMENT (#…), never the path
//     or query (Regression #10 — secret in URL path/query/log),
//   • copy → useToast("Link copied"),
//   • absent edit token ⇒ no editable link is shown and no token is fabricated,
//   • the owner token is NEVER surfaced.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShareModal } from "./ShareModal";
import { ToastProvider } from "./Toast";

function renderModal(props: { slug: string; editToken: string | null; onClose?: () => void }) {
  return render(
    <ToastProvider>
      <ShareModal slug={props.slug} editToken={props.editToken} onClose={props.onClose ?? (() => {})} />
    </ToastProvider>,
  );
}

let writeText: ReturnType<typeof vi.fn>;

/** Install a fresh clipboard spy. user-event's setup() also stubs the clipboard, so
 *  the copy tests re-install this AFTER setup() to capture the component's write. */
function installClipboard() {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installClipboard();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ShareModal — links", () => {
  it("renders the read-only view_slug link (no token in it)", () => {
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    const link = screen.getByTestId("share-readonly-link") as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/p/p_8x`);
    // The read-only link never carries the edit token.
    expect(link.value).not.toContain("edit_secret");
  });

  it("renders the editable link with the edit token in the FRAGMENT, not the path/query", () => {
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    const link = screen.getByTestId("share-edit-link") as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/p/p_8x/edit#edit_secret`);
    // Regression #10: the secret rides the fragment ONLY — never the path or query.
    const url = new URL(link.value);
    expect(url.hash).toBe("#edit_secret");
    expect(url.pathname).not.toContain("edit_secret");
    expect(url.search).toBe("");
  });

  it("hides the editable link and shows an unavailable note when no edit token is held", () => {
    renderModal({ slug: "p_8x", editToken: null });
    expect(screen.queryByTestId("share-edit-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-edit-unavailable")).toBeInTheDocument();
    // The read-only link is still offered.
    expect(screen.getByTestId("share-readonly-link")).toBeInTheDocument();
  });
});

describe("ShareModal — copy", () => {
  it("copies the read-only link and toasts on success", async () => {
    const user = userEvent.setup();
    installClipboard(); // override user-event's own clipboard stub
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    await user.click(screen.getByTestId("share-copy-readonly"));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/p_8x`);
    expect(await screen.findByTestId("toast")).toHaveTextContent(/link copied/i);
  });

  it("copies the editable (fragment) link and toasts on success", async () => {
    const user = userEvent.setup();
    installClipboard(); // override user-event's own clipboard stub
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    await user.click(screen.getByTestId("share-copy-edit"));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/p_8x/edit#edit_secret`);
    expect(await screen.findByTestId("toast")).toHaveTextContent(/link copied/i);
  });
});

describe("ShareModal — a11y + dismissal", () => {
  it("is a labelled modal dialog", () => {
    renderModal({ slug: "p_8x", editToken: null });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/share/i);
  });

  it("closes on the Close button", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal({ slug: "p_8x", editToken: null, onClose });
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("never renders the owner token", () => {
    localStorage.setItem("projections.owner_token", "OWNER-SUPER-SECRET");
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    expect(document.body.textContent).not.toContain("OWNER-SUPER-SECRET");
    localStorage.clear();
  });
});

// Guard against a clipboard-less environment: copy must not throw; it should still
// announce. (Older browsers / insecure contexts have no navigator.clipboard.)
describe("ShareModal — clipboard fallback", () => {
  it("does not throw when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const user = userEvent.setup();
    renderModal({ slug: "p_8x", editToken: null });
    await user.click(screen.getByTestId("share-copy-readonly"));
    await waitFor(() => expect(screen.getByTestId("toast")).toBeInTheDocument());
  });
});

// Audit P2 (honesty): "Link copied" must mean the write actually reached the
// clipboard. Previously the toast fired even when navigator.clipboard.writeText
// REJECTED (a denied permission / insecure context edge case) — a false claim of
// success. A rejected write now renders an inline manual-copy hint instead.
describe("ShareModal — copy honesty (rejects don't lie)", () => {
  function installRejectingClipboard() {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard write denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    return writeText;
  }

  it("does not toast on a rejected read-only copy; shows a manual-copy hint instead", async () => {
    const user = userEvent.setup();
    const writeText = installRejectingClipboard();
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    await user.click(screen.getByTestId("share-copy-readonly"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByTestId("share-copy-readonly-manual")).toHaveTextContent(
      /press ctrl\+c to copy/i,
    );
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("does not toast on a rejected editable-link copy; shows a manual-copy hint instead", async () => {
    const user = userEvent.setup();
    const writeText = installRejectingClipboard();
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    await user.click(screen.getByTestId("share-copy-edit"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByTestId("share-copy-edit-manual")).toHaveTextContent(
      /press ctrl\+c to copy/i,
    );
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("clears the manual-copy hint once a later copy of the same link succeeds", async () => {
    const user = userEvent.setup();
    installRejectingClipboard();
    renderModal({ slug: "p_8x", editToken: "edit_secret" });
    await user.click(screen.getByTestId("share-copy-readonly"));
    await screen.findByTestId("share-copy-readonly-manual");
    installClipboard(); // re-install a resolving clipboard
    await user.click(screen.getByTestId("share-copy-readonly"));
    await screen.findByTestId("toast");
    expect(screen.queryByTestId("share-copy-readonly-manual")).not.toBeInTheDocument();
  });
});
