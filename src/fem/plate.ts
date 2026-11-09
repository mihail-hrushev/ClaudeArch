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

type P2 = readonly [number, number];
const cross2 = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Triangles of a simple polygon given in its plane, keeping its winding: a fan when it is
 * convex, ear clipping otherwise (e.g. a pane between two arches).
 */
export function triangulate(pts: readonly P2[]): [number, number, number][] {
  const m = pts.length;
  let area = 0;
  for (let i = 0; i < m; i++) area += pts[i][0] * pts[(i + 1) % m][1] - pts[(i + 1) % m][0] * pts[i][1];
  const sign = area < 0 ? -1 : 1;
  const turn = (i: number, j: number, k: number) => sign * cross2(pts[i], pts[j], pts[k]);
  const fan = (): [number, number, number][] => Array.from({ length: Math.max(0, m - 2) }, (_, i) => [0, i + 1, i + 2]);
  if (pts.every((_, i) => turn((i + m - 1) % m, i, (i + 1) % m) >= -1e-9)) return fan();

  const left = pts.map((_, i) => i);
  const out: [number, number, number][] = [];
  const inside = (q: P2, a: number, b: number, d: number) =>
    turn(a, b, d) > 0 && sign * cross2(pts[a], pts[b], q) > 1e-9 && sign * cross2(pts[b], pts[d], q) > 1e-9 && sign * cross2(pts[d], pts[a], q) > 1e-9;
  let guard = m * m;
  while (left.length > 3 && guard-- > 0) {
    const k = left.length;
    let clipped = false;
    for (let x = 0; x < k; x++) {
      const a = left[(x + k - 1) % k], b = left[x], d = left[(x + 1) % k];
      if (turn(a, b, d) <= 1e-12) continue;
      if (left.some((v) => v !== a && v !== b && v !== d && inside(pts[v], a, b, d))) continue;
      out.push([a, b, d]);
      left.splice(x, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (left.length === 3) out.push([left[0], left[1], left[2]]);
  else for (let i = 1; i < left.length - 1; i++) out.push([left[0], left[i], left[i + 1]]);
  return out;
}

/** How often the bevel width is halved for a piece too small to take it, before it is dropped. */
const BEVEL_RETRIES = 6;

/**
 * Convex polygon with every edge moved in by `width`, or null when the edges would cross
 * (an edge reversing or vanishing).
 */
function insetPolygon(c: readonly Vec3[], n: Vec3, width: number): Vec3[] | null {
  const m = c.length;
  const inward = c.map((p, i) => normalize(cross(n, sub(c[(i + 1) % m], p))));
  const inset = c.map((p, i) => {
    const a = inward[(i + m - 1) % m];
    const b = inward[i];
    const k = 1 + dot(a, b);
    return k < 1e-6 ? null : add(p, scale(add(a, b), width / k));
  });
  if (inset.some((q) => q === null)) return null;
  const q = inset as Vec3[];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const edge = sub(q[j], q[i]);
    if (dot(edge, sub(c[j], c[i])) <= 0 || len(edge) <= 1e-9) return null;
  }
  return q;
}

/**
 * Solid of a plate: mid-surface polygon extruded ±thickness/2 along its normal. Flat shaded.
 * Texture uvs: faces use a planar frame with origin corner 0 and u along edge 0 → 1;
 * sides use (distance along the edge, distance through the thickness).
 * With `bevel` the top face is inset by its width and a sloped strip of its depth runs round
 * it down to the edge; top and strips share the planar uvs, the sides end under the strips.
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
    for (const [a, b, d] of triangulate(uvs)) mesh.indices.push(base + a, base + b, base + d);
  };

  // In-plane frame of the mid-surface (h ∥ n, so top and bottom share the corners' uvs).
  const ue = normalize(sub(c[1], c[0]));
  const ve = cross(n, ue);
  const uv = (p: Vec3): [number, number] => {
    const r = sub(p, c[0]);
    return [dot(r, ue) / UV_UNIT, dot(r, ve) / UV_UNIT];
  };
  const planar = c.map(uv);
  const t = plate.thickness / UV_UNIT;

  const facets = plate.bevel && bevelOf(c, n, plate.bevel, plate.thickness);
  if (facets) {
    const { inset, depth } = facets;
    const rim = c.map((p) => add(p, scale(n, plate.thickness / 2 - depth)));
    const crest = inset.map((p) => add(p, h));
    polygon(crest, n, crest.map(uv));
    polygon([...bot].reverse(), scale(n, -1), [...planar].reverse());
    const tr = (plate.thickness - depth) / UV_UNIT;
    for (let i = 0; i < c.length; i++) {
      const j = (i + 1) % c.length;
      const strip = [rim[i], rim[j], crest[j], crest[i]];
      polygon(strip, normalize(cross(sub(strip[1], strip[0]), sub(strip[3], strip[0]))), strip.map(uv));
      const side = normalize(cross(sub(c[j], c[i]), n));
      const l = len(sub(c[j], c[i])) / UV_UNIT;
      polygon([bot[i], bot[j], rim[j], rim[i]], side, [[0, 0], [l, 0], [l, tr], [0, tr]]);
    }
    return mesh;
  }

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

/** The inset top outline of a bevelled plate, with the width halved until the piece takes it; null if never. */
function bevelOf(c: readonly Vec3[], n: Vec3, bevel: NonNullable<PlateElement["bevel"]>, thickness: number) {
  const depth = Math.min(bevel.depth, thickness);
  if (!(bevel.width > 0) || !(depth > 0)) return null;
  let width = bevel.width;
  for (let i = 0; i <= BEVEL_RETRIES; i++, width /= 2) {
    const inset = insetPolygon(c, n, width);
    if (inset) return { inset, depth };
  }
  return null;
}
