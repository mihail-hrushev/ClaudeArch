import type { Element } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type LocalFrame, frameFromUp } from "../fem/placement";
import { type Vec3, add, sub, scale, dot, cross, len, normalize } from "../fem/vec";
import { type CutPlane, type GlassDetail, type GlassSurface, type GlassSurfaceParams, axisOffset } from "./glassSurface";

/**
 * Structural glass block curved in two directions: a clone of `glassSurface` (same parameters,
 * details and load path, its code copied so the two can change apart) with a second tangent.
 *
 *   tile → frames → main ribs
 *
 * `tangent` bends the section, from the base up to `alongZ`, as in `glassSurface`. `tangentX`
 * bends the base line, from the base to `alongX`, the same way: the circle through both points
 * leaving the base along the tangent, in the local XY plane. With the default `tangentX` [1, 0]
 * the base line is straight and the block is the one `glassSurface` makes.
 *
 * `sweep` says how the section travels along a curved base line:
 * - "slide" (default): it moves along the arc without turning, so every main rib follows the
 *   same arc in a plane parallel to local YZ and the top edge is a copy of the base line. Any
 *   two tangents work. Tiles are parallelograms with edges of exactly `tile.width` and
 *   `tile.length`, skewed where the base line runs along the direction the section leans in.
 * - "revolve": it turns with the arc and stays square to it, about the arc's axis (parallel to
 *   local Z): a piece of a surface of revolution, e.g. a dome or an apse. Tiles are symmetric
 *   trapezoids whose width follows the section's distance from the axis (triangles on it). The
 *   section must stay on one side of the axis.
 *
 * `tilt` leans the section in its own plane about the base line, by an angle changing evenly
 * from the base to `alongX`. A changing lean twists the surface, which is then faceted column by
 * column as along a curved base line, even when the base line is straight.
 *
 * Stations along X are arc lengths of the base line: `ribStep`, `ribStations` and the padding
 * left and right are measured on it, and `tile.width` is the chord of one tile column there.
 *
 * Along a curved base line the surface is faceted column by column:
 * - Tiles stay flat: each fills the facet between two column joints and two row joints.
 * - Horizontal frames are one straight piece per tile column, each leaning on the next and the
 *   outer ones on the ribs.
 * - Main ribs are arcs in their section plane when revolved. Slid, the glass turns along a rib,
 *   so the rib is one straight piece per tile row, each square to the glass beside it.
 * - A rib along a cut or around an opening runs facet by facet.
 */
export interface GlassSurface2Params extends GlassSurfaceParams {
  /**
   * Direction of the base line at the base, as local [x, y] (default [1, 0]: straight to
   * `alongX`, a block flat along X). With the base and `alongX` it fixes the circle of the base
   * line: [0, 1] is a semicircle bulging towards the structure, [0, -1] one bulging towards the
   * glass side, [1, 1] leaves at 45 degrees.
   */
  readonly tangentX?: readonly [number, number];
  /** How the section travels along a curved base line (default "slide"); see above. */
  readonly sweep?: "slide" | "revolve";
  /**
   * Lean of the section, degrees at the base and at `alongX` (default [0, 0]), changing evenly
   * along the base line: the section turns in its own plane about the base line, positive tops
   * leaning towards the structure. A changing lean twists the surface, so its tiles are only
   * nearly flat; each is made flat through the middles of its edges.
   */
  readonly tilt?: readonly [number, number];
  /**
   * Further points the base line runs on through after `alongX`, each reached by an arc leaving
   * the one before in the direction it arrived in (a polyarch). They must lie in the local XY
   * plane. Stations, ribs and tiles run on along the whole line without a break at the joints.
   */
  readonly through?: readonly Vec3[];
}

/** A glass block that also knows the circle of its base line. */
export interface GlassSurface2 extends GlassSurface {
  /** Radius of the base line (Infinity when straight). */
  readonly radiusX: number;
}

const RIB_COLOR: Vec3 = [0.3, 0.32, 0.36];
const FRAME_COLOR: Vec3 = [0.72, 0.74, 0.76];
const GLASS_COLOR: Vec3 = [0.62, 0.85, 0.82];
const EPS = 1e-9;

type P2 = readonly [number, number];

/**
 * A line or circular arc in a plane, by arc length s. Points and directions are [u, v] pairs:
 * [y, z] for the section, [y, x] for the base line, so both read "sideways, onwards".
 */
export interface Curve {
  readonly radius: number;
  /** Signed: the heading turns from +v towards −u by this much per unit length. */
  readonly curvature: number;
  readonly length: number;
  at(s: number): P2;
  /** Unit tangent. */
  tangent(s: number): P2;
  /** Unit normal: towards the structure for the section, the local Y axis at a station of the base line. */
  normal(s: number): P2;
  /** Arc length under a chord of the given length. */
  arcOfChord(chord: number): number;
}

/** Circular arc from (0, 0) to `end` leaving along `direction`; a line if along the chord. */
function arcOf(end: P2, direction: P2, tangentName: string, endName: string): Curve {
  const chord = Math.hypot(end[0], end[1]);
  if (chord < EPS) throw new Error(`glassSurface2: ${endName} leaves no length`);
  // Headings are measured from +v towards +u.
  const chordHeading = Math.atan2(end[0], end[1]);
  const start = Math.atan2(direction[0], direction[1]);
  const phi = Math.atan2(Math.sin(start - chordHeading), Math.cos(start - chordHeading)); // tangent from the chord
  if (Math.PI - Math.abs(phi) < 1e-6) throw new Error(`glassSurface2: ${tangentName} points away from ${endName}`);
  if (Math.abs(phi) < EPS) {
    const [du, dv] = [end[0] / chord, end[1] / chord];
    return {
      radius: Infinity, curvature: 0, length: chord, at: (s) => [s * du, s * dv], tangent: () => [du, dv], normal: () => [dv, -du],
      arcOfChord: (c) => c,
    };
  }
  const k = (2 * Math.sin(phi)) / chord; // signed curvature
  const heading = (s: number) => start - k * s;
  return {
    radius: 1 / Math.abs(k),
    curvature: k,
    length: (2 * phi) / k,
    at: (s) => [(Math.cos(heading(s)) - Math.cos(start)) / k, (Math.sin(start) - Math.sin(heading(s))) / k],
    tangent: (s) => [Math.sin(heading(s)), Math.cos(heading(s))],
    normal: (s) => [Math.cos(heading(s)), -Math.sin(heading(s))],
    arcOfChord: (chord) => (2 * Math.asin(Math.min(1, (chord * Math.abs(k)) / 2))) / Math.abs(k),
  };
}

