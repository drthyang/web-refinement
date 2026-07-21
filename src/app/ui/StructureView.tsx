/**
 * 3D crystal-structure viewer (static ball-and-stick). Adapted from the
 * rmc-phonon `CrystalViewer` — the phonon animation, eigenvectors, and capture
 * machinery are dropped; this shows the refined unit-cell contents.
 *
 * The asymmetric unit is expanded by the space-group operations, wrapped into
 * one cell, and boundary atoms (on a face/edge/corner) are duplicated so the
 * cell looks complete. Atoms are spheres coloured/sized by element, bonds are
 * covalent-radius cylinders, and the cell edges are drawn as a wireframe.
 *
 * Controls: bond-length labels, perspective vs orthographic projection, and an
 * a/b/c coordinate-axis triad. Interaction: drag to rotate, scroll to zoom.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { color as theme, mono as themeMono } from "@/app/theme";
import { covalentRadius, elementColor } from "@/app/ui/elementData";
import { buildCellAtoms, displayMoment, magneticSupercell, type MomentEntry } from "@/app/ui/cellModel";

const MAX_BOND_LABELS = 80; // labelling every bond of a big cell is unreadable
const MAX_ATOM_LABELS = 400; // ditto for atom labels in a large supercell

/** Material finish presets for the atom spheres (Phong highlight strength). */
const FINISHES = {
  matte: { shininess: 4, specular: 0x000000 },
  standard: { shininess: 60, specular: 0x222222 },
  glossy: { shininess: 140, specular: 0x666666 },
} as const;
type Finish = keyof typeof FINISHES;

/**
 * Render the legend swatches with the very same engine as the model: one lit
 * sphere per element, sharing the scene's `MeshPhongMaterial` (element colour +
 * the finish's shininess/specular) and its ambient + directional lights at the
 * same intensities. The result is the model's atom shrunk to legend size — not a
 * CSS look-alike — so it tracks the Finish and Light knobs exactly. Returns a map
 * element → PNG data URL. `gl` is reused across calls to avoid churning WebGL
 * contexts as the Light slider drags.
 */
function renderAtomSwatches(
  elements: readonly string[],
  finish: Finish,
  lightLevel: number,
  gl: { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement },
): Record<string, string> {
  const { renderer, canvas } = gl;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.85 * lightLevel));
  const dl = new THREE.DirectionalLight(0xffffff, 0.55 * lightLevel);
  dl.position.set(1, 1.5, 1); // same key-light direction as the main scene
  scene.add(dl);
  // Orthographic, straight-on view of a unit sphere with a hair of margin.
  const cam = new THREE.OrthographicCamera(-1.12, 1.12, 1.12, -1.12, -10, 10);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  const geo = new THREE.SphereGeometry(1, 48, 48);
  const { shininess, specular } = FINISHES[finish];
  const out: Record<string, string> = {};
  for (const el of elements) {
    const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(elementColor(el)), shininess, specular });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    renderer.render(scene, cam);
    out[el] = canvas.toDataURL();
    scene.remove(mesh);
    mat.dispose();
  }
  geo.dispose();
  return out;
}

/** Draw `text` to a canvas and wrap it in a camera-facing sprite (world-sized). */
function makeLabelSprite(text: string, worldHeight: number, colorCss: string): THREE.Sprite {
  const pad = 8;
  const font = 48;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${font}px sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = font + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx.font = `${font}px sans-serif`;
  ctx.fillStyle = colorCss;
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((worldHeight * w) / h, worldHeight, 1);
  return sprite;
}

/**
 * Builder for a set of solid arrows sharing one look: a cylinder shaft capped
 * by a cone head, both lit by the scene exactly like the atoms and bonds.
 *
 * This exists because `THREE.ArrowHelper` — the obvious choice — draws its
 * shaft with `LineBasicMaterial`, which WebGL rasterizes at a single device
 * pixel however close the camera gets. Against a lit sphere the stem reads as a
 * hairline (or disappears under the atom entirely); a mesh shaft has real
 * world-space thickness that zooms with everything else.
 *
 * Shaft and head are the SAME size for every arrow a builder makes: only the
 * length varies, so length alone carries the amplitude and the shortest arrow
 * of a pattern is still legible. Head length is capped at a fraction of a short
 * arrow so a small one keeps a shaft instead of collapsing to a bare cone.
 *
 * The unit geometries (radius 1, height 1, along +Y with the base at the
 * origin) and the material are built once per set and shared by every arrow —
 * N arrows cost N meshes, not N geometries.
 */
