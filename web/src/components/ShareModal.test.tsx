// web/src/components/ShareModal.test.tsx — the Share affordance (EPIC SHARE).
//
// This project has no authentication (owner decision, 2026-09-13): there is only
// one link — /p/<slug> — fully viewable and editable by anyone. Hard rules under
// test: the link is the plain /p/<slug> URL, copy → useToast("Link copied"), and a
// rejected/absent clipboard write never lies about success.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShareModal } from "./ShareModal";
import { ToastProvider } from "./Toast";

function renderModal(props: { slug: string; onClose?: () => void }) {
  return render(
    <ToastProvider>
      <ShareModal slug={props.slug} onClose={props.onClose ?? (() => {})} />
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

describe("ShareModal — link", () => {
  it("renders the plain view_slug link", () => {
    renderModal({ slug: "p_8x" });
    const link = screen.getByTestId("share-link") as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/p/p_8x`);
  });
});

describe("ShareModal — copy", () => {
  it("copies the link and toasts on success", async () => {
    const user = userEvent.setup();
    installClipboard(); // override user-event's own clipboard stub
    renderModal({ slug: "p_8x" });
    await user.click(screen.getByTestId("share-copy"));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/p_8x`);
    expect(await screen.findByTestId("toast")).toHaveTextContent(/link copied/i);
  });
});

describe("ShareModal — a11y + dismissal", () => {
  it("is a labelled modal dialog", () => {
    renderModal({ slug: "p_8x" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/share/i);
  });

  it("closes on the Close button", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal({ slug: "p_8x", onClose });
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

// Guard against a clipboard-less environment: copy must not throw — and it must
// NOT claim "Link copied" (nothing reached the clipboard; the field is merely
// selected for a manual copy). Same honesty rule as the reject path (3.5 review).
describe("ShareModal — clipboard fallback", () => {
  it("selects the field and shows the manual hint — never a copied toast — when navigator.clipboard is unavailable", async () => {
    // ORDER MATTERS: userEvent.setup() installs its own clipboard stub, which
    // silently re-defines navigator.clipboard and would route the click down the
    // Clipboard-API path (the pre-fix version of this test had that bug — it never
    // exercised the no-clipboard branch at all). Remove the API AFTER setup.
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    renderModal({ slug: "p_8x" });
    await user.click(screen.getByTestId("share-copy"));
    expect(await screen.findByText(/press ctrl\+c to copy/i)).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
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

  it("does not toast on a rejected copy; shows a manual-copy hint instead", async () => {
    const user = userEvent.setup();
    const writeText = installRejectingClipboard();
    renderModal({ slug: "p_8x" });
    await user.click(screen.getByTestId("share-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByTestId("share-copy-manual")).toHaveTextContent(
      /press ctrl\+c to copy/i,
    );
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("clears the manual-copy hint once a later copy succeeds", async () => {
    const user = userEvent.setup();
    installRejectingClipboard();
    renderModal({ slug: "p_8x" });
    await user.click(screen.getByTestId("share-copy"));
    await screen.findByTestId("share-copy-manual");
    installClipboard(); // re-install a resolving clipboard
    await user.click(screen.getByTestId("share-copy"));
    await screen.findByTestId("toast");
    expect(screen.queryByTestId("share-copy-manual")).not.toBeInTheDocument();
  });
});