/**
 * Curves joined end to end, each starting at the given point: one curve by arc length over all.
 * Its radius is the smallest of theirs; a chord is measured on the most curved one.
 */
function chained(pieces: readonly Curve[], starts: readonly P2[]): Curve {
  const offsets = pieces.map((_, i) => pieces.slice(0, i).reduce((sum, c) => sum + c.length, 0));
  const length = offsets[offsets.length - 1] + pieces[pieces.length - 1].length;
  const find = (s: number) => {
    let i = pieces.length - 1;
    while (i > 0 && s < offsets[i]) i--;
    return i;
  };
  return {
    radius: Math.min(...pieces.map((c) => c.radius)),
    curvature: NaN,
    length,
    at: (s) => {
      const i = find(s);
      const [u, v] = pieces[i].at(s - offsets[i]);
      return [starts[i][0] + u, starts[i][1] + v];
    },
    tangent: (s) => pieces[find(s)].tangent(s - offsets[find(s)]),
    normal: (s) => pieces[find(s)].normal(s - offsets[find(s)]),
    arcOfChord: (chord) => Math.max(...pieces.map((c) => c.arcOfChord(chord))),
  };
}

/** The part of a curve from `from` to `to`, in the same coordinates. */
const trimmed = (c: Curve, from: number, to: number): Curve => ({
  radius: c.radius, curvature: c.curvature, length: to - from,
  at: (s) => c.at(from + s), tangent: (s) => c.tangent(from + s), normal: (s) => c.normal(from + s),
  arcOfChord: c.arcOfChord,
});

type Placement = Pick<GlassSurface2Params, "base" | "alongX" | "alongZ" | "tangent" | "tangentX" | "sweep" | "tilt" | "through" | "facing">;

/** The two curves of the block in its base frame: the section and the base line it is swept along. */
export function curvesOf(p: Placement, frame: LocalFrame): { section: Curve; path: Curve } {
  const top = sub(p.alongZ, p.base);
  const tangent = p.tangent ?? [0, 0, 1];
  if (Math.abs(tangent[0]) > 1e-6 * len(tangent)) throw new Error("glassSurface2: tangent must have no local X component");
  const section = arcOf([dot(top, frame.y), dot(top, frame.z)], [tangent[1], tangent[2]], "tangent", "alongZ");
  const [alongX, alongY] = p.tangentX ?? [1, 0];
  const pieces = [arcOf([0, len(sub(p.alongX, p.base))], [alongY, alongX], "tangentX", "alongX")];
  const starts: P2[] = [[0, 0]];
  (p.through ?? []).forEach((q, i) => {
    const d = sub(q, p.base);
    if (Math.abs(dot(d, frame.z)) > 1e-6 * len(d)) throw new Error(`glassSurface2: through[${i}] does not lie in the plane of the base line (local XY)`);
    const prev = pieces[pieces.length - 1];
    const start = starts[starts.length - 1];
    const [u0, v0] = prev.at(prev.length);
    const from: P2 = [start[0] + u0, start[1] + v0];
    pieces.push(arcOf([dot(d, frame.y) - from[0], dot(d, frame.x) - from[1]], prev.tangent(prev.length), `the direction arriving at through[${i}]`, `through[${i}]`));
    starts.push(from);
  });
  const path = pieces.length === 1 ? pieces[0] : chained(pieces, starts);
  // Revolved across the axis of the base line the surface would turn inside out.
  const [lean0, lean1] = (p.tilt ?? [0, 0]).map((d) => (d * Math.PI) / 180);
  for (const piece of pieces) {
    for (let j = 0; p.sweep === "revolve" && piece.curvature !== 0 && j <= 16; j++) {
      const lean = lean0 + ((lean1 - lean0) * j) / 16;
      for (let i = 0; i <= 64; i++) {
        const [y, z] = section.at((section.length * i) / 64);
        if (1 + piece.curvature * (y * Math.cos(lean) + z * Math.sin(lean)) < -1e-9) {
          throw new Error("glassSurface2: the section crosses the axis of the base line (it runs further than the radius tangentX gives); sweep \"slide\" has no such limit");
        }
      }
    }
  }
  return { section, path };
}

/** Length of the base line from the base to `alongX`: the width the rib stations are measured on. */
export function baseLineLength(p: Placement): number {
  return curvesOf(p, baseFrame(p)).path.length;
}

/** Division points 0 … total, `step` apart (fit "equal": as close to `step` as fits evenly). */
function stations(total: number, step: number, fit: "cut" | "equal"): number[] {
  const n = Math.max(1, Math.ceil(total / step - 1e-9));
  if (fit === "equal") return Array.from({ length: n + 1 }, (_, i) => (total * i) / n);
  return [...Array.from({ length: n }, (_, i) => i * step), total];
}

/** Smallest edge piece of a centred grid, as a share of the tile. */
const MIN_EDGE = 0.25;

/** Grid lines over lo … hi, both included: whole steps from the `anchor` side, or centred. */
function gridLines(
  lo: number, hi: number, step: number, anchor: "start" | "center" | "end", fit: "cut" | "equal", jointAtCentre = false,
): number[] {
  const total = hi - lo;
  if (fit === "equal") return stations(total, step, "equal").map((q) => lo + q);
  // Centred on a joint (main ribs on the grid: one stands on the centre line), whole tiles out to each side.
  if (anchor === "center" && jointAtCentre) {
    const mid = (lo + hi) / 2;
    let each = Math.floor(total / 2 / step + 1e-9);
    const rest = total / 2 - each * step;
    if (each > 0 && rest > 1e-9 * step && rest < MIN_EDGE * step) each -= 1;
    return [lo, ...Array.from({ length: 2 * each + 1 }, (_, i) => mid + (i - each) * step), hi];
  }
  let whole = Math.floor(total / step + 1e-9);
  let rest = total - whole * step;
  // Centred: no thin strips at the edges; one tile less makes the edge pieces wider instead.
  if (anchor === "center" && whole > 0 && rest > 1e-9 * step && rest / 2 < MIN_EDGE * step) {
    whole -= 1;
    rest += step;
  }
  const first = lo + (anchor === "start" ? 0 : anchor === "end" ? rest : rest / 2);
  return [lo, ...Array.from({ length: whole + 1 }, (_, i) => first + i * step), hi];
}

