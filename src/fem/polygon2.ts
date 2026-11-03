/** 2D polygon helpers (points [x, y], polygons counter-clockwise) for cutting flat panes. */
export type P2 = readonly [number, number];
export type Poly2 = readonly P2[];

export function area2(poly: Poly2): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/** Same polygon, counter-clockwise. */
export function ccw(poly: Poly2): Poly2 {
  return area2(poly) < 0 ? [...poly].reverse() : poly;
}

/** Signed distance of p to the left of the directed line a → b (positive = inside of a CCW edge). */
function side(a: P2, b: P2, p: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / l;
}

/** Keeps the part of `poly` with side(a, b, ·) ≥ offset (Sutherland–Hodgman, one edge). */
function clipHalf(poly: Poly2, a: P2, b: P2, offset = 0, keepLeft = true): P2[] {
  const out: P2[] = [];
  const f = (p: P2) => (keepLeft ? side(a, b, p) - offset : offset - side(a, b, p));
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const fp = f(p);
    const fq = f(q);
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Intersection of a convex polygon (or any polygon) with a convex CCW polygon. */
export function clipConvex(poly: Poly2, convex: Poly2): P2[] {
  let out: P2[] = [...poly];
  for (let i = 0; i < convex.length && out.length >= 3; i++) {
    out = clipHalf(out, convex[i], convex[(i + 1) % convex.length]);
  }
  return out.length >= 3 ? out : [];
}

/**
 * Convex polygon minus a convex CCW polygon, as few convex pieces as possible
 * (half-plane splits, then neighbouring pieces re-merged where their union is convex).
 */
export function subtractConvex(poly: Poly2, convex: Poly2): P2[][] {
  const common = clipConvex(poly, convex);
  if (!common.length || Math.abs(area2(common)) < 1e-9) return [[...poly]];
  const pieces: P2[][] = [];
  let rest: P2[] = [...poly];
  for (let i = 0; i < convex.length && rest.length >= 3; i++) {
    const a = convex[i];
    const b = convex[(i + 1) % convex.length];
    const outside = clipHalf(rest, a, b, 0, false);
    if (outside.length >= 3 && Math.abs(area2(outside)) > 1e-9) pieces.push(outside);
    rest = clipHalf(rest, a, b);
  }
  return mergeConvex(pieces);
}

/** Greedily merges consecutive convex pieces whose union is convex (hull area = sum). */
function mergeConvex(pieces: P2[][]): P2[][] {
  const out: P2[][] = [];
  for (const pc of pieces) {
    const last = out[out.length - 1];
    if (last) {
      const hull = convexHull([...last, ...pc]);
      const sum = Math.abs(area2(last)) + Math.abs(area2(pc));
      if (Math.abs(area2(hull) - sum) <= 1e-7 * Math.max(1, sum)) {
        out[out.length - 1] = hull;
        continue;
      }
    }
    out.push(pc);
  }
  return out;
}

/** Convex hull, counter-clockwise (monotone chain). */
export function convexHull(points: Poly2): P2[] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Convex polygon shrunk by distance d on every edge (empty if it vanishes). */
export function insetConvex(poly: Poly2, d: number): P2[] {
  let out: P2[] = [...poly];
  for (let i = 0; i < poly.length && out.length >= 3; i++) {
    out = clipHalf(out, poly[i], poly[(i + 1) % poly.length], d);
  }
  return out.length >= 3 ? out : [];
}

/** Drops nearly coincident consecutive vertices. */
export function simplify(poly: Poly2, tol = 1e-6): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > tol) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= tol) out.pop();
  return out;
}

/**
 * Points of the circular arc from p (tangent t) to q, both ends included.
 * Same definition as an arc element, in 2D.
 */
export function arcPoints(p: P2, t: P2, q: P2, segments: number): P2[] {
  const tl = Math.hypot(t[0], t[1]);
  const tx = t[0] / tl;
  const ty = t[1] / tl;
  const cx = q[0] - p[0];
  const cy = q[1] - p[1];
  const along = cx * tx + cy * ty;
  let ux = cx - along * tx;
  let uy = cy - along * ty;
  const ul = Math.hypot(ux, uy);
  if (ul < 1e-12) return [p, q]; // straight
  ux /= ul;
  uy /= ul;
  const r = (cx * cx + cy * cy) / (2 * (cx * ux + cy * uy));
  const center: P2 = [p[0] + ux * r, p[1] + uy * r];
  const a0 = Math.atan2(p[1] - center[1], p[0] - center[0]);
  const a1 = Math.atan2(q[1] - center[1], q[0] - center[0]);
  // Turning direction: left of the tangent → counter-clockwise.
  const dir = tx * uy - ty * ux > 0 ? 1 : -1;
  let sweep = (a1 - a0) * dir;
  while (sweep < 0) sweep += 2 * Math.PI;
  const pts: P2[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = a0 + (dir * sweep * i) / segments;
    pts.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  return pts;
}

export function circlePoints(c: P2, r: number, segments: number): P2[] {
  return Array.from({ length: segments }, (_, i): P2 => {
    const a = (2 * Math.PI * i) / segments;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  });
}
