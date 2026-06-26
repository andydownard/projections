// web/src/components/TopBar.tsx — persistent top bar (M2.5 shell piece).
//
// Logo, product name, a SERVER-owned model-version chip, and an autosave-state dot.
// Renders the view-model; computes nothing. The version chip text comes from the
// server response (computed_json.model_version), never derived on the client.
import type { ReactNode } from "react";

import { SAVE_LABEL, type SaveState } from "../state/saveLabels";

export type { SaveState };

export interface TopBarProps {
  modelVersion?: string;
  saveState?: SaveState;
  children?: ReactNode;
}

export function TopBar({ modelVersion, saveState = "idle", children }: TopBarProps) {
  return (
    <header className="topbar" role="banner">
      <span className="topbar__brand">Thrift Store Projection</span>
      <span className="chip" data-testid="version-chip" aria-label="model version">
        {modelVersion ? `model ${modelVersion}` : "model —"}
      </span>
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
    </header>
  );
}

export default TopBar;
