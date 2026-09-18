/**
 * The bundled demos — one converged (or self-consistent) snapshot per workflow,
 * offered in the header's Demos menu and on the landing page. One list, one id
 * type, so adding a demo is one entry here plus its loader in the shell.
 */

export type DemoId = "rietveld" | "pdf" | "magnetic";

export interface DemoEntry {
  readonly id: DemoId;
  /** Needs files from the git-ignored data folder (dev server only): offered
   *  only when they are reachable, never in the public build. */
  readonly local?: boolean;
  /** Header menu label. */
  readonly label: string;
  /** Landing card: kicker (workflow), title (material), blurb (what opens). */
  readonly kicker: string;
  readonly title: string;
  readonly blurb: string;
}

export const DEMOS: readonly DemoEntry[] = [
  {
    id: "rietveld",
    label: "Rietveld · Mn₃Ga neutron TOF",
    kicker: "Rietveld · reciprocal space",
    title: "Mn₃Ga neutron TOF",
    blurb: "Two-phase POWGEN fit at 600 K (paramagnetic, with a MnO impurity) · wR 3.9%",
  },
  {
    id: "magnetic",
    local: true,
    label: "Magnetic · AWO₄ neutron TOF 6 K (k = ½ 0 0) · local data",
    kicker: "Magnetic · k ≠ 0 antiferromagnet · local data",
    title: "AWO₄ neutron TOF 6 K",
    blurb: "High-entropy tungstate on POWGEN data from the local data folder · k = (½ 0 0), P2/c′ · opens on the magnetic page with the group selected · wR 7.4%",
  },
  {
    id: "pdf",
    label: "PDF · GaTa₄Se₈ X-ray G(r)",
    kicker: "PDF · real space",
    title: "GaTa₄Se₈ X-ray G(r)",
    blurb: "Synchrotron total-scattering fit at 299 K · Rw 8.1%",
  },
];