function arrowBuilder(opts: {
  readonly color: number;
  /** World-space shaft radius, shared across the set. */
  readonly shaftRadius: number;
  /** World-space head radius and length, shared across the set. */
  readonly headRadius: number;
  readonly headLength: number;
}): (dir: THREE.Vector3, origin: THREE.Vector3, length: number) => THREE.Object3D {
  const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, 16);
  shaftGeo.translate(0, 0.5, 0); // base at the origin, tip at +Y
  const headGeo = new THREE.ConeGeometry(1, 1, 20);
  headGeo.translate(0, 0.5, 0);
  const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(opts.color), shininess: 55, specular: 0x333333 });
  const Y0 = new THREE.Vector3(0, 1, 0);
  return (dir, origin, length) => {
    const head = Math.min(opts.headLength, length * 0.55);
    const shaft = Math.max(length - head, 1e-4);
    const group = new THREE.Group();
    const s = new THREE.Mesh(shaftGeo, mat);
    s.scale.set(opts.shaftRadius, shaft, opts.shaftRadius);
    group.add(s);
    const h = new THREE.Mesh(headGeo, mat);
    h.scale.set(opts.headRadius, head, opts.headRadius);
    h.position.y = shaft;
    group.add(h);
    group.position.copy(origin);
    group.quaternion.setFromUnitVectors(Y0, dir); // dir must be normalized
    return group;
  };
}

/** A download the host offers from the viewer's toolbar (see `exports`). */
export interface StructureExport {
  /** Format shown on the button, e.g. "CIF" or "mCIF". */
  readonly label: string;
  /** Tooltip — say exactly what the file will contain. */
  readonly title: string;
  /** Serialize and download. The host owns this: only it holds the refined
   *  parameters, their esds and the agreement factors the file should carry. */
  readonly run: () => void;
}

export interface StandardCellOverlay {
  /** Columns = standard-setting basis vectors in parent fractional coords. */
  readonly P: readonly (readonly number[])[];
  /** Cell origin in parent fractional coords. */
  readonly origin: Vec3;
  /** Short label drawn at the cell origin (e.g. the BNS symbol). */
  readonly label: string;
}

