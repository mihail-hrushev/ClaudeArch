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

  // 2D outward normals: per edge (flat) and per vertex (smooth = average of adjacent edges).
  const edgeN = P.map((p, j) => {
    const q = P[(j + 1) % P.length];
    return normalize2(q[1] - p[1], -(q[0] - p[0])); // CCW edge (ey, ez) -> (ez, -ey)
  });
  const vertN = P.map((_, j) => {
    const a = edgeN[(j + P.length - 1) % P.length];
    const b = edgeN[j];
    return normalize2(a[0] + b[0], a[1] + b[1]);
  });

  // Side faces.
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const toWorld = ([ny, nz]: readonly [number, number]) => normalize(add(scale(f.y, ny), scale(f.z, nz)));
    for (let j = 0; j < P.length; j++) {
      const j1 = (j + 1) % P.length;
      const quad = [rings[k][j], rings[k][j1], rings[k + 1][j1], rings[k + 1][j]];
      if (profile.smooth) {
        const nj = toWorld(vertN[j]);
        const nj1 = toWorld(vertN[j1]);
        addPolygon(mesh, quad, [nj, nj1, nj1, nj]);
      } else {
        addPolygon(mesh, quad, toWorld(edgeN[j]));
      }
    }
  }

  // End caps.
  addPolygon(mesh, [...rings[0]].reverse(), scale(frames[0].x, -1));
  addPolygon(mesh, rings[rings.length - 1], frames[frames.length - 1].x);

  return mesh;
}

function normalize2(y: number, z: number): [number, number] {
  const l = Math.hypot(y, z);
  return [y / l, z / l];
}

/** Convex polygon as a triangle fan, CCW around its normal (one for all, or one per vertex). */
function addPolygon(mesh: MeshData, pts: Vec3[], normal: Vec3 | Vec3[]) {
  const base = mesh.positions.length / 3;
  pts.forEach((p, i) => {
    const n = Array.isArray(normal[0]) ? (normal as Vec3[])[i] : (normal as Vec3);
    mesh.positions.push(p[0], p[1], p[2]);
    mesh.normals.push(n[0], n[1], n[2]);
  });
  for (let i = 1; i < pts.length - 1; i++) mesh.indices.push(base, base + i, base + i + 1);
}
