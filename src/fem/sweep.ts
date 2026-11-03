import type { Discretized } from "./discretize";
import type { Profile } from "./profiles";
import { type Vec3, add, sub, scale, dot, normalize } from "./vec";

export interface MeshData {
  positions: number[];
  normals: number[];
  indices: number[];
}

/**
 * Sweeps the profile along the discretized element.
 * Interior joints are mitered on the bisector plane, so every perpendicular
 * cross-section of every segment is exactly the profile (no pinching at bends).
 * Flat shaded: each face owns its vertices.
 */
export function sweepProfile(d: Discretized, profile: Profile): MeshData {
  const { nodes, frames } = d;
  const P = profile.outline;
  const mesh: MeshData = { positions: [], normals: [], indices: [] };

  // Profile ring at each node.
  const rings: Vec3[][] = nodes.map((node, i) => {
    const f = frames[Math.max(0, i - 1)]; // incoming segment frame (outgoing for the first node)
    const isInterior = i > 0 && i < nodes.length - 1;
    const miter = isInterior ? normalize(add(frames[i - 1].x, frames[i].x)) : null;
    return P.map(([py, pz]) => {
      const o = add(scale(f.y, py), scale(f.z, pz));
      if (!miter) return add(node, o);
      // Slide the corner along the segment axis onto the miter plane.
      return sub(add(node, o), scale(f.x, dot(o, miter) / dot(f.x, miter)));
    });
  });

  // Side faces.
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    for (let j = 0; j < P.length; j++) {
      const j1 = (j + 1) % P.length;
      const ey = P[j1][0] - P[j][0];
      const ez = P[j1][1] - P[j][1];
      // Outward normal of a CCW edge in (y, z) is (ez, -ey).
      const n = normalize(add(scale(f.y, ez), scale(f.z, -ey)));
      addPolygon(mesh, [rings[k][j], rings[k][j1], rings[k + 1][j1], rings[k + 1][j]], n);
    }
  }

  // End caps.
  addPolygon(mesh, [...rings[0]].reverse(), scale(frames[0].x, -1));
  addPolygon(mesh, rings[rings.length - 1], frames[frames.length - 1].x);

  return mesh;
}

/** Convex polygon as a triangle fan, CCW around `normal`. */
function addPolygon(mesh: MeshData, pts: Vec3[], normal: Vec3) {
  const base = mesh.positions.length / 3;
  for (const p of pts) {
    mesh.positions.push(p[0], p[1], p[2]);
    mesh.normals.push(normal[0], normal[1], normal[2]);
  }
  for (let i = 1; i < pts.length - 1; i++) mesh.indices.push(base, base + i, base + i + 1);
}
