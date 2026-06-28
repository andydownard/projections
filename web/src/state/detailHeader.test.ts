// web/src/state/detailHeader.test.ts — the detail→shell header bridge (#150).
//
// The detail page publishes its autosave state to a tiny external store; the
// shell reads it to render the (detail-only) save chip. The model version is no
// longer published or displayed (#38). Starts empty (no chip), publishes save
// state, and resets to empty.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearDetailHeader, setDetailHeader, useDetailHeader } from "./detailHeader";

afterEach(() => {
  act(() => clearDetailHeader());
});

describe("detailHeader store", () => {
  it("starts empty so the shell renders no chip", () => {
    const { result } = renderHook(() => useDetailHeader());
    expect(result.current.saveState).toBe("idle");
  });

  it("publishes the save state to subscribers", () => {
    const { result } = renderHook(() => useDetailHeader());
    act(() => setDetailHeader({ saveState: "saving" }));
    expect(result.current.saveState).toBe("saving");
  });

  it("resets to empty on clear (no chip leaks onto other routes)", () => {
    const { result } = renderHook(() => useDetailHeader());
    act(() => setDetailHeader({ saveState: "saved" }));
    act(() => clearDetailHeader());
    expect(result.current.saveState).toBe("idle");
  });
});
