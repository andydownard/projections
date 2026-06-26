// web/src/components/TopBar.tsx — persistent top bar (M2.5 shell piece).
//
// The single, consistent header on every route: the Thriftly logo (links home),
// the product name, a SERVER-owned model-version chip, and an autosave-state dot.
// Renders the view-model; computes nothing. The version chip text comes from the
// server response (computed_json.model_version), never derived on the client, and
// only renders once a projection is loaded (no permanent "model —" placeholder).
import type { ReactNode } from "react";

import { ThriftlyLogo } from "./ThriftlyLogo";

export type SaveState = "saved" | "saving" | "error" | "idle";

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  error: "Save failed — retry",
  idle: "",
};

export interface TopBarProps {
  modelVersion?: string;
  saveState?: SaveState;
  children?: ReactNode;
}

export function TopBar({ modelVersion, saveState = "idle", children }: TopBarProps) {
  return (
    <header className="topbar" role="banner">
      <div className="topbar__inner">
        <a className="topbar__home" href="/" aria-label="Thriftly home">
          <ThriftlyLogo className="topbar__logo" />
        </a>
        <span className="topbar__brand">Thrift Store Projection</span>
        <span className="topbar__spacer" aria-hidden="true" />
        {modelVersion && (
          <span className="chip" data-testid="version-chip" aria-label="model version">
            {`model ${modelVersion}`}
          </span>
        )}
        {saveState !== "idle" && (
          <span
            className="chip"
            data-testid="save-label"
            role="status"
            aria-live="polite"
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
        {children}
      </div>
    </header>
  );
}
