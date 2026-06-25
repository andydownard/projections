import { describe, expect, it } from "vitest";

import { parseRoute, readFragmentSecret } from "./route";

describe("parseRoute", () => {
  it("maps / to home", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
  });

  it("maps /wizard and reads ai=off", () => {
    expect(parseRoute("/wizard")).toEqual({ kind: "wizard", aiOff: false });
    expect(parseRoute("/wizard", "?ai=off")).toEqual({ kind: "wizard", aiOff: true });
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
