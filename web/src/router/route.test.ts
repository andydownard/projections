import { describe, expect, it } from "vitest";

import { parseRoute, readFragmentSecret } from "./route";

describe("parseRoute", () => {
  it("maps / to home", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
  });

  it("maps bare /wizard to the wizard with no specific step (redirect target)", () => {
    expect(parseRoute("/wizard")).toEqual({ kind: "wizard", aiOff: false, step: null });
    expect(parseRoute("/wizard/")).toEqual({ kind: "wizard", aiOff: false, step: null });
    expect(parseRoute("/wizard", "?ai=off")).toEqual({
      kind: "wizard",
      aiOff: true,
      step: null,
    });
  });

  it("maps /wizard/<step-slug> to that wizard step (Epic B #261)", () => {
    expect(parseRoute("/wizard/store")).toEqual({
      kind: "wizard",
      aiOff: false,
      step: "store",
    });
    expect(parseRoute("/wizard/trade-area")).toEqual({
      kind: "wizard",
      aiOff: false,
      step: "trade-area",
    });
    expect(parseRoute("/wizard/review", "?ai=off")).toEqual({
      kind: "wizard",
      aiOff: true,
      step: "review",
    });
  });

  it("treats an unknown wizard step slug as null (caller redirects to a valid step)", () => {
    expect(parseRoute("/wizard/bogus")).toEqual({
      kind: "wizard",
      aiOff: false,
      step: null,
    });
    expect(parseRoute("/wizard/42")).toEqual({ kind: "wizard", aiOff: false, step: null });
  });

  it("maps /p/<slug> to a read-only detail", () => {
    expect(parseRoute("/p/example")).toEqual({
      kind: "detail",
      slug: "example",
      edit: false,
      aiOff: false,
    });
  });

  it("maps /p/<slug>/edit to an editable detail", () => {
    expect(parseRoute("/p/example/edit")).toEqual({
      kind: "detail",
      slug: "example",
      edit: true,
      aiOff: false,
    });
  });

  it("threads ai=off into the detail route", () => {
    const r = parseRoute("/p/example", "?ai=off");
    expect(r).toMatchObject({ kind: "detail", aiOff: true });
  });

  it("maps /r/<slug> to a role view", () => {
    expect(parseRoute("/r/board-slug")).toEqual({ kind: "role", slug: "board-slug" });
  });

  it("falls back to notfound", () => {
    expect(parseRoute("/nope")).toEqual({ kind: "notfound" });
  });
});

describe("readFragmentSecret", () => {
  it("extracts the fragment secret", () => {
    expect(readFragmentSecret("#edit-secret")).toBe("edit-secret");
  });
  it("returns null for an empty fragment", () => {
    expect(readFragmentSecret("")).toBeNull();
    expect(readFragmentSecret("#")).toBeNull();
  });
});
