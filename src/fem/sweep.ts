import type { Discretized } from "./discretize";
import type { Profile } from "./profiles";
import { type Vec3, add, sub, scale, dot, len, normalize } from "./vec";

/**
 * Scene units (cm) covered by one texture repeat at uScale = vScale = 1.
 * All mesh uvs are world distances divided by this, so a 1 m texture tiles exactly once per metre.
 */
export const UV_UNIT = 100;

export interface MeshData {
  positions: number[];
  normals: number[];
  /** One (u, v) per vertex, in world distance / UV_UNIT (see each generator for the mapping). */
  uvs: number[];
  indices: number[];
}

type UV = readonly [number, number];

/**
 * Sweeps the profile along the discretized element.
 * Interior joints are mitered on the bisector plane, so every perpendicular
 * cross-section of every segment is exactly the profile (no pinching at bends).
 * Flat shaded: each face owns its vertices.
 * Texture uvs: sides u = polyline length along the axis up to the ring's node, v = perimeter
 * distance around the outline; caps use the outline's own (y, z) coordinates.
 */
export function sweepProfile(d: Discretized, profile: Profile, endCut?: Vec3): MeshData {
  const { nodes, frames } = d;
  const P = profile.outline;
  const mesh: MeshData = { positions: [], normals: [], uvs: [], indices: [] };
  const last = nodes.length - 1;
  const lastX = frames[frames.length - 1].x;
  // End cut plane normal, oriented along the end tangent (ignored if nearly parallel to the axis).
  let endN: Vec3 | null = null;
  if (endCut) {
    const c = normalize(endCut);
    const s = dot(c, lastX);
    if (Math.abs(s) > 0.1) endN = s > 0 ? c : scale(c, -1);
  }

  // Profile ring at each node.
  const rings: Vec3[][] = nodes.map((node, i) => {
    const f = frames[Math.max(0, i - 1)]; // incoming segment frame (outgoing for the first node)
    const isInterior = i > 0 && i < last;
    const miter = isInterior ? normalize(add(frames[i - 1].x, frames[i].x)) : i === last ? endN : null;
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

  // Texture coordinates: u at node k = polyline length up to k; v at outline vertex j = perimeter
  // distance up to j (vAt[P.length] is the full perimeter, so the closing edge does not wrap).
  const uAt: number[] = [0];
  for (let i = 1; i < nodes.length; i++) uAt.push(uAt[i - 1] + len(sub(nodes[i], nodes[i - 1])) / UV_UNIT);
  const vAt: number[] = [0];
  for (let j = 0; j < P.length; j++) {
    const q = P[(j + 1) % P.length];
    vAt.push(vAt[j] + Math.hypot(q[0] - P[j][0], q[1] - P[j][1]) / UV_UNIT);
  }
  const capUV = (p: UV): UV => [p[0] / UV_UNIT, p[1] / UV_UNIT];

  // Side faces.
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const toWorld = ([ny, nz]: readonly [number, number]) => normalize(add(scale(f.y, ny), scale(f.z, nz)));
    for (let j = 0; j < P.length; j++) {
      const j1 = (j + 1) % P.length;
      const quad = [rings[k][j], rings[k][j1], rings[k + 1][j1], rings[k + 1][j]];
      const uv: UV[] = [[uAt[k], vAt[j]], [uAt[k], vAt[j + 1]], [uAt[k + 1], vAt[j + 1]], [uAt[k + 1], vAt[j]]];
      if (profile.smooth) {
        const nj = toWorld(vertN[j]);
        const nj1 = toWorld(vertN[j1]);
        addPolygon(mesh, quad, [nj, nj1, nj1, nj], uv);
      } else {
        addPolygon(mesh, quad, toWorld(edgeN[j]), uv);
      }
    }
  }

  // End caps.
  addPolygon(mesh, [...rings[0]].reverse(), scale(frames[0].x, -1), [...P].reverse().map(capUV));
  addPolygon(mesh, rings[last], endN ?? lastX, P.map(capUV));

  return mesh;
}

function normalize2(y: number, z: number): [number, number] {
  const l = Math.hypot(y, z);
  return [y / l, z / l];
}

/** Convex polygon as a triangle fan, CCW around its normal (one for all, or one per vertex). */
function addPolygon(mesh: MeshData, pts: Vec3[], normal: Vec3 | Vec3[], uvs: readonly UV[]) {
  const base = mesh.positions.length / 3;
  pts.forEach((p, i) => {
    const n = Array.isArray(normal[0]) ? (normal as Vec3[])[i] : (normal as Vec3);
    mesh.positions.push(p[0], p[1], p[2]);
    mesh.normals.push(n[0], n[1], n[2]);
    mesh.uvs.push(uvs[i][0], uvs[i][1]);
  });
  for (let i = 1; i < pts.length - 1; i++) mesh.indices.push(base, base + i, base + i + 1);
}