/**
 * Rib stations inside 0 … width on the grid joints: from the anchor joint, the joint nearest to
 * every multiple of `step` in both directions (the grid's outer lines are its extent, not joints).
 */
function ribsOnGrid(
  lines: readonly number[], width: number, step: number, anchor: "start" | "center" | "end", tol: number, symmetric = false,
): number[] {
  const joints = lines.slice(1, -1);
  if (!joints.length) return [];
  const middle = (lines[0] + lines[lines.length - 1]) / 2;
  const origin = anchor === "start" ? lines[0] : anchor === "end" ? lines[lines.length - 1] : joints.reduce((best, x) => (Math.abs(x - middle) < Math.abs(best - middle) ? x : best));
  const nearest = (x: number) => joints.reduce((best, j) => (Math.abs(j - x) < Math.abs(best - x) ? j : best));
  const stations: number[] = [];
  for (const sign of [-1, 1]) {
    for (let k = sign > 0 && anchor !== "end" && anchor !== "start" ? 0 : 1; ; k++) {
      const target = origin + sign * k * step;
      if (target < lines[0] - step / 2 || target > lines[lines.length - 1] + step / 2) break;
      // Symmetric: on or past an edge the edge itself carries the surface, no rib snapped back to the last joint.
      if (symmetric && !(target > lines[0] + tol && target < lines[lines.length - 1] - tol)) break;
      stations.push(nearest(target));
    }
  }
  return distinct(stations, tol).filter((x) => x > tol && x < width - tol);
}

/** Sorted values, those closer than `tol` merged. */
const distinct = (values: readonly number[], tol: number) =>
  [...values].sort((a, b) => a - b).filter((v, i, all) => i === 0 || v - all[i - 1] > tol);

/** A plane in the block's local frame with a unit normal, and the id of the rib along it. */
interface Boundary extends CutPlane {
  readonly id: string;
}

/** Local base frame of the block: from global Z, or turned to face `facing`. */
export function baseFrame(p: Pick<GlassSurfaceParams, "base" | "alongX" | "facing">): LocalFrame {
  if (!p.facing) return frameFromUp(p.base, p.alongX);
  const x = normalize(sub(p.alongX, p.base));
  const away = sub(p.facing, scale(x, dot(p.facing, x)));
  if (len(away) < 1e-9 * len(p.facing)) throw new Error("glassSurface2: facing must not lie along X");
  const y = normalize(scale(away, -1));
  return { origin: p.base, x, y, z: cross(x, y) };
}

const localPlane = (c: CutPlane, f: LocalFrame, id: string): Boundary => {
  const local = (v: Vec3): Vec3 => [dot(v, f.x), dot(v, f.y), dot(v, f.z)];
  return { id, point: local(sub(c.point, f.origin)), normal: normalize(local(c.normal)), ...(c.profile ? { profile: c.profile } : {}) };
};

/** Signed distance from the plane, positive on the side the normal points to. */
const side = (c: CutPlane, q: Vec3) => dot(sub(q, c.point), c.normal);

/** Part of a → b (as parameters) inside all planes, with the plane stopping each end. */
interface Span {
  readonly t0: number;
  readonly t1: number;
  readonly from?: string;
  readonly to?: string;
}

function spanInside(a: Vec3, b: Vec3, planes: readonly Boundary[], tol: number): Span | null {
  let span: Span = { t0: 0, t1: 1 };
  for (const c of planes) {
    const da = side(c, a);
    const db = side(c, b);
    if (da < -tol && db < -tol) return null;
    const t = da / (da - db);
    if (da < -tol && t > span.t0) span = { ...span, t0: t, from: c.id };
    if (db < -tol && t < span.t1) span = { ...span, t1: t, to: c.id };
  }
  return span.t1 > span.t0 ? span : null;
}

/** Parts of a → b inside `planes` and outside every void. */
function trimSegment(a: Vec3, b: Vec3, planes: readonly Boundary[], voids: readonly (readonly Boundary[])[], tol: number): Span[] {
  const length = len(sub(b, a));
  const first = spanInside(a, b, planes, tol);
  let spans = first ? [first] : [];
  for (const planesOfVoid of voids) {
    const hole = spanInside(a, b, planesOfVoid, tol);
    if (!hole || (hole.t1 - hole.t0) * length <= tol) continue;
    spans = spans.flatMap((s) => {
      if (hole.t1 <= s.t0 || hole.t0 >= s.t1) return [s];
      return [
        ...(hole.t0 > s.t0 ? [{ ...s, t1: hole.t0, to: hole.from }] : []),
        ...(hole.t1 < s.t1 ? [{ ...s, t0: hole.t1, from: hole.to }] : []),
      ];
    });
  }
  return spans.filter((s) => (s.t1 - s.t0) * length > tol);
}

/** Convex polygon cut by one plane (Sutherland–Hodgman); empty if nothing usable is left. */
function clipPolygon(polygon: readonly Vec3[], c: CutPlane, sign: 1 | -1, tol: number): Vec3[] {
  const clipped = polygon.flatMap((q, j) => {
    const r = polygon[(j + 1) % polygon.length];
    const dq = sign * side(c, q);
    const dr = sign * side(c, r);
    const crossing = (dq < 0) !== (dr < 0) ? [add(q, scale(sub(r, q), dq / (dq - dr)))] : [];
    return dq >= 0 ? [q, ...crossing] : crossing;
  });
  const corners = clipped.filter((q, j) => len(sub(q, clipped[(j + 1) % clipped.length])) > tol);
  const area = corners.slice(2).reduce((sum, q, j) => sum + len(cross(sub(corners[j + 1], corners[0]), sub(q, corners[0]))) / 2, 0);
  return area > tol ? corners : [];
}

