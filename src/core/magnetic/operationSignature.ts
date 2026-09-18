/**
 * Canonical signature of a magnetic (Shubnikov) operation set: the sorted,
 * de-duplicated `operationKey|θ` list. Two candidate groups with the same
 * signature are the same group in the same setting — the comparison the
 * magnetic page uses to recognise the session's applied model among its
 * candidates, and the report uses to reuse that candidate's label.
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import { operationKey } from "@/core/crystal/symmetry";

export function magneticOperationSignature(ops: readonly SymmetryOperation[]): string {
  return [...new Set(ops.map((o) => `${operationKey(o)}|${o.timeReversal ?? 1}`))].sort().join(" ");
}
