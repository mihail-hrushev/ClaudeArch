import type { Member } from "./types";
import { discretize, pointAtHeight } from "./discretize";
import { type Vec3, add, sub, scale, dot, cross, len, normalize } from "./vec";

const polylineLength = (nodes: readonly Vec3[]) =>
  nodes.slice(1).reduce((s, p, i) => s + len(sub(p, nodes[i])), 0);

/** Heights of `count + 1` points spaced at equal arc length along a rising polyline. */
function zAtEqualArcLength(nodes: readonly Vec3[], count: number): number[] {
  const total = polylineLength(nodes);
  const zs: number[] = [nodes[0][2]];
  let acc = 0;
  let i = 1;
  for (let k = 1; k < count; k++) {
    const target = (total * k) / count;
    while (acc + len(sub(nodes[i], nodes[i - 1])) < target) acc += len(sub(nodes[i], nodes[i - 1])), i++;
    const seg = len(sub(nodes[i], nodes[i - 1]));
    zs.push(nodes[i - 1][2] + ((nodes[i][2] - nodes[i - 1][2]) * (target - acc)) / seg);
  }
  zs.push(nodes[nodes.length - 1][2]);
  return zs;
}

/** A horizontal course: straight line from member A to member B at one height. */
export type Course = readonly [Vec3, Vec3];

/**
 * Horizontal courses between two rising members (exact curve points at equal heights),
 * spaced at equal arc length along member `a`, at most `courseSpacing` apart.
 * For a cylindrical web pass its generating wall arch as `a`: the course spacing along the
 * arch is then the pane height.
 */
export function horizontalCourses(a: Member, b: Member, courseSpacing: number): Course[] {
  const na = discretize(a).nodes;
  const nb = discretize(b).nodes;
  const levels = Math.max(1, Math.ceil(polylineLength(na) / courseSpacing));
  const z0 = Math.max(na[0][2], nb[0][2]);
  const z1 = Math.min(na[na.length - 1][2], nb[nb.length - 1][2]);
  return zAtEqualArcLength(na, levels).map((z) => {
    const zc = Math.min(z1, Math.max(z0, z));
    return [pointAtHeight(a, zc), pointAtHeight(b, zc)];
  });
}

export interface Tile {
  /** Flat convex polygon, counter-clockwise around `normal`. */
  readonly corners: Vec3[];
  readonly normal: Vec3;
  /** True when the pane is a full rectangle (not cut by a rib). */
  readonly full: boolean;
  /** Course strip index and column index (columns aligned across strips). */
  readonly row: number;
  readonly col: number;
}

type P2 = readonly [number, number];

/** Clip a convex polygon by the half-plane n·p ≥ c (Sutherland–Hodgman). */
function clip(poly: P2[], n: P2, c: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = n[0] * p[0] + n[1] * p[1] - c;
    const dq = n[0] * q[0] + n[1] * q[1] - c;
    if (dp >= 0) out.push(p);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

const area2 = (poly: P2[]) =>
  poly.reduce((s, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

/** Shrink a CCW convex polygon by distance d (each edge moved inward). */
function inset(poly: P2[], d: number): P2[] {
  let out = poly;
  for (let i = 0; i < poly.length && out.length >= 3; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const l = Math.hypot(ex, ey);
    if (l < 1e-12) continue;
    const n: P2 = [-ey / l, ex / l]; // inward for CCW
    out = clip(out, n, n[0] * p[0] + n[1] * p[1] + d);
  }
  return out;
}

/**
 * Rectangular flat panes between consecutive parallel courses.
 * Every strip between two parallel courses is planar; it is cut into columns of width
 * `tileSize` measured along the course direction from `origin` (so joints line up across
 * strips). Interior panes are exact rectangles; panes at the strip ends are cut by the
 * members. Each pane is shrunk by gap/2 on every edge (joint `gap` between panes).
 * Slivers smaller than 1% of a full pane are dropped (they lie under the ribs).
 * Courses must be parallel (same direction), e.g. from a groin-vault web.
 */
export function rectangularTiles(courses: readonly Course[], tileSize: number, gap: number, origin: Vec3): Tile[] {
  const tiles: Tile[] = [];
  const minArea = Math.max((gap * gap) / 4, 0.01 * tileSize * tileSize);
  for (let r = 0; r < courses.length - 1; r++) {
    const [a0, b0] = courses[r];
    const [a1, b1] = courses[r + 1];
    const u = normalize(sub(b0, a0).every((v) => Math.abs(v) < 1e-9) ? sub(b1, a1) : sub(b0, a0));
    const rise = sub(a1, a0);
    const v = normalize(sub(rise, scale(u, dot(rise, u))));
    // Strip plane coordinates: s along the course (from origin), t across (from course r).
    const to2 = (p: Vec3): P2 => [dot(sub(p, origin), u), dot(sub(p, a0), v)];
    const from2 = ([s, t]: P2): Vec3 => add(add(a0, scale(u, s - dot(sub(a0, origin), u))), scale(v, t));
    // CCW in (s, t) ⇒ CCW around u × v in 3D.
    let strip: P2[] = [to2(a0), to2(b0), to2(b1), to2(a1)];
    if (area2(strip) < 0) strip = strip.reverse();
    const normal = cross(u, v);

    const ss = strip.map((p) => p[0]);
    const k0 = Math.floor(Math.min(...ss) / tileSize);
    const k1 = Math.ceil(Math.max(...ss) / tileSize);
    const h = strip.map((p) => p[1]);
    const tMin = Math.min(...h);
    const tMax = Math.max(...h);
    for (let k = k0; k < k1; k++) {
      const sA = k * tileSize;
      const sB = sA + tileSize;
      let cell = clip(clip(strip, [1, 0], sA), [-1, 0], -sB);
      if (cell.length < 3 || area2(cell) < 1e-9) continue;
      const full =
        cell.length === 4 &&
        Math.abs(area2(cell) - tileSize * (tMax - tMin)) < 1e-6 * tileSize * (tMax - tMin);
      cell = inset(cell, gap / 2);
      if (cell.length < 3 || area2(cell) < minArea) continue;
      tiles.push({ corners: cell.map(from2), normal, full, row: r, col: k });
    }
  }
  return tiles;
}
