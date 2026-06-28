import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { markdownToPlainText, renderMarkdown } from "./pennyMarkdown";

function renderMd(md: string) {
  return render(<div data-testid="md">{renderMarkdown(md)}</div>);
}

describe("renderMarkdown", () => {
  it("renders **bold** as a real <strong>, not literal asterisks", () => {
    renderMd("Set the **input** value.");
    expect(screen.getByText("input").tagName).toBe("STRONG");
    expect(screen.getByTestId("md").textContent).not.toContain("**");
  });

  it("renders *italic* as <em>", () => {
    renderMd("That is *important*.");
    expect(screen.getByText("important").tagName).toBe("EM");
  });

  it("renders hyphen bullets as a <ul> of <li>", () => {
    renderMd("- first\n- second");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].closest("ul")).not.toBeNull();
    expect(screen.getByTestId("md").textContent).not.toMatch(/(^|\n)-\s/);
  });

  it("renders numbered lists as an <ol>", () => {
    renderMd("1. one\n2. two");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("one").closest("ol")).not.toBeNull();
  });

  it("renders inline `code` as <code>", () => {
    renderMd("Use the `payroll` node.");
    expect(screen.getByText("payroll").tagName).toBe("CODE");
  });

  it("splits blank-line-separated paragraphs", () => {
    renderMd("First para.\n\nSecond para.");
    expect(screen.getByText("First para.").tagName).toBe("P");
    expect(screen.getByText("Second para.").tagName).toBe("P");
  });

  it("NEVER injects raw HTML — a <script>/<img onerror> payload is inert text", () => {
    renderMd('Hi <script>alert(document.cookie)</script> <img src=x onerror=alert(1)>');
    const root = screen.getByTestId("md");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    // The dangerous markup survives only as escaped, inert text.
    expect(root.textContent).toContain("<script>");
  });

  it("allows http(s) links but DEFANGS a javascript: URL to text", () => {
    renderMd("See [ok](https://example.com) and [bad](javascript:alert(1))");
    const ok = screen.getByRole("link", { name: "ok" });
    expect(ok).toHaveAttribute("href", "https://example.com");
    expect(ok.getAttribute("rel")).toContain("noopener");
    // The javascript: link renders as plain text with NO anchor.
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(renderMarkdown("")).toBeNull();
  });
});

describe("markdownToPlainText", () => {
  it("strips inline markers for the typewriter phase", () => {
    expect(markdownToPlainText("Set the **input** value")).toBe("Set the input value");
    expect(markdownToPlainText("Use `code` now")).toBe("Use code now");
  });

  it("turns bullets into a readable plain line", () => {
    expect(markdownToPlainText("- a\n- b")).toContain("• a");
  });
});
