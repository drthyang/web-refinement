/** Thin status strip below the header: blue dot, STATUS label, live message. */

import type { CSSProperties } from "react";
import { color } from "@/app/theme";

export function StatusBar({ message }: { message: string }): JSX.Element {
  return (
    <div style={bar}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color.primary, flex: "none" }} />
      <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.09em", color: color.faint }}>STATUS</span>
      <span style={{ color: color.ink }}>{message}</span>
    </div>
  );
}

const bar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 24px",
  borderBottom: `1px solid ${color.border}`,
  background: color.muted,
  fontSize: 12,
  color: color.secondary,
};