/** Convex pieces of a polygon inside `planes` and outside every void, and the planes that shaped them. */
function clipTile(polygon: readonly Vec3[], planes: readonly Boundary[], voids: readonly (readonly Boundary[])[], tol: number) {
  const cutBy = new Set<string>();
  let pieces: Vec3[][] = [[...polygon]];
  for (const c of planes) {
    pieces = pieces.flatMap((q) => {
      if (q.every((v) => side(c, v) >= -tol)) return [q];
      cutBy.add(c.id);
      const kept = clipPolygon(q, c, 1, tol);
      return kept.length ? [kept] : [];
    });
  }
  for (const planesOfVoid of voids) {
    pieces = pieces.flatMap((q) => {
      // Peel off what lies outside each plane of the void; the rest is inside it.
      const out: Vec3[][] = [];
      const by: string[] = [];
      let rest: Vec3[] = q;
      for (const c of planesOfVoid) {
        const outside = clipPolygon(rest, c, -1, tol);
        rest = clipPolygon(rest, c, 1, tol);
        if (!rest.length) return [q]; // misses the void
        if (outside.length) {
          out.push(outside);
          by.push(c.id);
        }
      }
      by.forEach((id) => cutBy.add(id));
      return out;
    });
  }
  return { pieces, cutBy: [...cutBy] };
}

/** Continuous parts of 0 … total where `inside` holds, their ends refined by bisection. */
function keptRanges(total: number, inside: (s: number) => boolean): [number, number][] {
  const samples = 256;
  const at = (i: number) => (total * i) / samples;
  const edge = (keep: number, drop: number) => {
    for (let i = 0; i < 50; i++) {
      const mid = (keep + drop) / 2;
      if (inside(mid)) keep = mid;
      else drop = mid;
    }
    return keep;
  };
  const ranges: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    if (!inside(at(i))) continue;
    const first = i;
    while (i < samples && inside(at(i + 1))) i++;
    const s0 = first === 0 ? 0 : edge(at(first), at(first - 1));
    const s1 = i === samples ? total : edge(at(i), at(i + 1));
    if (s1 - s0 > EPS * total) ranges.push([s0, s1]);
  }
  return ranges;
}

/** Drops the nodes of straight runs, so a rib on a flat surface is defined by its ends only. */
const mergeCollinear = (nodes: readonly Vec3[]) => nodes.filter((q, i) =>
  i === 0 || i === nodes.length - 1 || len(cross(normalize(sub(q, nodes[i - 1])), normalize(sub(nodes[i + 1], q)))) > 1e-9);

/** Flat strips each curved direction is split into when measuring the final surface. */
const EXTENT_STRIPS = 64;

/**
 * One flat piece of the surface, between two stations of the base line and two points of the
 * section. Its bottom and top edges are parallel: a rectangle when the base line is straight, a
 * parallelogram when the section slides, a symmetric trapezoid when it revolves (a triangle
 * with one edge on the axis).
 */
interface Facet {
  /** Bottom left, bottom right, top right, top left. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
  /** Middle of the bottom edge. */
  readonly origin: Vec3;
  /** Unit vector along the bottom and top edges. */
  readonly across: Vec3;
  /** Unit vector in the facet square to them, towards the top edge. */
  readonly up: Vec3;
  /** Distance between the bottom and top edges. */
  readonly height: number;
  readonly halfBottom: number;
  readonly halfTop: number;
  /** How far along `across` the middle of the top edge lies from that of the bottom edge. */
  readonly shift: number;
}

/** Where a point of the facet lies: its share of the width (0 left … 1 right) and of the height. */
function located(f: Facet, q: Vec3): [number, number] {
  const d = sub(q, f.origin);
  const t = dot(d, f.up) / f.height;
  const half = f.halfBottom + (f.halfTop - f.halfBottom) * t;
  return [half > EPS ? 0.5 + (dot(d, f.across) - f.shift * t) / (2 * half) : 0.5, t];
}

/** The facet less `gap` along every edge, in the order of its corners: the glass of one tile; empty if none is left. */
function glassOf(f: Facet, gap: number): Vec3[] {
  if (f.height <= 2 * gap) return []; // a leftover narrower than the seam holds no glass
  // The two sides as lines across the height, each moved in by the seam.
  const leanLeft = (f.shift - f.halfTop + f.halfBottom) / f.height;
  const leanRight = (f.shift + f.halfTop - f.halfBottom) / f.height;
  const left = (v: number) => -f.halfBottom + leanLeft * v + gap * Math.hypot(1, leanLeft);
  const right = (v: number) => f.halfBottom + leanRight * v - gap * Math.hypot(1, leanRight);
  const at = (u: number, v: number): Vec3 => add(f.origin, add(scale(f.across, u), scale(f.up, v)));
  const [lo, hi] = [gap, f.height - gap];
  const [below, above] = [right(lo) > left(lo), right(hi) > left(hi)];
  if (!below && !above) return [];
  if (below && above) return [at(left(lo), lo), at(right(lo), lo), at(right(hi), hi), at(left(hi), hi)];
  // Towards the axis the two sides meet before the seam of the row does: a triangle.
  const tip = (right(0) - left(0)) / (leanLeft - leanRight);
  return below ? [at(left(lo), lo), at(right(lo), lo), at(left(tip), tip)] : [at(left(tip), tip), at(right(hi), hi), at(left(hi), hi)];
}

const pieceId = (id: string, piece: number) => (piece === 0 ? id : `${id}_${piece}`);
const ribId = (bay: number) => `rib${bay}`;
const verticalId = (bay: number, col: number, row: number) => `v_b${bay}_c${col}_r${row}`;

/**
 * The curves of the surface left inside its padding, with the cuts moved in and the rib stations
 * measured from its new left edge. The block keeps its frame: only the ranges get shorter.
 */
