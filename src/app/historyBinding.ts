/**
 * What an engine needs from the shell's step history (core/project/history.ts):
 * the tree to show, and the calls that record and move through it. The shell
 * owns the history; every engine (powder, single crystal, PDF) gets this one
 * binding and records steps at its own committed actions. The header's History
 * menu shows the tree from the same binding.
 */

import type { ProjectHistory, StepKind } from "@/core/project/history";

export interface HistoryBinding {
  readonly history: ProjectHistory | null;
  /**
   * Record the live state as a step now — call it before a refinement, so the
   * starting point (freed parameters, edited values, settings) is a step of
   * its own. A no-op when nothing changed since the current step.
   */
  readonly recordNow: (kind: StepKind, label?: string) => void;
  /** Record a step once the change just made has rendered (after a refinement). */
  readonly requestStep: (kind: StepKind, label?: string) => void;
  readonly goTo: (id: string) => void;
  readonly rename: (id: string, name: string) => void;
  /** Present when there is a step to go back / forward to. */
  readonly back?: () => void;
  readonly forward?: () => void;
}
