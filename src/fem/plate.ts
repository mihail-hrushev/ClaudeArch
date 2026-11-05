import type { PlateElement } from "./types";
import { type MeshData, UV_UNIT } from "./sweep";
import { type Vec3, add, sub, scale, dot, cross, normalize, len } from "./vec";

/** Unit normal of a planar polygon (Newell's method; CCW → right-hand normal). */
export function plateNormal(c: readonly Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i];
    const q = c[(i + 1) % c.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return normalize([nx, ny, nz]);
}

/**
 * Solid of a plate: mid-surface polygon extruded ±thickness/2 along its normal. Flat shaded.
 * Texture uvs: faces use a planar frame with origin corner 0 and u along edge 0 → 1;
 * sides use (distance along the edge, distance through the thickness).
 */
export function plateSolid(plate: PlateElement): MeshData {
  const c = plate.corners;
  const n = plateNormal(c);
  const h = scale(n, plate.thickness / 2);
  const top = c.map((p) => add(p, h));
  const bot = c.map((p) => sub(p, h));
  const mesh: MeshData = { positions: [], normals: [], uvs: [], indices: [] };

  const polygon = (pts: Vec3[], normal: Vec3, uvs: readonly (readonly [number, number])[]) => {
    const base = mesh.positions.length / 3;
    pts.forEach((p, i) => {
      mesh.positions.push(p[0], p[1], p[2]);
      mesh.normals.push(normal[0], normal[1], normal[2]);
      mesh.uvs.push(uvs[i][0], uvs[i][1]);
    });
    for (let i = 1; i < pts.length - 1; i++) mesh.indices.push(base, base + i, base + i + 1);
  };

  // In-plane frame of the mid-surface (h ∥ n, so top and bottom share the corners' uvs).
  const ue = normalize(sub(c[1], c[0]));
  const ve = cross(n, ue);
  const planar = c.map((p): [number, number] => {
    const r = sub(p, c[0]);
    return [dot(r, ue) / UV_UNIT, dot(r, ve) / UV_UNIT];
  });
  const t = plate.thickness / UV_UNIT;

  polygon(top, n, planar);
  polygon([...bot].reverse(), scale(n, -1), [...planar].reverse());
  for (let i = 0; i < c.length; i++) {
    const j = (i + 1) % c.length;
    const side = normalize(cross(sub(c[j], c[i]), n));
    const l = len(sub(c[j], c[i])) / UV_UNIT;
    polygon([bot[i], bot[j], top[j], top[i]], side, [[0, 0], [l, 0], [l, t], [0, t]]);
  }
  return mesh;
}
