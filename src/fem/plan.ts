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