function withPadding(p: GlassSurface2Params, frame: LocalFrame, section: Curve, path: Curve) {
  const pad = typeof p.padding === "number"
    ? { left: p.padding, right: p.padding, bottom: p.padding, top: p.padding }
    : { left: 0, right: 0, bottom: 0, top: 0, ...p.padding };
  if (pad.left + pad.right >= path.length || pad.bottom + pad.top >= section.length) {
    throw new Error("glassSurface2: padding leaves no surface");
  }
  const [topY, topZ] = section.at(section.length);
  const upward = normalize(add(scale(frame.y, topY), scale(frame.z, topZ)));
  const moved = (c: CutPlane): CutPlane => {
    const normal = normalize(c.normal);
    const [sideways, rising] = [dot(normal, frame.x), dot(normal, upward)];
    const inset = Math.abs(sideways) >= Math.abs(rising)
      ? (sideways > 0 ? pad.left : pad.right)
      : (rising > 0 ? pad.bottom : pad.top);
    return { ...c, point: add(c.point, scale(normal, inset)), normal };
  };
  const inner = path.length - pad.left - pad.right;
  return {
    section: trimmed(section, pad.bottom, section.length - pad.top),
    path: trimmed(path, pad.left, path.length - pad.right),
    cuts: p.cuts?.map(moved),
    ribStations: p.ribStations?.map((x) => x - pad.left).filter((x) => x > 0 && x < inner),
    left: pad.left,
  };
}

