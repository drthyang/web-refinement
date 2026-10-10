/**
 * The Agent port: what a refinement engine publishes so the Agent can read
 * the live analysis and take the same actions the page's own controls take.
 *
 * It follows the engine-exports pattern (app/workbenchEngine.ts): the mounted,
 * active engine writes a fresh port into a shell-owned ref on every render, so
 * a call always runs against the state on screen. The actions are the page's
 * own handlers — the Refine button and the Agent's `refine` are one function
 * — so a Agent action is indistinguishable from a click, and the step history
 * records it the same way (tagged `actor: "agent"` by the shell).
 *
 * The powder and PDF pages publish one. Single crystal keeps its state private
 * to the page until it gets its own.
 */

import type { MutableRefObject } from "react";
import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern, PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, RefinementOptions, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { MagneticModel } from "@/core/magnetic/types";
import type { BackgroundType } from "@/core/diffraction/background";
import type { MustrainModel, SiteTies } from "@/app/powderSpec";

/** The powder page as the Agent reads it — one render's state. */
export interface PowderLiveState {
  readonly structure: StructureModel;
  readonly extraPhases: readonly StructureModel[];
  /** Every phase with the current parameter values applied (primary first). */
  readonly refinedPhases: readonly StructureModel[];
  readonly pattern: PowderPattern;
  readonly parameters: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly profile: PowderProfile;
  readonly magnetic: MagneticModel | null;
  /** The last refinement's result; null before the first fit or after a model change. */
  readonly result: RefinementResult | null;
  /** The loaded instrument, or null when the page runs on the default one. */
  readonly instrument: InstrumentParameters | null;
  /** The fit window on the pattern's own axis; null = the whole pattern. */
  readonly fitRange: { readonly min: number; readonly max: number } | null;
  /** The pattern's full extent on its own axis. */
  readonly extent: { readonly min: number; readonly max: number };
  /** A refinement is running: wait for it, or cancel it, before acting. */
  readonly busy: boolean;
  /** A TOF pattern without a TOF profile is shown, not refined. */
  readonly viewOnly: boolean;
  /** Weighted profile R of the curves on screen (fraction), live. */
  readonly wR: number;
  readonly settings: {
    readonly backgroundTerms: number;
    readonly backgroundType: BackgroundType;
    readonly mustrain: MustrainModel;
    readonly anisotropicAdp: boolean;
    readonly siteTies: SiteTies;
  };
  /** The plotted curves (nuclear + any applied magnetic model), as fitted. */
  readonly curves: { readonly x: readonly number[]; readonly yObs: readonly number[]; readonly yCalc: readonly number[] };
  /** `curves.x` as d-spacings (Å); null when the axis cannot convert. */
  readonly d: readonly number[] | null;
  /** Points the fit uses: not excluded, inside the fit window. */
  readonly observationCount: number;
  /** Where the observed data came from (file name or demo). */
  readonly source: string;
}

/** What the powder page lets the Agent do. Each call is the page's own handler. */
export interface PowderAgentPort {
  readonly technique: "powder";
  readonly state: () => PowderLiveState;
  /** Free or fix parameters by id (the parameter panel's check boxes). */
  readonly setFixed: (changes: readonly { readonly id: string; readonly fixed: boolean }[]) => void;
  readonly setBackgroundTerms: (n: number) => void;
  readonly setBackgroundType: (type: BackgroundType) => void;
  readonly setMustrain: (model: MustrainModel) => void;
  readonly setAnisotropicAdp: (on: boolean) => void;
  /** The fit window on the pattern's own axis; null restores the whole pattern. */
  readonly setFitRange: (range: { readonly min: number; readonly max: number } | null) => void;
  /** The Refine button: a flat refinement of the freed parameters. Resolves to
   *  why it did not finish ("cancelled", "failed: …"), or null when it did. */
  readonly refine: () => Promise<string | null>;
  /** The Prefit / Escape-minimum button (prefit with no fit yet, escape after). */
  readonly thorough: () => Promise<string | null>;
  /** The Refine button's fit of the free set with these options, its result
   *  returned and never applied: with no iterations, the covariance at the
   *  current values (the correlation check, correlationCheck.ts). */
  readonly probe: (options: Partial<RefinementOptions>) => Promise<RefinementResult>;
  readonly cancel: () => void;
  /** Every parameter back to its starting value. */
  readonly reset: () => void;
}

/** The PDF page as the Agent reads it — one render's state. */
export interface PdfLiveState {
  /** The phases as fitted (primary first; in irreps mode the parent setting). */
  readonly phases: readonly StructureModel[];
  /** Every phase with the current parameter values applied (primary first). */
  readonly refinedPhases: readonly StructureModel[];
  readonly pattern: PdfPattern;
  readonly parameters: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  /** The last refinement's result; null before the first fit or after a model change. */
  readonly result: RefinementResult | null;
  /** The fit window over r (Å). The PDF page always fits a window. */
  readonly fitRange: { readonly min: number; readonly max: number };
  /** The window the page opens with (Reset range). */
  readonly defaultRange: { readonly min: number; readonly max: number };
  /** The data's full r extent (Å). */
  readonly extent: { readonly min: number; readonly max: number };
  /** A refinement, scan or posterior run is going: wait for it, or cancel it, before acting. */
  readonly busy: boolean;
  /** Rw over G(r) inside the window (fraction), live. Uniform weights: relative only. */
  readonly rw: number;
  /** The plotted curves (with any applied spin model), as fitted. */
  readonly curves: { readonly x: readonly number[]; readonly yObs: readonly number[]; readonly yCalc: readonly number[] };
  /** Points inside the fit window. */
  readonly observationCount: number;
  /** "atomic" (constrained coordinates) or "irreps" (symmetry-mode amplitudes). */
  readonly positionMode: "atomic" | "irreps";
  /** A spin model is part of the fit (mPDF co-refinement). */
  readonly spinModel: boolean;
  /** The page's own warnings (correlated-motion conflict, zero ADPs). */
  readonly warnings: readonly string[];
  readonly source: string;
}

/** What the PDF page lets the Agent do. Each call is the page's own handler. */
export interface PdfAgentPort {
  readonly technique: "pdf";
  readonly state: () => PdfLiveState;
  /** Free or fix parameters by id (the parameter panel's check boxes). */
  readonly setFixed: (changes: readonly { readonly id: string; readonly fixed: boolean }[]) => void;
  /** The fit window over r (Å); null restores the page's default window. */
  readonly setFitRange: (range: { readonly min: number; readonly max: number } | null) => void;
  /** The Refine button. Resolves to why it did not finish, or null when it did. */
  readonly refine: () => Promise<string | null>;
  /** The Prefit / Escape-minimum button (prefit with no fit yet, escape after). */
  readonly thorough: () => Promise<string | null>;
  /** The Refine button's fit with these options, returned and never applied (see PowderAgentPort). */
  readonly probe: (options: Partial<RefinementOptions>) => Promise<RefinementResult>;
  readonly cancel: () => void;
  /** Every parameter back to its starting value. */
  readonly reset: () => void;
}

/** Any engine's port, told apart by `technique`. */
export type AgentPort = PowderAgentPort | PdfAgentPort;

/** Any page's live state. */
export type LiveState = PowderLiveState | PdfLiveState;

/** The shell-owned ref an engine publishes its port into (null when unmounted or inactive). */
export type AgentPortRef = MutableRefObject<AgentPort | null>;
