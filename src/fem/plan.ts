import type { CutPlane } from "../generators/glassSurface";
import { type Vec3, add, sub, scale, cross, len, normalize, WORLD_Z } from "./vec";

export type P2 = readonly [number, number];

export const at = ([x, y]: P2, z = 0): Vec3 => [x, y, z];

/** One side of a counter-clockwise plan polygon, with the bisector planes at its two corners. */
export interface Side {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly length: number;
  /** Unit vector along the side. */
  readonly along: Vec3;
  /** Horizontal unit normal towards the inside. */
  readonly inward: Vec3;
  /** Planes through the two corners, keeping the side's own sector: the bisectors with the neighbours. */
  readonly corners: readonly CutPlane[];
}

export function sidesOf(polygon: readonly P2[]): Side[] {
  const n = polygon.length;
  const dir = (i: number) => normalize(sub(at(polygon[(i + 1) % n]), at(polygon[i])));
  return polygon.map((p, i) => {
    const a = at(p);
    const b = at(polygon[(i + 1) % n]);
    const along = dir(i);
    return {
      a, b, along, length: len(sub(b, a)), inward: cross(WORLD_Z, along),
      corners: [
        { point: a, normal: normalize(add(dir((i + n - 1) % n), along)) },
        { point: b, normal: scale(normalize(add(along, dir((i + 1) % n))), -1) },
      ],
    };
  });
}

/** Signed area: positive for a counter-clockwise polygon. */
export const signedArea = (polygon: readonly P2[]) =>
  polygon.reduce((sum, [x, y], i) => {
    const [nx, ny] = polygon[(i + 1) % polygon.length];
    return sum + (x * ny - nx * y);
  }, 0) / 2;

/** The polygon turned counter-clockwise. */
export const counterClockwise = (polygon: readonly P2[]): P2[] =>
  signedArea(polygon) < 0 ? [...polygon].reverse() : [...polygon];

export const centroid = (polygon: readonly P2[]): P2 => [
  polygon.reduce((s, [x]) => s + x, 0) / polygon.length,
  polygon.reduce((s, [, y]) => s + y, 0) / polygon.length,
];

/**
 * Regular polygon with the given number of sides around `center`. `rotation` is the angle of the
 * first corner from +X (default 0: a corner on +X, so a side faces the front for an octagon).
 */
