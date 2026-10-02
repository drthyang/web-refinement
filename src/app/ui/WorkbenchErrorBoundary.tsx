/**
 * Keeps a calculation error inside a workbench from unmounting the whole app.
 *
 * The core refuses to guess: an untabulated element or isotope, a space group
 * that fits several settings, a reflection list too large to enumerate — each
 * throws a clear error rather than computing something wrong. A workbench
 * evaluates its curves while rendering, so without a boundary such an error
 * blanks the page. This shows the message in place of the workbench until an
 * input changes (`resetKeys`), e.g. a different CIF or data file is loaded.
 */

import { Component, type CSSProperties, type ReactNode } from "react";
import { color as theme, space } from "@/app/theme";

interface Props {
  readonly children: ReactNode;
  /** A change in any of these (compared by identity) clears the error and
   *  renders the children again. */
  readonly resetKeys: readonly unknown[];
  /** Hidden workbenches render nothing on error. */
  readonly visible?: boolean;
  /** Offered as a way out, e.g. clearing the workbench. */
  readonly onClear?: () => void;
}

interface State {
  readonly error: Error | null;
  readonly keys: readonly unknown[];
}

const changed = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));

export class WorkbenchErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return changed(props.resetKeys, state.keys) ? { error: null, keys: props.resetKeys } : null;
  }

  override componentDidCatch(error: unknown): void {
    console.error("[status] calculation failed:", error);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.visible === false) return null;
    return (
      <main className="wb-main" style={{ flex: 1 }}>
        <div role="alert" style={panel}>
          <strong>This structure and data cannot be calculated.</strong>
          <span>{error.message}</span>
          {this.props.onClear && (
            <span>
              <button onClick={this.props.onClear} style={button}>Clear the workbench</button>
            </span>
          )}
        </div>
      </main>
    );
  }
}

const panel: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 8, margin: space.edge, padding: "12px 16px", fontSize: 13,
  lineHeight: 1.5, background: theme.warnBg, border: `1px solid ${theme.warnBorder}`, color: theme.warnInk, borderRadius: 6,
};
const button: CSSProperties = {
  border: `1px solid ${theme.warnBorder}`, background: "transparent", color: theme.warnInk, cursor: "pointer", fontSize: 12.5,
  padding: "4px 10px", borderRadius: 4,
};
