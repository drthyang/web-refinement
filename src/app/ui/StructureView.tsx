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
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { color as theme, mono as themeMono } from "@/app/theme";
import { covalentRadius, elementColor } from "@/app/ui/elementData";
import { buildCellAtoms } from "@/app/ui/cellModel";

const MAX_BOND_LABELS = 80; // labelling every bond of a big cell is unreadable

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

export function StructureView({ structure }: { structure: StructureModel }): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [showBondLengths, setShowBondLengths] = useState(false);
  const [perspective, setPerspective] = useState(true);
  const [showAxes, setShowAxes] = useState(true);

  const atoms = useMemo(() => buildCellAtoms(structure), [structure]);

  // Cartesian cell corners + centre + body-diagonal span, for edges and camera.
  const { corners, center, span } = useMemo(() => {
    const c: Vec3[] = [];
    for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
      c.push(fractionalToCartesian(structure.cell, [i, j, k]));
    }
    const ctr = fractionalToCartesian(structure.cell, [0.5, 0.5, 0.5]);
    const diag = fractionalToCartesian(structure.cell, [1, 1, 1]);
    return { corners: c, center: ctr, span: Math.hypot(diag[0], diag[1], diag[2]) || 10 };
  }, [structure]);

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

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dl = new THREE.DirectionalLight(0xffffff, 0.55);
    dl.position.set(1, 1.5, 1);
    scene.add(dl);

    const centerV = new THREE.Vector3(center[0], center[1], center[2]);
    const labelH = span * 0.05; // world height of text sprites

    // Atoms — ball-and-stick spheres, geometry cached per rounded radius.
    const geoCache = new Map<string, THREE.SphereGeometry>();
    const getGeo = (r: number): THREE.SphereGeometry => {
      const key = r.toFixed(2);
      let g = geoCache.get(key);
      if (!g) { g = new THREE.SphereGeometry(r, 20, 20); geoCache.set(key, g); }
      return g;
    };
    for (const at of atoms) {
      const r = covalentRadius(at.element) * 0.38;
      const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(elementColor(at.element)), shininess: 60, specular: 0x222222 });
      const mesh = new THREE.Mesh(getGeo(r), mat);
      mesh.position.set(at.xyz[0], at.xyz[1], at.xyz[2]);
      scene.add(mesh);
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

    // Unit-cell wireframe (indigo, matching the plot's accent).
    const edges: readonly [number, number][] = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
    const pts: THREE.Vector3[] = [];
    for (const [a, b] of edges) {
      pts.push(new THREE.Vector3(...corners[a]!), new THREE.Vector3(...corners[b]!));
    }
    scene.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.55 }),
    ));

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

    // Camera: fit the cell, looking slightly down the body diagonal.
    camera.position.copy(centerV).add(new THREE.Vector3(span * 0.55, span * 0.45, span * 1.1 + 4));
    camera.lookAt(centerV);
    controls.target.copy(centerV);
    controls.update();

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
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* free the WebGL context for rebuilds */ }
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [atoms, corners, center, span, showBondLengths, perspective, showAxes, structure]);

  const hasCell = structure.cell.a > 0 && structure.cell.b > 0 && structure.cell.c > 0;
  if (!hasCell || atoms.length === 0) {
    return (
      <div style={{ height: 360, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>
        No atomic sites to display.
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 6, fontSize: 12, color: theme.secondary, fontFamily: themeMono }}>
        <ViewerToggle label="Bond lengths" checked={showBondLengths} onChange={setShowBondLengths} />
        <ViewerToggle label="Perspective" checked={perspective} onChange={setPerspective} />
        <ViewerToggle label="Axes" checked={showAxes} onChange={setShowAxes} />
      </div>
      <div ref={mountRef} style={{ width: "100%", height: 360, cursor: "grab", borderRadius: 10, overflow: "hidden" }} />
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