export function regularPolygon(sides: number, radius: number, center: P2 = [0, 0], rotation = 0): P2[] {
  return Array.from({ length: sides }, (_, i) => {
    const angle = rotation + (2 * Math.PI * i) / sides;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
}

/** Radius of a regular polygon from the distance of its sides to the centre. */
export const radiusOfApothem = (sides: number, apothem: number) => apothem / Math.cos(Math.PI / sides);

/** Convex hull (counter-clockwise, no collinear points) of a set of points. */
export function convexHull(points: readonly P2[]): P2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross2 = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: readonly P2[]) => {
    const h: P2[] = [];
    for (const p of pts) {
      while (h.length >= 2 && cross2(h[h.length - 2], h[h.length - 1], p) <= 1e-9) h.pop();
      h.push(p);
    }
    return h;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Convex polygon moved out by `distance` (in by a negative one): every side stays parallel, the
 * corners are where the moved sides meet.
 */
export function offsetPolygon(polygon: readonly P2[], distance: number): P2[] {
  const sides = sidesOf(polygon);
  const n = sides.length;
  return sides.map((s, i) => {
    const m = sides[(i + n - 1) % n];
    // Lines: point moved out along -inward, direction along.
    const p = sub(s.a, scale(s.inward, distance));
    const q = sub(m.a, scale(m.inward, distance));
    const det = m.along[0] * s.along[1] - m.along[1] * s.along[0];
    if (Math.abs(det) < 1e-12) return [p[0], p[1]];
    const d = sub(p, q);
    const t = (d[0] * s.along[1] - d[1] * s.along[0]) / det;
    const c = add(q, scale(m.along, t));
    return [c[0], c[1]];
  });
}

/**
 * Outline of the union of convex polygons that touch or overlap, walked around the outside:
 * from the leftmost corner along the edges, switching to another polygon wherever its boundary
 * crosses or touches the one being followed and turns further out. A corner where two polygons
 * only touch is passed twice, once on each way round.
 */
export function unionOutline(polygons: readonly (readonly P2[])[], tol = 1e-6): P2[] {
  const parts = polygons.map(counterClockwise).filter((q) => q.length >= 3);
  if (parts.length === 1) return parts[0];
  const edges = parts.flatMap((q, p) => q.map((a, i): { a: P2; b: P2; p: number; i: number } => ({ a, b: q[(i + 1) % q.length], p, i })));
  const same = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const d = (a: P2, b: P2): P2 => [b[0] - a[0], b[1] - a[1]];
  const cross2 = (u: P2, v: P2) => u[0] * v[1] - u[1] * v[0];
  const dot2 = (u: P2, v: P2) => u[0] * v[0] + u[1] * v[1];
  /** Parameter of q on the edge, or null when off its line. */
  const along = (e: { a: P2; b: P2 }, q: P2): number | null => {
    const u = d(e.a, e.b);
    const l = Math.hypot(u[0], u[1]);
    if (Math.abs(cross2(u, d(e.a, q))) / l > tol) return null;
    return dot2(u, d(e.a, q)) / (l * l);
  };
  /** Ways on from q: forward along an edge q lies on, or the next edge of a polygon q is a corner of. */
  const leaving = (q: P2): { dir: P2; p: number; i: number }[] =>
    edges.flatMap((e) => {
      const t = along(e, q);
      if (t === null || t < -tol || t > 1 + tol) return [];
      if (same(q, e.b)) {
        const next = edges.find((n) => n.p === e.p && n.i === (e.i + 1) % parts[e.p].length)!;
        return [{ dir: d(next.a, next.b), p: next.p, i: next.i }];
      }
      return [{ dir: d(e.a, e.b), p: e.p, i: e.i }];
    });
  // Start at the leftmost corner: it is on the outside.
  const start = edges.map((e) => e.a).reduce((best, q) => (q[0] < best[0] - tol || (Math.abs(q[0] - best[0]) <= tol && q[1] < best[1]) ? q : best));
  const out: P2[] = [];
  let at = start;
  let heading: P2 = [0, -1]; // as if arriving from above: everything on the right is outside
  for (let steps = 0; steps < 4 * edges.length + 4; steps++) {
    const options = leaving(at);
    if (options.length === 0) throw new Error("union: the outline is broken");
    // Turn as far clockwise as possible: the outermost way on.
    const turn = (dir: P2) => Math.atan2(cross2(heading, dir), dot2(heading, dir));
    const choice = options.reduce((best, o) => (turn(o.dir) < turn(best.dir) - 1e-9 ? o : best));
    const e = edges.find((c) => c.p === choice.p && c.i === choice.i)!;
    // Next event along e from `at`: the first point where another polygon's edge meets it, else its end.
    const t0 = along(e, at) ?? 0;
    const u = d(e.a, e.b);
    let tNext = 1;
    for (const o of edges) {
      if (o.p === e.p) continue;
      const v = d(o.a, o.b);
      const den = cross2(u, v);
      const w = d(e.a, o.a);
      if (Math.abs(den) > 1e-12) {
        const t = cross2(w, v) / den;
        const s = cross2(w, u) / den;
        if (t > t0 + 1e-9 && t < tNext - 1e-9 && s >= -1e-9 && s <= 1 + 1e-9) tNext = t;
      }
      for (const q of [o.a, o.b]) {
        const t = along(e, q);
        if (t !== null && t > t0 + 1e-9 && t < tNext - 1e-9) tNext = t;
      }
    }
    const next: P2 = [e.a[0] + u[0] * tNext, e.a[1] + u[1] * tNext];
    if (out.length === 0 || !same(out[out.length - 1], at)) out.push(at);
    heading = u;
    at = next;
    if (same(at, start)) break;
  }
  // Drop the points where the walk went straight on.
  return out.filter((q, i) => {
    const [p, n] = [out[(i + out.length - 1) % out.length], out[(i + 1) % out.length]];
    return Math.abs(cross2(d(p, q), d(q, n))) > tol * Math.hypot(...d(p, n));
  });
}
