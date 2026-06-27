// web/src/state/detailHeader.test.ts — the detail→shell header bridge (#150).
//
// The detail page publishes the server-owned model version + autosave state to a
// tiny external store; the shell reads it to render the (detail-only) TopBar
// chips. Starts empty (no chip), merges partial updates, and resets to empty.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearDetailHeader, setDetailHeader, useDetailHeader } from "./detailHeader";

afterEach(() => {
  act(() => clearDetailHeader());
});

describe("detailHeader store", () => {
  it("starts empty so the shell renders no chip", () => {
    const { result } = renderHook(() => useDetailHeader());
    expect(result.current.modelVersion).toBeUndefined();
    expect(result.current.saveState).toBe("idle");
  });

  it("publishes the server model version + save state to subscribers", () => {
    const { result } = renderHook(() => useDetailHeader());
    act(() => setDetailHeader({ modelVersion: "2.1.0" }));
    expect(result.current.modelVersion).toBe("2.1.0");
    act(() => setDetailHeader({ saveState: "saving" }));
    expect(result.current.saveState).toBe("saving");
    // A partial update never clobbers the other field.
    expect(result.current.modelVersion).toBe("2.1.0");
  });

  it("resets to empty on clear (no chip leaks onto other routes)", () => {
    const { result } = renderHook(() => useDetailHeader());
    act(() => setDetailHeader({ modelVersion: "9.9.9", saveState: "saved" }));
    act(() => clearDetailHeader());
    expect(result.current.modelVersion).toBeUndefined();
    expect(result.current.saveState).toBe("idle");
  });
});