export function glassSurface2(name: string, p: GlassSurface2Params): GlassSurface2 {
  const { tile, profiles } = p;
  if (p.ribStep <= 0 || tile.width <= 0 || tile.length <= 0) {
    throw new Error("glassSurface2: rib step and tile size must be > 0");
  }
  const frame = baseFrame(p);
  const whole = curvesOf(p, frame);
  const { section, path, cuts: planes, ribStations, left } = p.padding === undefined
    ? { ...whole, cuts: p.cuts, ribStations: p.ribStations, left: 0 }
    : withPadding(p, frame, whole.section, whole.path);
  const width = path.length;
  const flatX = path.radius === Infinity;
  /** The section keeps its direction along a curved base line, so the glass turns along every rib. */
  const slid = !flatX && p.sweep !== "revolve";
  const [lean0, lean1] = (p.tilt ?? [0, 0]).map((d) => (d * Math.PI) / 180);
  /** The lean changes along the base line: the surface twists, so it is faceted column by column even when straight. */
  /** The surface twists: the lean changes, or the base line runs through arcs of different centres. */
  const tilted = lean0 !== lean1 || (p.through?.length ?? 0) > 0;
  const faceted = !flatX || tilted;
  /** A direction of the section turned by the lean at station x (measured on the whole base line). */
  const leaned = (x: number, [y, z]: P2): P2 => {
    if (lean0 === 0 && lean1 === 0) return [y, z];
    const lean = lean0 + ((lean1 - lean0) * (x + left)) / whole.path.length;
    const [c, s] = [Math.cos(lean), Math.sin(lean)];
    return [y * c + z * s, z * c - y * s];
  };
  const fit = tile.fit ?? "cut";

  /**
   * A direction of the section plane at station x of the base line, as a vector of the block:
   * turned with the base line when the section revolves, as it is when it slides.
   */
  const direction = (x: number, q: P2): Vec3 => {
    const [y, z] = leaned(x, q);
    if (slid) return [0, y, z];
    const [ey, ex] = path.normal(x);
    return [ex * y, ey * y, z];
  };
  /**
   * The normal of the surface towards the structure at station x, where the section's own
   * normal is n. Slid, the surface leans over wherever the base line does not run along X.
   */
  const normalAt = (x: number, n: P2): Vec3 => {
    if (!slid) return direction(x, n);
    const [ey, ex] = path.normal(x);
    const [ny, nz] = leaned(x, n);
    const leaning: Vec3 = [ex * ny, ey * ny, ey * nz];
    if (len(leaning) < 1e-9) throw new Error("glassSurface2: the surface folds where the base line runs along a level section (sweep \"slide\")");
    return normalize(leaning);
  };
  /** A point of the surface by its station x on the base line and a point of the section, moved `offset` along the normal there. */
  const point = (x: number, q: P2, n: P2 = [0, 0], offset = 0): Vec3 => {
    const [oy, ox] = path.at(x);
    const [dx, dy, dz] = direction(x, offset === 0 || slid ? q : [q[0] + n[0] * offset, q[1] + n[1] * offset]);
    const on: Vec3 = [ox + dx, oy + dy, dz];
    return offset === 0 || !slid ? on : add(on, scale(normalAt(x, n), offset));
  };
  const facetOf = (xa: number, xb: number, qa: P2, qb: P2): Facet => {
    const corners = [point(xa, qa), point(xb, qa), point(xb, qb), point(xa, qb)] as const;
    const origin = scale(add(corners[0], corners[1]), 0.5);
    const rise = sub(scale(add(corners[3], corners[2]), 0.5), origin);
    const [ty, tx] = path.tangent((xa + xb) / 2);
    // Twisted, the bottom and top edges are not parallel: the facet runs along their mean.
    const across: Vec3 = tilted
      ? normalize(add(sub(corners[1], corners[0]), sub(corners[2], corners[3])))
      : [tx, ty, 0];
    const shift = dot(rise, across);
    const square = sub(rise, scale(across, shift));
    const height = len(square);
    return {
      corners, origin, across, up: height > EPS ? scale(square, 1 / height) : square, height, shift,
      halfBottom: dot(sub(corners[1], corners[0]), across) / 2, halfTop: dot(sub(corners[2], corners[3]), across) / 2,
    };
  };

  const details: GlassDetail[] = [];

  const ribColor = p.ribColor ?? RIB_COLOR;
  const frameColor = p.frameColor ?? FRAME_COLOR;
  const verticalProfile = profiles.verticalFrame ?? profiles.horizontalFrame;
  const cutProfile = profiles.cutRib ?? profiles.mainRib;
  const openingProfile = profiles.openingRib ?? cutProfile;
  const ribOffset = axisOffset(profiles.mainRib, tile.thickness);
  const horizontalOffset = axisOffset(profiles.horizontalFrame, tile.thickness);
  const verticalOffset = axisOffset(verticalProfile, tile.thickness);
  const gap = (tile.gap ?? 0) / 2;

  const cuts = (planes ?? []).map((c, i) => localPlane(c, frame, `cut${i}`));
  const openings = (p.openings ?? []).map((o, i) => o.map((c, j) => localPlane(c, frame, `open${i}_${j}`)));
  const boundaries = [...cuts, ...openings.flat()];
  // Tiles stop half a seam short of every boundary.
  const moved = (c: Boundary, distance: number): Boundary => ({ ...c, point: add(c.point, scale(c.normal, distance)) });
  const tileCuts = cuts.map((c) => moved(c, gap));
  const tileOpenings = openings.map((o) => o.map((c) => moved(c, -gap)));
  const tol = 1e-6 * width;

  /** Range of X and of arc length s covered by the surface left after all boundaries. */
  const keptExtent = () => {
    const stripsX = faceted ? EXTENT_STRIPS : 1;
    const stripsS = section.radius === Infinity ? 1 : EXTENT_STRIPS;
    const extent = { x0: Infinity, x1: -Infinity, s0: Infinity, s1: -Infinity };
    for (let i = 0; i < stripsS; i++) {
      const [sa, sb] = [(section.length * i) / stripsS, (section.length * (i + 1)) / stripsS];
      for (let j = 0; j < stripsX; j++) {
        const [xa, xb] = [(width * j) / stripsX, (width * (j + 1)) / stripsX];
        const facet = facetOf(xa, xb, section.at(sa), section.at(sb));
        const [a, b] = [facet.corners[0], facet.corners[3]];
        const chord = sub(b, a);
        for (const q of clipTile(facet.corners, cuts, openings, tol).pieces.flat()) {
          // Along a straight base line the strip is measured directly, exactly as glassSurface does.
          const [u, t] = faceted ? located(facet, q) : [0, dot(sub(q, a), chord) / dot(chord, chord)];
          const [x, s] = [faceted ? xa + (xb - xa) * u : q[0] - a[0], sa + (sb - sa) * t];
          extent.x0 = Math.min(extent.x0, x);
          extent.x1 = Math.max(extent.x1, x);
          extent.s0 = Math.min(extent.s0, s);
          extent.s1 = Math.max(extent.s1, s);
        }
      }
    }
    if (extent.x0 > extent.x1) throw new Error("glassSurface2: nothing is left after the cuts");
    return extent;
  };

  // Tile grid: anchored to the final surface, or filled from the base bay by bay.
  const rowStep = section.arcOfChord(tile.length);
  const colStep = path.arcOfChord(tile.width);
  const extent = tile.align ? keptExtent() : null;
  const [alignZ, alignX] = (tile.align ?? "bottom-left").split("-");
  const anchorX = alignX === "left" ? "start" : alignX === "right" ? "end" : "center";
  const rowS = extent
    ? distinct([0, ...gridLines(extent.s0, extent.s1, rowStep, alignZ === "bottom" ? "start" : alignZ === "top" ? "end" : "center", fit), section.length], tol)
    : stations(section.length, rowStep, fit);
  const rows = rowS.length - 1;
  const columnLines = extent
    ? gridLines(extent.x0, extent.x1, colStep, anchorX, fit, p.ribsOnGrid === "symmetric" && !ribStations)
    : null;
  const ribX = ribStations
    ? [0, ...ribStations, width]
    : p.ribsOnGrid && columnLines
      ? [0, ...ribsOnGrid(distinct(columnLines, tol), width, p.ribStep, anchorX, tol, p.ribsOnGrid === "symmetric"), width]
      : stations(width, p.ribStep, "cut");
  /** The column joints of every bay, from its rib to the next. */
  const bayColumns = ribX.slice(0, -1).map((x0, bay) => {
    const x1 = ribX[bay + 1];
    return columnLines
      ? [x0, ...distinct(columnLines, tol).filter((x) => x > x0 + tol && x < x1 - tol), x1]
      : stations(x1 - x0, colStep, fit).map((x) => x0 + x);
  });
  /** Stations between which the surface is flat along X: its two sides, or every column joint of a curved base line. */
  const facetX = faceted ? distinct(bayColumns.flat(), tol) : [0, width];

  /** Inside the cuts and outside the openings; margin > 0 also rejects points on a boundary. */
  const kept = (q: Vec3, margin: number) =>
    cuts.every((c) => side(c, q) >= margin) && openings.every((o) => o.some((c) => side(c, q) < -margin));
  /** The boundary a trimmed rib end stopped on. */
  const boundaryAt = (q: Vec3) => boundaries.reduce((best, c) => (Math.abs(side(c, q)) < Math.abs(side(best, q)) ? c : best)).id;

  /** Frames that fell on a boundary: its rib stands in for them in the load path. */
  const replacedBy = new Map<string, string>();

  /**
   * Straight member trimmed by the boundaries; a trimmed end is carried by the rib there instead.
   * Returns its pieces with the stations they cover, given those of its ends.
   */
  const addMember = (
    d: Pick<GlassDetail, "role" | "bay" | "col" | "row">, id: string, profile: Profile, a: Vec3, b: Vec3, up: Vec3,
    supports: readonly [string, string], [xa, xb]: readonly [number, number] = [0, 0],
  ) => {
    // A frame along a cut would lie inside the rib generated there. Openings need no such test:
    // their planes run on past the hole, and the hole trims what it covers.
    const depth = axisOffset(profile, tile.thickness);
    const reach = Math.max(tol, 1e-3 * tile.length);
    const covering = cuts.find((c) => [a, b].every((q) => Math.abs(side(c, sub(q, scale(up, depth)))) <= reach));
    if (covering) {
      replacedBy.set(id, covering.id);
      return [];
    }
    return trimSegment(a, b, cuts, openings, tol).map((s, i) => {
      const start = add(a, scale(sub(b, a), s.t0));
      const end = add(a, scale(sub(b, a), s.t1));
      details.push({
        ...d,
        supportedBy: [s.from ?? supports[0], s.to ?? supports[1]],
        element: { id: pieceId(id, i), kind: "straight", profile, color: frameColor, start, end, up },
      });
      return { id: pieceId(id, i), x0: xa + (xb - xa) * s.t0, x1: xa + (xb - xa) * s.t1 };
    });
  };

  // Main ribs: in the section plane at their station, concentric with the section, so the arc
  // keeps its tangent and its nodes at the row joints give segments parallel to the tiles.
  // Boundaries shorten, split or remove them.
  const ribPieces = ribX.map((x, i) => {
    const axis = (s: number) => point(x, section.at(s), section.normal(s), ribOffset);
    return keptRanges(section.length, (s) => kept(axis(s), tol)).flatMap(([s0, s1], piece) => {
      const id = pieceId(ribId(i), piece);
      const inner = rowS.filter((s) => s > s0 + tol && s < s1 - tol);
      const ends = [...(s0 > 0 ? [boundaryAt(axis(s0))] : []), ...(s1 < section.length ? [boundaryAt(axis(s1))] : [])];
      if (slid) {
        // The glass turns along the rib: one straight piece per tile row, each square to the glass beside it.
        const joints = [s0, ...inner, s1];
        const rowId = (k: number) => `${id}_r${k}`;
        return joints.slice(0, -1).map((sa, k) => {
          const sb = joints[k + 1];
          details.push({
            role: "mainRib", bay: i, row: k,
            supportedBy: [k > 0 ? rowId(k - 1) : s0 > 0 ? ends[0] : undefined, k < joints.length - 2 ? rowId(k + 1) : s1 < section.length ? ends[ends.length - 1] : undefined]
              .filter((support): support is string => support !== undefined),
            element: {
              id: rowId(k), kind: "straight", start: axis(sa), end: axis(sb), profile: profiles.mainRib,
              up: normalAt(x, section.normal((sa + sb) / 2)), color: ribColor,
            },
          });
          return { id: rowId(k), s0: sa, s1: sb };
        });
      }
      const common = {
        id, start: axis(s0), end: axis(s1), profile: profiles.mainRib,
        up: direction(x, section.normal(s0)), color: ribColor,
      };
      const element: Element = section.radius === Infinity
        ? { ...common, kind: "straight" }
        : {
            ...common, kind: "arc", startTangent: direction(x, section.tangent(s0)), segmentLength: tile.length,
            divisions: [s0, ...inner, s1].map((s) => (s - s0) / (s1 - s0)),
          };
      details.push({ role: "mainRib", element, bay: i, supportedBy: ends });
      return [{ id, s0, s1 }];
    });
  });
  const ribAt = (i: number, s: number) =>
    ribPieces[i].find((r) => s >= r.s0 - tol && s <= r.s1 + tol)?.id ?? ribId(i);

  /** Rib along a boundary: its line through every facet of every tile row, chained from facet to facet. */
  const addBoundaryRib = (
    c: Boundary, planes: readonly Boundary[], voids: readonly (readonly Boundary[])[], profile: Profile,
    address: Pick<GlassDetail, "cut" | "opening">,
  ) => {
    const offset = axisOffset(profile, tile.thickness);
    const chains: { start: Vec3; end: Vec3; nodes: Vec3[]; up: Vec3 }[] = [];
    /** The latest chain with that end at q. */
    const chainAt = (q: Vec3, end: "start" | "end") => {
      for (let i = chains.length - 1; i >= 0; i--) if (len(sub(chains[i][end], q)) <= tol) return chains[i];
      return undefined;
    };
    for (let row = 0; row < rows; row++) {
      const lo = section.normal(rowS[row]);
      const hi = section.normal(rowS[row + 1]);
      for (let k = 0; k < facetX.length - 1; k++) {
        const { corners } = facetOf(facetX[k], facetX[k + 1], section.at(rowS[row]), section.at(rowS[row + 1]));
        const outline: [number, number][] = [[facetX[k], 0], [facetX[k + 1], 0], [facetX[k + 1], 1], [facetX[k], 1]];
        const hits = outline.flatMap(([x, t], i) => {
          const [x2, t2] = outline[(i + 1) % 4];
          const d = side(c, corners[i]);
          const d2 = side(c, corners[(i + 1) % 4]);
          // A plane along the edge of the block counts as crossing it: the rib goes on that edge.
          if (d < tol === d2 < tol) return [];
          const u = Math.min(1, Math.max(0, d / (d - d2)));
          return [{ x: x + (x2 - x) * u, t: t + (t2 - t) * u, at: add(corners[i], scale(sub(corners[(i + 1) % 4], corners[i]), u)) }];
        });
        if (hits.length !== 2) continue;
        // Always upwards along the surface, then along X: neighbours then produce the same rib.
        const flip = Math.abs(hits[0].t - hits[1].t) > EPS ? hits[0].t > hits[1].t : hits[0].x > hits[1].x;
        const [a, b] = flip ? [hits[1], hits[0]] : hits;
        /** Offset within the boundary plane, so that neighbouring blocks share the rib. */
        const node = (u: number) => {
          const t = a.t + (b.t - a.t) * u;
          const n = normalize(normalAt(a.x + (b.x - a.x) * u, [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t]));
          const depth = normalize(sub(n, scale(c.normal, dot(n, c.normal))));
          return { at: add(a.at, scale(sub(b.at, a.at), u)), depth };
        };
        for (const s of trimSegment(a.at, b.at, planes, voids, tol)) {
          const start = node(s.t0);
          const end = node(s.t1);
          const shifted = (q: typeof start) => add(q.at, scale(q.depth, offset));
          // Usually the chain so far runs on. Where the line climbs against X the facets of a row
          // come in the other order: the piece then arrives at a chain's start, or joins two chains.
          const before = chainAt(start.at, "end");
          const after = chainAt(end.at, "start");
          if (before && after && before !== after) {
            before.nodes.push(...after.nodes);
            before.end = after.end;
            chains.splice(chains.indexOf(after), 1);
          } else if (before) {
            before.nodes.push(shifted(end));
            before.end = end.at;
          } else if (after) {
            after.nodes.unshift(shifted(start));
            after.start = start.at;
            after.up = start.depth;
          } else {
            chains.push({ start: start.at, end: end.at, nodes: [shifted(start), shifted(end)], up: start.depth });
          }
        }
      }
    }
    chains.forEach((chain, piece) => {
      const nodes = mergeCollinear(chain.nodes);
      details.push({
        ...address, role: "mainRib", supportedBy: [],
        element: {
          id: pieceId(c.id, piece), kind: "polyline", nodes, start: nodes[0], end: nodes[nodes.length - 1],
          profile, up: chain.up, color: ribColor,
        },
      });
    });
  };
  cuts.forEach((c, i) => addBoundaryRib(c, cuts.filter((o) => o !== c), openings, c.profile ?? cutProfile, { cut: i }));
  openings.forEach((o, i) => o.forEach((c) => {
    const others = openings.filter((other) => other !== o);
    addBoundaryRib(c, [...cuts, ...o.filter((q) => q !== c)], others, openingProfile, { opening: i });
  }));

  for (let bay = 0; bay < ribX.length - 1; bay++) {
    const colX = bayColumns[bay];
    const cols = colX.length - 1;

    // Horizontal frames at every row joint, rib to rib: one member carried by the two ribs, or
    // along a curved base line one piece per tile column, each leaning on the next.
    const spanX = faceted ? colX : [colX[0], colX[cols]];
    const spans = spanX.length - 1;
    const horizontalId = (span: number, row: number) => (faceted ? `h_b${bay}_c${span}_r${row}` : `h_b${bay}_r${row}`);
    const horizontals = rowS.map((s, row) => {
      const q = section.at(s);
      const n = section.normal(s);
      return Array.from({ length: spans }, (_, span) => {
        const [xa, xb] = [spanX[span], spanX[span + 1]];
        return addMember(
          { role: "horizontalFrame", bay, row, ...(faceted ? { col: span } : {}) }, horizontalId(span, row), profiles.horizontalFrame,
          point(xa, q, n, horizontalOffset), point(xb, q, n, horizontalOffset), normalAt((xa + xb) / 2, n),
          [span === 0 ? ribAt(bay, s) : horizontalId(span - 1, row), span === spans - 1 ? ribAt(bay + 1, s) : horizontalId(span + 1, row)],
          [xa, xb],
        );
      }).flat();
    });
    /** The piece of a horizontal frame over x. */
    const horizontalAt = (row: number, x: number) =>
      horizontals[row].find((h) => x >= h.x0 - tol && x <= h.x1 + tol)?.id
      ?? horizontalId(Math.max(0, spanX.findIndex((_, span) => span === spans - 1 || x <= spanX[span + 1])), row);

    for (let row = 0; row < rows; row++) {
      // Rows beyond the final surface hold nothing, though on a curve their frames dip back into it.
      const margin = 1e-3 * tile.length;
      if (extent && (rowS[row + 1] <= extent.s0 + margin || rowS[row] >= extent.s1 - margin)) continue;

      // The tile plane of the section: the chord between two row joints.
      const a = section.at(rowS[row]);
      const b = section.at(rowS[row + 1]);
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n: P2 = [(b[1] - a[1]) / chord, -(b[0] - a[0]) / chord];

      // Vertical frames at the column joints inside the bay: carried by the two horizontals.
      for (let col = 1; col < cols; col++) {
        addMember(
          { role: "verticalFrame", bay, col, row }, verticalId(bay, col, row), verticalProfile,
          point(colX[col], a, n, verticalOffset), point(colX[col], b, n, verticalOffset), normalAt(colX[col], n),
          [horizontalAt(row, colX[col]), horizontalAt(row + 1, colX[col])],
        );
      }

      for (let col = 0; col < cols; col++) {
        const glass = glassOf(facetOf(colX[col], colX[col + 1], a, b), gap);
        if (!glass.length) continue;
        const { pieces, cutBy } = clipTile(glass, tileCuts, tileOpenings, tol);
        const mid = (colX[col] + colX[col + 1]) / 2;
        pieces.forEach((corners, piece) => details.push({
          role: "tile", bay, col, row,
          supportedBy: [
            col === 0 ? ribAt(bay, rowS[row]) : verticalId(bay, col, row),
            col === cols - 1 ? ribAt(bay + 1, rowS[row]) : verticalId(bay, col + 1, row),
            horizontalAt(row, mid),
            horizontalAt(row + 1, mid),
            ...cutBy,
          ],
          element: {
            id: pieceId(`tile_b${bay}_c${col}_r${row}`, piece), kind: "plate", thickness: tile.thickness, corners,
            color: tile.color ?? GLASS_COLOR, alpha: tile.alpha ?? 0.3, reflection: tile.reflection,
            ...(tile.emissive ? { emissive: tile.emissive } : {}),
            ...(tile.metallic !== undefined ? { metallic: tile.metallic } : {}),
            ...(tile.roughness !== undefined ? { roughness: tile.roughness } : {}),
            ...(tile.bevel ? { bevel: tile.bevel } : {}),
          },
        }));
      }
    }
  }

  // Boundaries remove details: keep only the load path that still exists.
  const ids = new Set(details.map((d) => d.element.id));
  /** A frame running into a tip between boundaries has lost the frame it ended on: the rib there takes it. */
  const ribAtTip = (d: GlassDetail): string[] => {
    const ribbed = boundaries.filter((c) => ids.has(c.id));
    if (d.element.kind !== "straight" || d.role === "mainRib" || !ribbed.length) return [];
    const gap = (c: Boundary, q: Vec3) => Math.abs(side(c, q));
    const closest = (q: Vec3) => ribbed.reduce((best, c) => (gap(c, q) < gap(best, q) ? c : best));
    const { start, end } = d.element;
    return [gap(closest(start), start) < gap(closest(end), end) ? closest(start).id : closest(end).id];
  };
  const result = details.map((d) => {
    const kept = [...new Set(d.supportedBy.map((id) => replacedBy.get(id) ?? id))].filter((id) => ids.has(id));
    const lost = d.role !== "tile" && kept.length < 2;
    return { ...d, supportedBy: lost ? [...new Set([...kept, ...ribAtTip(d)])].filter((id) => ids.has(id)) : kept };
  });
  return {
    name, frame, details: result, radius: section.radius, radiusX: path.radius, model: { elements: result.map((d) => d.element) },
  };
}
