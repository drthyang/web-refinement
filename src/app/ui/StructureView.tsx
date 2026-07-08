/**
 * 3D crystal-structure viewer (static ball-and-stick). Adapted from the
 * rmc-phonon `CrystalViewer` — the phonon animation, eigenvectors, and capture
 * machinery are dropped; this shows the refined unit-cell contents.
 *
 * The asymmetric unit is expanded by the space-group operations, wrapped into
 * one cell, and boundary atoms (on a face/edge/corner) are duplicated so the
 * cell looks complete. Atoms are spheres coloured/sized by element, bonds are
 * covalent-radius cylinders, and the cell edges are drawn as a wireframe.
 * Interaction: drag to rotate, scroll to zoom (three.js OrbitControls).
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { color as theme } from "@/app/theme";
import { covalentRadius, elementColor } from "@/app/ui/elementData";
import { buildCellAtoms } from "@/app/ui/cellModel";

export function StructureView({ structure }: { structure: StructureModel }): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
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

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 8000);
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
    // Skip for very large cells to keep the O(n²) pass bounded.
    if (atoms.length <= 1600) {
      const bondGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 8); // unit length along +Y
      bondGeo.translate(0, 0.5, 0);
      const bondMat = new THREE.MeshPhongMaterial({ color: 0x8a8f98, shininess: 20 });
      const Y0 = new THREE.Vector3(0, 1, 0);
      const pa = new THREE.Vector3(), pb = new THREE.Vector3(), dir = new THREE.Vector3(), quat = new THREE.Quaternion();
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
      camera.aspect = w / h;
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
  }, [atoms, corners, center, span]);

  const hasCell = structure.cell.a > 0 && structure.cell.b > 0 && structure.cell.c > 0;
  if (!hasCell || atoms.length === 0) {
    return (
      <div style={{ height: 360, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>
        No atomic sites to display.
      </div>
    );
  }
  return <div ref={mountRef} style={{ width: "100%", height: 360, cursor: "grab", borderRadius: 10, overflow: "hidden" }} />;
}