export function StructureView({
  structure,
  moments,
  propagation,
  magneticOperations,
  standardCell,
  displacements,
  exports,
  minCanvasHeight = 360,
}: {
  structure: StructureModel;
  /** Magnetic moment entries to overlay as arrows (one per site — or per split
   *  orbit when the magnetic group splits a site's crystallographic orbit).
   *  Build with `momentEntriesFrom(magneticModel)`. */
  moments?: readonly MomentEntry[];
  /** Propagation vector k — enables the magnetic-supercell view (moments modulated by cos 2π k·n). */
  propagation?: Vec3;
  /** θ-signed Shubnikov operations of the chosen magnetic group: arrows on
   *  symmetry-equivalent atoms honour time reversal (m′ = θ·det(R)·R·m).
   *  Absent ⇒ nuclear operations with θ = +1 (legacy). */
  magneticOperations?: readonly SymmetryOperation[];
  /** The selected magnetic group's standard-setting cell (present when its
   *  BNS identification needed a basis transformation) — drawn as an amber
   *  wireframe over the parent cell, toggleable. */
  standardCell?: StandardCellOverlay;
  /**
   * Per-site FRACTIONAL displacement field to overlay as green arrows — a
   * distortion-mode eigenvector (`DistortionMode.axes`). Displacements are
   * POLAR vectors: each symmetry copy's arrow is the site vector rotated by
   * its placing operation, d′ = R·d (no det(R), no time reversal — unlike
   * moments). Arrow lengths are relative (the pattern, not the amplitude).
   */
  displacements?: readonly { readonly siteLabel: string; readonly axis: Vec3 }[];
  /**
   * Downloads offered from the viewer's toolbar for the structure on screen —
   * normally a single CIF. Host-supplied descriptors rather than a flag, so the
   * viewer never has to know which flavour is being written: a magnetic page
   * hands it an mCIF (moment loop) under an "mCIF" label, and the PDF page will
   * hand it one carrying the mode displacements, with no change here.
   */
  exports?: readonly StructureExport[];
  /** Canvas minimum height (px) — hosts that stack panels below the viewer in
   *  a fixed-height card pass a smaller value so the layout can settle. */
  minCanvasHeight?: number;
}): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [showBondLengths, setShowBondLengths] = useState(false);
  const [showAtomLabels, setShowAtomLabels] = useState(false);
  const [perspective, setPerspective] = useState(false);
  const [showAxes, setShowAxes] = useState(true);
  // Which unit cell to show — mutually exclusive, never two frames at once:
  //  "atomic"   the parent nuclear cell,
  //  "super"    the magnetic supercell (only for a commensurate k > 1×1×1),
  //  "standard" the selected magnetic group's standard-setting (BNS) cell.
  // Defaults to the magnetic cell whenever one exists (see `cellView` below).
  const [cellChoice, setCellChoice] = useState<"atomic" | "super" | "standard">("super");
  const [lightLevel, setLightLevel] = useState(2);
  const [finish, setFinish] = useState<Finish>("glossy");

  // Legend swatches, rendered by the same WebGL engine as the model (see
  // renderAtomSwatches). A dedicated offscreen renderer is kept alive so the
  // Light slider can redraw them without spawning a new context each tick.
  const uniqueElements = useMemo(
    () => [...new Set(structure.sites.map((s) => s.element))],
    [structure],
  );
  const [atomSwatches, setAtomSwatches] = useState<Record<string, string>>({});
  const swatchGLRef = useRef<{ renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } | null>(null);

  // Keep the user's camera across scene rebuilds (overlay toggles, moment
  // edits); a fresh default framing only when the structure/cell/supercell
  // changes. Lights and materials live in refs so their knobs mutate the live
  // scene without any rebuild.
  const viewStateRef = useRef<{ key: string; pos: readonly number[]; target: readonly number[]; zoom: number } | null>(null);
  const lightsRef = useRef<{ ambient: THREE.AmbientLight; directional: THREE.DirectionalLight } | null>(null);
  const atomMatsRef = useRef<THREE.MeshPhongMaterial[]>([]);
  // Live camera/controls, so the a/b/c preset buttons can reorient the view
  // without a scene rebuild.
  const sceneRef = useRef<{
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    controls: OrbitControls;
    centerV: THREE.Vector3;
    span: number;
  } | null>(null);

  // Look straight down a crystallographic axis (a, b or c): swing the camera onto
  // that cell vector and set "up" to another axis so the projected cell sits
  // square. Orientation only — the current target and camera distance (and, for
  // orthographic, the zoom) are left untouched, so the view neither pans nor
  // rescales; the user keeps whatever zoom they had.
  const viewAlong = (axis: "a" | "b" | "c"): void => {
    const s = sceneRef.current;
    if (!s) return;
    const vec = (f: readonly [number, number, number]): THREE.Vector3 => {
      const c = fractionalToCartesian(structure.cell, f as unknown as Vec3);
      return new THREE.Vector3(c[0], c[1], c[2]);
    };
    const dir = (axis === "a" ? vec([1, 0, 0]) : axis === "b" ? vec([0, 1, 0]) : vec([0, 0, 1])).normalize();
    const up = (axis === "c" ? vec([0, 1, 0]) : vec([0, 0, 1])).normalize();
    const target = s.controls.target;
    const dist = s.camera.position.distanceTo(target) || s.span * 2.4;
    s.camera.up.copy(up);
    s.camera.position.copy(target).addScaledVector(dir, dist);
    s.camera.lookAt(target);
    s.controls.update();
  };

  // The magnetic supercell (> the atomic cell only for a non-zero commensurate k).
  const superK = useMemo<[number, number, number]>(
    () => (propagation ? magneticSupercell(propagation) : [1, 1, 1]),
    [propagation],
  );
  const canMagneticCell = superK[0] * superK[1] * superK[2] > 1;
  const hasStandardCell = !!standardCell;

  // The cells available to show, always including the atomic cell. Exactly one
  // is drawn at a time. The requested choice falls back to the best available
  // magnetic cell when it isn't offered (e.g. after switching groups).
  const cellOptions = useMemo<("atomic" | "super" | "standard")[]>(
    () => ["atomic", ...(canMagneticCell ? ["super" as const] : []), ...(hasStandardCell ? ["standard" as const] : [])],
    [canMagneticCell, hasStandardCell],
  );
  const cellView: "atomic" | "super" | "standard" = cellOptions.includes(cellChoice)
    ? cellChoice
    : canMagneticCell ? "super" : hasStandardCell ? "standard" : "atomic";

  const supercell: [number, number, number] = cellView === "super" ? superK : [1, 1, 1];
  const showParentCell = cellView !== "standard"; // hide the indigo box under the amber one
  const showStandardCell = cellView === "standard";

  // Populate the standard-setting cell (when shown) with the same crystal:
  // parent-lattice translates clipped to the region, exact k-phase moments. In
  // this mode the parent-cell atoms are suppressed so only the magnetic cell shows.
  const activeRegion = useMemo(
    () => (showStandardCell && standardCell ? { P: standardCell.P, origin: standardCell.origin } : undefined),
    [showStandardCell, standardCell],
  );

  const atoms = useMemo(
    () => buildCellAtoms(structure, supercell, magneticOperations, moments, activeRegion, cellView === "standard"),
    [structure, magneticOperations, moments, supercell[0], supercell[1], supercell[2], activeRegion, cellView], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Cartesian cell corners + centre + span, for edges and camera framing —
  // the frame covers the parent cell(s) plus the standard cell when shown.
  const { corners, center, span } = useMemo(() => {
    const [nx, ny, nz] = supercell;
    const c: Vec3[] = [];
    for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
      c.push(fractionalToCartesian(structure.cell, [i * nx, j * ny, k * nz]));
    }
    const framePts: Vec3[] = [...c];
    if (activeRegion) {
      for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
        const frac: Vec3 = [
          activeRegion.origin[0]! + i * activeRegion.P[0]![0]! + j * activeRegion.P[0]![1]! + k * activeRegion.P[0]![2]!,
          activeRegion.origin[1]! + i * activeRegion.P[1]![0]! + j * activeRegion.P[1]![1]! + k * activeRegion.P[1]![2]!,
          activeRegion.origin[2]! + i * activeRegion.P[2]![0]! + j * activeRegion.P[2]![1]! + k * activeRegion.P[2]![2]!,
        ];
        framePts.push(fractionalToCartesian(structure.cell, frac));
      }
    }
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of framePts) {
      for (let a = 0; a < 3; a++) {
        if (p[a]! < lo[a]!) lo[a] = p[a]!;
        if (p[a]! > hi[a]!) hi[a] = p[a]!;
      }
    }
    const ctr: Vec3 = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
    const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
    return { corners: c, center: ctr, span: diag || 10 };
  }, [structure, supercell[0], supercell[1], supercell[2], activeRegion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth || 480;
    const height = mount.clientHeight || 360;
    const aspect = width / height;

    const scene = new THREE.Scene();
    const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspective
      ? new THREE.PerspectiveCamera(45, aspect, 0.05, 8000)
      : (() => {
          const d = span * 0.85; // half-height of the ortho frustum, sized to the cell
          return new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, -8000, 8000);
        })();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const ambient = new THREE.AmbientLight(0xffffff, 0.85 * lightLevel);
    scene.add(ambient);
    const dl = new THREE.DirectionalLight(0xffffff, 0.55 * lightLevel);
    dl.position.set(1, 1.5, 1);
    scene.add(dl);
    lightsRef.current = { ambient, directional: dl };

    const centerV = new THREE.Vector3(center[0], center[1], center[2]);
    const labelH = span * 0.05; // world height of text sprites

    // Atoms — ball-and-stick spheres, geometry cached per (radius, wedge).
    // A doped/mixed site (at.mixture) is drawn as occupancy-proportional wedges
    // — SphereGeometry phiStart/phiLength azimuthal slices, one colour per
    // element plus a muted grey vacancy slice — so a shared site reads as split
    // instead of the single colour of whichever sphere happened to draw last.
    const geoCache = new Map<string, THREE.SphereGeometry>();
    const getGeo = (r: number, phiStart = 0, phiLength = Math.PI * 2): THREE.SphereGeometry => {
      const key = `${r.toFixed(2)}|${phiStart.toFixed(3)}|${phiLength.toFixed(3)}`;
      let g = geoCache.get(key);
      if (!g) {
        // Segment the azimuth finely enough that a thin wedge is still smooth.
        const wSeg = phiLength >= Math.PI * 2 ? 20 : Math.max(3, Math.round((20 * phiLength) / (Math.PI * 2)));
        g = new THREE.SphereGeometry(r, wSeg, 16, phiStart, phiLength);
        geoCache.set(key, g);
      }
      return g;
    };
    const { shininess, specular } = FINISHES[finish];
    const VACANCY_COLOR = 0xd1d5db; // muted grey slice for an unoccupied fraction
    atomMatsRef.current = [];
    const addSphere = (geo: THREE.SphereGeometry, color: THREE.ColorRepresentation, xyz: Vec3): void => {
      const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(color), shininess, specular });
      atomMatsRef.current.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(xyz[0], xyz[1], xyz[2]);
      scene.add(mesh);
    };
    for (const at of atoms) {
      if (at.mixture && at.mixture.length > 0) {
        // Occupancy-weighted radius; wedge azimuths ∝ occupancy out of 1, so a
        // vacancy remainder (Σocc < 1) becomes a grey slice. Σocc slightly over 1
        // (rounding) normalizes to fill exactly 2π with no vacancy.
        let rNum = 0, rDen = 0;
        for (const f of at.mixture) { rNum += covalentRadius(f.element) * f.occupancy; rDen += f.occupancy; }
        const r = (rDen > 0 ? rNum / rDen : covalentRadius(at.element)) * 0.38;
        const sumOcc = at.mixture.reduce((s, f) => s + f.occupancy, 0);
        const denom = Math.max(1, sumOcc);
        let phi = 0;
        for (const f of at.mixture) {
          const span = (Math.PI * 2 * f.occupancy) / denom;
          if (span <= 1e-4) continue;
          addSphere(getGeo(r, phi, span), elementColor(f.element), at.xyz);
          phi += span;
        }
        const vacancy = 1 - Math.min(1, sumOcc);
        if (vacancy > 1e-3) addSphere(getGeo(r, phi, (Math.PI * 2 * vacancy) / denom), VACANCY_COLOR, at.xyz);
      } else {
        addSphere(getGeo(covalentRadius(at.element) * 0.38), elementColor(at.element), at.xyz);
      }
    }

    // Atom site labels, floated just above each sphere.
    if (showAtomLabels && atoms.length <= MAX_ATOM_LABELS) {
      for (const at of atoms) {
        const s = makeLabelSprite(at.label, labelH * 0.9, "#1f2937");
        s.position.set(at.xyz[0], at.xyz[1] + covalentRadius(at.element) * 0.38 + labelH * 0.55, at.xyz[2]);
        scene.add(s);
      }
    }

    // Magnetic moment arrows (axial vectors): each atom's moment comes from
    // displayMoment — the θ-signed axial transform of its placing operation with
    // the commensurate k-phase (cell index + returning translation) — then
    // crystal-axis components → Cartesian for the arrow. Length ∝ |moment|.
    if (moments && moments.length > 0) {
      const byKey = new Map(moments.map((e) => [e.key, e.components]));
      let maxMom = 0;
      for (const e of moments) {
        const c = crystalComponentsToCartesian(structure.cell, e.components);
        maxMom = Math.max(maxMom, Math.hypot(c[0]!, c[1]!, c[2]!));
      }
      const arrowUnit = maxMom > 1e-6 ? (span * 0.42) / maxMom : 0;
      for (const at of atoms) {
        const m = arrowUnit > 0 && at.mag ? byKey.get(at.mag.momentKey) : undefined;
        if (!m) continue;
        const mc = displayMoment(at, m, propagation);
        if (!mc) continue;
        const cart = crystalComponentsToCartesian(structure.cell, mc);
        const len = Math.hypot(cart[0]!, cart[1]!, cart[2]!);
        if (len < 1e-6) continue;
        const dir = new THREE.Vector3(cart[0]! / len, cart[1]! / len, cart[2]! / len);
        const L = len * arrowUnit;
        const start = new THREE.Vector3(at.xyz[0], at.xyz[1], at.xyz[2]).addScaledVector(dir, -L / 2);
        scene.add(new THREE.ArrowHelper(dir, start, L, 0xe11d48, L * 0.26, L * 0.16));
      }
    }

    // Distortion-mode displacement arrows (polar vectors, green): the site's
    // fractional eigenvector rotated by each copy's placing operation
    // (d′ = R·d — no det/θ, displacements are polar, unlike moments), then
    // fractional → Cartesian (a pure linear map, so valid for vectors).
    // Tails sit ON the atoms: the arrow points where the mode moves the atom.
    if (displacements && displacements.length > 0) {
      const bySite = new Map(displacements.map((d) => [d.siteLabel, d.axis]));
      let maxLen = 0;
      for (const [, ax] of bySite) {
        const c = fractionalToCartesian(structure.cell, ax);
        maxLen = Math.max(maxLen, Math.hypot(c[0]!, c[1]!, c[2]!));
      }
      // Longest arrow ≈ one bond, not a traverse of the cell. The eigenvector
      // is a *pattern* — unit amplitude, arbitrary scale — so the scale's only
      // job is to read as a local displacement of the atom it sits on; at the
      // old span·0.34 the tip landed well past the neighbouring site and the
      // pattern read as a vector field over the cell instead. Tied to the
      // shortest cell edge so it does not grow with the supercell, and clamped
      // by the box diagonal so a very flat cell keeps its arrows in bounds.
      const minEdge = Math.min(structure.cell.a, structure.cell.b, structure.cell.c);
      const longest = Math.min(minEdge * 0.26, span * 0.12);
      const unit = maxLen > 1e-9 ? longest / maxLen : 0;
      const arrow = arrowBuilder({
        color: 0x16a34a,
        // Nearly twice a bond's radius (bonds are 0.09) at a typical cell size,
        // so the stem is unmistakably solid against the spheres it crosses.
        // The tail sits at the atom centre, so roughly a sphere radius of every
        // arrow is buried — the head takes a modest share of the length to keep
        // the visible stem longer than the cone that caps it.
        shaftRadius: longest * 0.075,
        headRadius: longest * 0.165,
        headLength: longest * 0.28,
      });
      for (const at of atoms) {
        const ax = unit > 0 ? bySite.get(at.label) : undefined;
        if (!ax) continue;
        const df: Vec3 = [
          at.rot[0]![0]! * ax[0]! + at.rot[0]![1]! * ax[1]! + at.rot[0]![2]! * ax[2]!,
          at.rot[1]![0]! * ax[0]! + at.rot[1]![1]! * ax[1]! + at.rot[1]![2]! * ax[2]!,
          at.rot[2]![0]! * ax[0]! + at.rot[2]![1]! * ax[1]! + at.rot[2]![2]! * ax[2]!,
        ];
        const cart = fractionalToCartesian(structure.cell, df);
        const len = Math.hypot(cart[0]!, cart[1]!, cart[2]!);
        if (len < 1e-9) continue;
        const dir = new THREE.Vector3(cart[0]! / len, cart[1]! / len, cart[2]! / len);
        const L = len * unit;
        const start = new THREE.Vector3(at.xyz[0], at.xyz[1], at.xyz[2]);
        scene.add(arrow(dir, start, L));
      }
    }

    // Bonds — cylinders between atoms within 1.15×(sum of covalent radii).
    // Collect the pairs first so optional length labels reuse the same geometry.
    if (atoms.length <= 1600) {
      const bondGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 8); // unit length along +Y
      bondGeo.translate(0, 0.5, 0);
      const bondMat = new THREE.MeshPhongMaterial({ color: 0x8a8f98, shininess: 20 });
      const Y0 = new THREE.Vector3(0, 1, 0);
      const pa = new THREE.Vector3(), pb = new THREE.Vector3(), dir = new THREE.Vector3(), quat = new THREE.Quaternion();
      const bonds: { mid: THREE.Vector3; len: number }[] = [];
      for (let i = 0; i < atoms.length; i++) {
        const ri = covalentRadius(atoms[i]!.element);
        pa.set(atoms[i]!.xyz[0], atoms[i]!.xyz[1], atoms[i]!.xyz[2]);
        for (let j = i + 1; j < atoms.length; j++) {
          const cut = (ri + covalentRadius(atoms[j]!.element)) * 1.15;
          pb.set(atoms[j]!.xyz[0], atoms[j]!.xyz[1], atoms[j]!.xyz[2]);
          const len = pa.distanceTo(pb);
          if (len < 0.4 || len > cut) continue;
          const mesh = new THREE.Mesh(bondGeo, bondMat);
          dir.subVectors(pb, pa);
          quat.setFromUnitVectors(Y0, dir.clone().normalize());
          mesh.position.copy(pa);
          mesh.quaternion.copy(quat);
          mesh.scale.set(1, len, 1);
          scene.add(mesh);
          bonds.push({ mid: pa.clone().add(pb).multiplyScalar(0.5), len });
        }
      }
      if (showBondLengths && bonds.length <= MAX_BOND_LABELS) {
        for (const b of bonds) {
          const s = makeLabelSprite(`${b.len.toFixed(2)} Å`, labelH, "#334155");
          s.position.copy(b.mid);
          scene.add(s);
        }
      }
    }

    // Unit-cell wireframe (indigo, matching the plot's accent). Hidden in the
    // standard-cell view so the amber magnetic cell is shown on its own.
    const edges: readonly [number, number][] = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
    if (showParentCell) {
      const pts: THREE.Vector3[] = [];
      for (const [a, b] of edges) {
        pts.push(new THREE.Vector3(...corners[a]!), new THREE.Vector3(...corners[b]!));
      }
      scene.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.55 }),
      ));
    }

    // Standard-setting cell of the selected magnetic group (amber wireframe):
    // corners = origin + i·A′ + j·B′ + k·C′ with A′,B′,C′ the columns of P in
    // parent fractional coordinates, converted through the same lattice.
    if (standardCell && showStandardCell) {
      const col = (j: number): Vec3 => [
        standardCell.P[0]![j]!,
        standardCell.P[1]![j]!,
        standardCell.P[2]![j]!,
      ];
      const stdCorner = (i: number, j: number, k: number): THREE.Vector3 => {
        const frac: Vec3 = [
          standardCell.origin[0]! + i * col(0)[0]! + j * col(1)[0]! + k * col(2)[0]!,
          standardCell.origin[1]! + i * col(0)[1]! + j * col(1)[1]! + k * col(2)[1]!,
          standardCell.origin[2]! + i * col(0)[2]! + j * col(1)[2]! + k * col(2)[2]!,
        ];
        return new THREE.Vector3(...fractionalToCartesian(structure.cell, frac));
      };
      const sc: THREE.Vector3[] = [];
      for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) sc.push(stdCorner(i, j, k));
      const spts: THREE.Vector3[] = [];
      for (const [a, b] of edges) spts.push(sc[a]!.clone(), sc[b]!.clone());
      scene.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(spts),
        new THREE.LineBasicMaterial({ color: 0xd97706, transparent: true, opacity: 0.9 }),
      ));
      const tag = makeLabelSprite(standardCell.label, labelH * 1.1, "#b45309");
      tag.position.copy(sc[0]!).add(new THREE.Vector3(0, labelH * 0.8, 0));
      scene.add(tag);
    }

    // Coordinate axes: a/b/c arrows from the cell origin, coloured RGB, labelled.
    if (showAxes) {
      const origin = new THREE.Vector3(...corners[0]!); // fractional (0,0,0)
      const axisDefs: [Vec3, number, string][] = [
        [fractionalToCartesian(structure.cell, [1, 0, 0]), 0xd94a4a, "a"],
        [fractionalToCartesian(structure.cell, [0, 1, 0]), 0x2ea043, "b"],
        [fractionalToCartesian(structure.cell, [0, 0, 1]), 0x3b6ef1, "c"],
      ];
      const alen = span * 0.32;
      for (const [vec, hex, name] of axisDefs) {
        const dir = new THREE.Vector3(...vec).normalize();
        scene.add(new THREE.ArrowHelper(dir, origin, alen, hex, alen * 0.18, alen * 0.1));
        const label = makeLabelSprite(name, labelH * 1.2, `#${hex.toString(16).padStart(6, "0")}`);
        label.position.copy(origin).add(dir.clone().multiplyScalar(alen * 1.12));
        scene.add(label);
      }
    }

    // Camera: restore the user's saved view when the scene is the same
    // structure/cell/supercell (rebuilds from overlay or moment edits must not
    // reset the orientation); otherwise fit the cell, looking slightly down
    // the body diagonal.
    const { a, b, c, alpha, beta, gamma } = structure.cell;
    const viewKey = `${structure.id}|${a},${b},${c},${alpha},${beta},${gamma}|${supercell.join("x")}|${cellView}`;
    const saved = viewStateRef.current;
    if (saved && saved.key === viewKey) {
      camera.position.set(saved.pos[0]!, saved.pos[1]!, saved.pos[2]!);
      controls.target.set(saved.target[0]!, saved.target[1]!, saved.target[2]!);
      if (!(camera instanceof THREE.PerspectiveCamera)) camera.zoom = saved.zoom;
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
    } else {
      camera.position.copy(centerV).add(new THREE.Vector3(span * 0.55, span * 0.45, span * 1.1 + 4));
      camera.lookAt(centerV);
      controls.target.copy(centerV);
    }
    controls.update();
    sceneRef.current = { camera, controls, centerV, span };

    let raf = 0;
    const renderOnce = (): void => { controls.update(); renderer.render(scene, camera); };
    const loop = (): void => { raf = requestAnimationFrame(loop); renderOnce(); };
    renderOnce(); // one synchronous frame so a still is present even if rAF is throttled
    loop();

    const onResize = (): void => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (w < 1 || h < 1) return;
      const a = w / h;
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = a;
      } else {
        const d = span * 0.85;
        camera.left = -d * a; camera.right = d * a; camera.top = d; camera.bottom = -d;
      }
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderOnce();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      // Remember where the user left the camera for the next rebuild.
      viewStateRef.current = { key: viewKey, pos: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom };
      sceneRef.current = null;
      lightsRef.current = null;
      atomMatsRef.current = [];
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* free the WebGL context for rebuilds */ }
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // lightLevel and finish are intentionally NOT dependencies: their knobs
    // mutate the live lights/materials below without rebuilding the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atoms, corners, center, span, showBondLengths, showAtomLabels, perspective, showAxes, structure, moments, propagation, standardCell, showParentCell, showStandardCell, cellView, displacements]);

  // Light knob → in-place intensity update (the rAF loop shows it next frame).
  useEffect(() => {
    if (!lightsRef.current) return;
    lightsRef.current.ambient.intensity = 0.85 * lightLevel;
    lightsRef.current.directional.intensity = 0.55 * lightLevel;
  }, [lightLevel]);

  // Finish knob → in-place material update, camera untouched.
  useEffect(() => {
    const { shininess, specular } = FINISHES[finish];
    for (const m of atomMatsRef.current) {
      m.shininess = shininess;
      m.specular.set(specular);
    }
  }, [finish]);

  // Re-render the legend swatches whenever the elements, finish, or light change
  // so they stay identical to the atoms on screen.
  useEffect(() => {
    if (uniqueElements.length === 0) return;
    let gl = swatchGLRef.current;
    if (!gl) {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setSize(128, 128, false);
      gl = { renderer, canvas };
      swatchGLRef.current = gl;
    }
    setAtomSwatches(renderAtomSwatches(uniqueElements, finish, lightLevel, gl));
  }, [uniqueElements, finish, lightLevel]);

  // Release the swatch renderer's WebGL context on unmount.
  useEffect(() => () => {
    const gl = swatchGLRef.current;
    if (!gl) return;
    gl.renderer.dispose();
    try { gl.renderer.forceContextLoss(); } catch { /* free the context */ }
    swatchGLRef.current = null;
  }, []);

  const hasCell = structure.cell.a > 0 && structure.cell.b > 0 && structure.cell.c > 0;
  if (!hasCell || atoms.length === 0) {
    return (
      <div style={{ height: 360, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>
        No atomic sites to display.
      </div>
    );
  }
  return (
    // Fill whatever the host card gives us (flex column); in an unconstrained
    // context the canvas keeps its 360 px minimum.
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginBottom: 6, fontSize: 12, color: theme.secondary, fontFamily: themeMono, alignItems: "center" }}>
        <ViewerToggle label="Bond lengths" checked={showBondLengths} onChange={setShowBondLengths} />
        <ViewerToggle label="Atom labels" checked={showAtomLabels} onChange={setShowAtomLabels} />
        <ViewerToggle label="Axes" checked={showAxes} onChange={setShowAxes} />
        <ViewerToggle label="Perspective" checked={perspective} onChange={setPerspective} />
        {cellOptions.length > 1 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title="Show one unit cell at a time — never the atomic and magnetic cells together">
            Cell
            <span style={{ display: "inline-flex", border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
              {cellOptions.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setCellChoice(opt)}
                  style={{
                    border: "none",
                    padding: "1px 7px",
                    fontSize: 11.5,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    background: cellView === opt ? theme.primary : "#fff",
                    color: cellView === opt ? "#fff" : theme.ink,
                  }}
                >
                  {opt === "atomic" ? "Atomic" : opt === "super" ? `Magnetic (${superK.join("×")})` : `Magnetic (${standardCell!.label})`}
                </button>
              ))}
            </span>
          </span>
        )}
        {exports && exports.length > 0 && (
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
            {exports.map((x) => (
              <button
                key={x.label}
                onClick={x.run}
                title={x.title}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 6,
                  padding: "1px 8px",
                  fontSize: 11.5,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  background: "#fff",
                  color: theme.ink,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3v12" />
                  <path d="M7 12l5 5 5-5" />
                  <path d="M4 21h16" />
                </svg>
                {x.label}
              </button>
            ))}
          </span>
        )}
      </div>
      <div ref={mountRef} style={{ width: "100%", flex: 1, minHeight: minCanvasHeight, cursor: "grab", borderRadius: 10, overflow: "hidden" }} />
      {/* View presets (bottom-right, above the legend): look straight down an axis. */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6, fontSize: 12, fontFamily: themeMono, color: theme.secondary }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 9px", borderRadius: 8, background: theme.chipBg }} title="Look straight down a crystallographic axis (keeps your zoom)">
          View
          <span style={{ display: "inline-flex", border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
            {(["a", "b", "c"] as const).map((ax) => (
              <button
                key={ax}
                onClick={() => viewAlong(ax)}
                title={`View down the ${ax} axis`}
                style={{ border: "none", padding: "1px 8px", fontSize: 11.5, fontFamily: "inherit", fontStyle: "italic", cursor: "pointer", background: "#fff", color: theme.ink }}
              >
                {ax}
              </button>
            ))}
          </span>
        </span>
      </div>
      {/* Atom legend + appearance controls (light / finish shape the swatches too). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 6, fontSize: 12, fontFamily: themeMono, color: theme.secondary, alignItems: "center" }}>
        {uniqueElements.map((el) => (
          <span key={el} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {atomSwatches[el] ? (
              <img
                src={atomSwatches[el]}
                alt=""
                width={15}
                height={15}
                style={{ display: "inline-block", filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.28))" }}
              />
            ) : (
              <span style={{ width: 15, height: 15, borderRadius: "50%", background: elementColor(el), display: "inline-block" }} />
            )}
            {el}
          </span>
        ))}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 16 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title="Scene light level (also brightens/dims the legend)">
            Light
            <input type="range" min={0.3} max={2} step={0.05} value={lightLevel} onChange={(e) => setLightLevel(Number(e.target.value))} style={{ width: 72 }} />
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title="Sphere surface finish (specular highlight)">
            Finish
            <select
              value={finish}
              onChange={(e) => setFinish(e.target.value as Finish)}
              style={{ fontSize: 11.5, fontFamily: "inherit", border: `1px solid ${theme.border}`, borderRadius: 6, padding: "1px 4px", color: theme.ink, background: "#fff" }}
            >
              <option value="matte">matte</option>
              <option value="standard">standard</option>
              <option value="glossy">glossy</option>
            </select>
          </label>
        </span>
      </div>
    </div>
  );
}

function ViewerToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
