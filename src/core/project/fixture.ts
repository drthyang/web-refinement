/**
 * A minimal, hand-built example ProjectFile used by tests and as a reference
 * for the file format. It is deliberately tiny (α-Fe, one site) and carries no
 * calculated results — just enough to exercise construction and round-trip.
 */

import { PROJECT_SCHEMA_VERSION } from "@/app/constants";
import type { ProjectFile } from "@/core/project/types";

export function makeExampleProject(): ProjectFile {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: {
      title: "Example: bcc iron (nuclear only)",
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      appVersion: "0.0.0",
      notes: "Reference fixture; not a validated refinement.",
    },
    structures: [
      {
        id: "struct-fe",
        name: "bcc Fe",
        cell: { a: 2.8665, b: 2.8665, c: 2.8665, alpha: 90, beta: 90, gamma: 90 },
        spaceGroup: {
          number: 229,
          hermannMauguin: "I m -3 m",
          operations: [
            { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" },
            {
              rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
              translation: [0.5, 0.5, 0.5],
              xyz: "x+1/2,y+1/2,z+1/2",
            },
          ],
        },
        sites: [
          {
            label: "Fe1",
            element: "Fe",
            position: [0, 0, 0],
            occupancy: 1,
            adp: { kind: "isotropic", bIso: 0.5 },
          },
        ],
      },
    ],
    magneticModels: [],
    datasets: [
      {
        id: "data-fe-sx",
        name: "Simulated single crystal",
        radiation: { kind: "neutron", wavelength: 1.54 },
        reflections: [
          { h: 1, k: 1, l: 0, iObs: 100, sigma: 3 },
          { h: 2, k: 0, l: 0, iObs: 42, sigma: 2 },
        ],
      },
    ],
    parameters: [
      {
        id: "p-scale",
        label: "scale",
        kind: "scale",
        value: 1,
        initialValue: 1,
        min: 0,
        fixed: false,
      },
    ],
    bindings: [{ parameterId: "p-scale", kind: "scale", targetId: "data-fe-sx" }],
  };
}
