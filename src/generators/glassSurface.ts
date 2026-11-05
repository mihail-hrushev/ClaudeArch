import type { Element } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type Instance, type LocalFrame, frameFromUp } from "../fem/placement";
import { type Vec3, add, sub, scale, dot, cross, len, normalize } from "../fem/vec";

/**
 * Universal structural glass block: a rectangular glazed surface, flat or curved in one
 * direction, made of three kinds of detail with a defined load path:
 *
 *   tile → frames → main ribs
 *
 * - Main ribs: stiff primary members along the section arc, every `ribStep` along local X,
 *   one bay spanning several tile columns. The first and last rib close the surface sides.
 *   Their segments follow the tile rows: one straight segment per tile length.
 * - Horizontal frames: along local X at every tile row joint, spanning rib to rib.
 * - Vertical frames: along the tiles at every column joint inside a bay, spanning
 *   horizontal to horizontal. Tile edges on a rib line sit on the rib itself.
 * - Tiles: flat rectangles of exactly `tile.width` × `tile.length` (less `gap`).
 *
 * Local base frame: X along base → alongX, Y = global Z × X, Z = X × Y (as close to global Z
 * as X allows). The section is the circle through the base and `alongZ` with `tangent` at the
 * base, swept along X. Looking at the surface with X to the right and Z up you see the glass,
 * the structure stands behind it, towards +Y. The reference surface is the glass mid-surface;
 * frames and ribs sit with their front faces on the back of the glass.
 *
 * `cuts` trim the block to any outline and `openings` take convex holes out of it: tiles are
 * clipped, frames and ribs shortened, and a main rib is generated along every cut and around
 * every opening. Blocks cut by a shared plane share that rib.
 *
 * `tile.align` anchors the tile grid to the surface left after all cuts and openings, as one
 * grid across the whole surface: whole tiles start at that edge, or are centred with the rest
 * split equally between both sides, each edge piece at least a quarter tile. A main rib crossing
 * the grid divides the tile it meets.
 * Without `align` every bay fills from its own rib, from the base of the block.
 *
 * `padding` insets the whole surface, structure and glass, from its outline, e.g. to stand clear
 * of the columns beside it. Block edges and cuts move in; openings stay where they are.
 *
 * Any consistent length unit works.
 */
/** Where the tile grid starts on the final surface, seen with X to the right and Z up. */
export type TileAlign =
  | "bottom-left" | "bottom-center" | "bottom-right"
  | "middle-left" | "middle-center" | "middle-right"
  | "top-left" | "top-center" | "top-right";

export interface SurfacePadding {
  readonly left?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly top?: number;
}

export interface GlassSurfaceParams {
  readonly base: Vec3;
  /** End of the local X axis: sets the surface width. */
  readonly alongX: Vec3;
  /**
   * Top of the section: second point of the circle. Only its local (y, z) counts, so the
   * outline stays a rectangle and the tiles stay rectangular.
   */
  readonly alongZ: Vec3;
  /**
   * Surface direction at the base in the local base frame (default [0, 0, 1]). With the base
   * and `alongZ` it fixes the circle of the section, so it sets the radius; pointing at
   * `alongZ` gives a flat surface. Must have no X component (curved in one direction only).
   */
  readonly tangent?: Vec3;
  /** Planes trimming the surface; each generates a main rib along the cut. */
  readonly cuts?: readonly CutPlane[];
  /**
   * Convex holes, each given by its planes with normals pointing into the hole. Main ribs are
   * generated around them. An opening can hold other surfaces, e.g. a window.
   */
  readonly openings?: readonly (readonly CutPlane[])[];
  /**
   * Inset from the outline: one value for all sides, or per side, seen with X to the right and Z
   * up. A cut moves by the padding of the side it faces most.
   */
  readonly padding?: number | SurfacePadding;
  /** Main rib spacing along X; the last bay takes the remainder. */
  readonly ribStep: number;
  /** Explicit main rib positions along X between the two edges (replaces `ribStep`). */
  readonly ribStations?: readonly number[];
  readonly tile: {
    /** Along X. */
    readonly width: number;
    /** Along Z, measured on the flat tile (the chord of the section arc). */
    readonly length: number;
    readonly thickness: number;
    /** Seam between neighbouring tiles, half of it also kept along cuts and openings (default 0: tiles touch). */
    readonly gap?: number;
    /** "cut" keeps the size and shortens the last tile; "equal" shrinks all to fit (default "cut"). */
    readonly fit?: "cut" | "equal";
    /** Anchor of the tile grid on the final surface; with fit "equal" the tiles fill it evenly. */
    readonly align?: TileAlign;
    readonly color?: Vec3;
    readonly alpha?: number;
    /** Share of the sky reflected when looking straight at the glass (see PlateElement). */
    readonly reflection?: number;
  };
  /** Profiles: local y along the surface, local z through its depth (towards the structure). */
  readonly profiles: {
    readonly mainRib: Profile;
    readonly horizontalFrame: Profile;
    /** Default: horizontalFrame. */
    readonly verticalFrame?: Profile;
    /** Main ribs along the cuts (default: mainRib). */
    readonly cutRib?: Profile;
    /** Main ribs around the openings (default: cutRib). */
    readonly openingRib?: Profile;
  };
  readonly ribColor?: Vec3;
  readonly frameColor?: Vec3;
}

/** World-space plane; a cut keeps the side `normal` points to. */
export interface CutPlane {
  readonly point: Vec3;
  readonly normal: Vec3;
}

export type DetailRole = "mainRib" | "horizontalFrame" | "verticalFrame" | "tile";

/**
 * One detail with its place in the grid and in the load path.
 * Grid address per role (all indices from 0):
 *   mainRib          bay = rib line, or cut / opening = index of the boundary it follows
 *   horizontalFrame  bay, row = joint line (0 = bottom edge)
 *   verticalFrame    bay, col = joint line inside the bay (from 1), row
 *   tile             bay, col, row
 */
export interface GlassDetail {
  readonly role: DetailRole;
  readonly element: Element;
  readonly bay?: number;
  readonly cut?: number;
  readonly opening?: number;
  readonly col?: number;
  readonly row?: number;
  /** Ids of the details this one transmits its load to (main ribs: only a boundary rib they end on). */
  readonly supportedBy: readonly string[];
}

/** Placeable block (element ids are local to it) that also knows its details. */
export interface GlassSurface extends Instance {
  readonly details: readonly GlassDetail[];
  /** Radius of the section circle (Infinity when flat). */
  readonly radius: number;
}

const RIB_COLOR: Vec3 = [0.3, 0.32, 0.36];
const FRAME_COLOR: Vec3 = [0.72, 0.74, 0.76];
const GLASS_COLOR: Vec3 = [0.62, 0.85, 0.82];
const EPS = 1e-9;

type P2 = readonly [number, number];

/** Section of the reference surface in the local (y, z) plane, by arc length s. */
interface Section {
  readonly radius: number;
  readonly length: number;
  at(s: number): P2;
  /** Unit tangent. */
  tangent(s: number): P2;
  /** Unit normal towards the structure. */
  normal(s: number): P2;
  /** Arc length under a chord of the given length. */
  arcOfChord(chord: number): number;
}

/** Circular arc from (0, 0) to `top` leaving along `tangent`; a line if along the chord. */
function sectionOf(top: P2, tangent: Vec3): Section {
  const [tx, ty, tz] = tangent;
  if (Math.abs(tx) > 1e-6 * len(tangent)) throw new Error("glassSurface: tangent must have no local X component");
  const chord = Math.hypot(top[0], top[1]);
  if (chord < EPS) throw new Error("glassSurface: alongZ must not lie on the X axis");
  // Headings are measured from +Z towards +Y.
  const chordHeading = Math.atan2(top[0], top[1]);
  const start = Math.atan2(ty, tz);
  const phi = Math.atan2(Math.sin(start - chordHeading), Math.cos(start - chordHeading)); // tangent from the chord
  if (Math.PI - Math.abs(phi) < 1e-6) throw new Error("glassSurface: tangent points away from alongZ");
  if (Math.abs(phi) < EPS) {
    const [dy, dz] = [top[0] / chord, top[1] / chord];
    return {
      radius: Infinity, length: chord, at: (s) => [s * dy, s * dz], tangent: () => [dy, dz], normal: () => [dz, -dy],
      arcOfChord: (c) => c,
    };
  }
  const k = (2 * Math.sin(phi)) / chord; // signed curvature
  const heading = (s: number) => start - k * s;
  return {
    radius: 1 / Math.abs(k),
    length: (2 * phi) / k,
    at: (s) => [(Math.cos(heading(s)) - Math.cos(start)) / k, (Math.sin(start) - Math.sin(heading(s))) / k],
    tangent: (s) => [Math.sin(heading(s)), Math.cos(heading(s))],
    normal: (s) => [Math.cos(heading(s)), -Math.sin(heading(s))],
    arcOfChord: (chord) => (2 * Math.asin(Math.min(1, (chord * Math.abs(k)) / 2))) / Math.abs(k),
  };
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
function gridLines(lo: number, hi: number, step: number, anchor: "start" | "center" | "end", fit: "cut" | "equal"): number[] {
  const total = hi - lo;
  if (fit === "equal") return stations(total, step, "equal").map((q) => lo + q);
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

/** Sorted values, those closer than `tol` merged. */
const distinct = (values: readonly number[], tol: number) =>
  [...values].sort((a, b) => a - b).filter((v, i, all) => i === 0 || v - all[i - 1] > tol);

/** Distance from the reference surface to a member axis, for its front face on the glass back. */
export const axisOffset = (profile: Profile, thickness: number) =>
  thickness / 2 - Math.min(...profile.outline.map(([, z]) => z));

const point = (x: number, [y, z]: P2, [ny, nz]: P2 = [0, 0], offset = 0): Vec3 => [x, y + ny * offset, z + nz * offset];

/** A plane in the block's local frame with a unit normal, and the id of the rib along it. */
interface Boundary extends CutPlane {
  readonly id: string;
}

const localPlane = (c: CutPlane, f: LocalFrame, id: string): Boundary => {
  const local = (v: Vec3): Vec3 => [dot(v, f.x), dot(v, f.y), dot(v, f.z)];
  return { id, point: local(sub(c.point, f.origin)), normal: normalize(local(c.normal)) };
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

/** Flat strips the section is split into when measuring a curved final surface. */
const EXTENT_STRIPS = 64;

/** Range of X and of arc length s covered by the surface left after all boundaries. */
function keptExtent(width: number, section: Section, cuts: readonly Boundary[], voids: readonly (readonly Boundary[])[], tol: number) {
  const strips = section.radius === Infinity ? 1 : EXTENT_STRIPS;
  const extent = { x0: Infinity, x1: -Infinity, s0: Infinity, s1: -Infinity };
  for (let i = 0; i < strips; i++) {
    const [sa, sb] = [(section.length * i) / strips, (section.length * (i + 1)) / strips];
    const a = point(0, section.at(sa));
    const b = point(0, section.at(sb));
    const chord = sub(b, a);
    const polygon = [a, add(a, [width, 0, 0]), add(b, [width, 0, 0]), b];
    for (const q of clipTile(polygon, cuts, voids, tol).pieces.flat()) {
      const s = sa + ((sb - sa) * dot(sub(q, a), chord)) / dot(chord, chord);
      extent.x0 = Math.min(extent.x0, q[0]);
      extent.x1 = Math.max(extent.x1, q[0]);
      extent.s0 = Math.min(extent.s0, s);
      extent.s1 = Math.max(extent.s1, s);
    }
  }
  if (extent.x0 > extent.x1) throw new Error("glassSurface: nothing is left after the cuts");
  return extent;
}

const pieceId = (id: string, piece: number) => (piece === 0 ? id : `${id}_${piece}`);
const ribId = (bay: number) => `rib${bay}`;
const horizontalId = (bay: number, row: number) => `h_b${bay}_r${row}`;
const verticalId = (bay: number, col: number, row: number) => `v_b${bay}_c${col}_r${row}`;

/** The same surface with its padding applied: smaller block, cuts moved in, no padding left. */
function withPadding(p: GlassSurfaceParams): GlassSurfaceParams {
  const pad = typeof p.padding === "number"
    ? { left: p.padding, right: p.padding, bottom: p.padding, top: p.padding }
    : { left: 0, right: 0, bottom: 0, top: 0, ...p.padding };
  const frame = frameFromUp(p.base, p.alongX);
  const width = len(sub(p.alongX, p.base));
  const up = sub(p.alongZ, p.base);
  const section = sectionOf([dot(up, frame.y), dot(up, frame.z)], p.tangent ?? [0, 0, 1]);
  if (pad.left + pad.right >= width || pad.bottom + pad.top >= section.length) {
    throw new Error("glassSurface: padding leaves no surface");
  }
  const world = (x: number, [y, z]: P2): Vec3 =>
    add(add(add(p.base, scale(frame.x, x)), scale(frame.y, y)), scale(frame.z, z));
  const bottom = section.at(pad.bottom);
  const upward = normalize(sub(world(0, section.at(section.length)), p.base));
  const moved = (c: CutPlane): CutPlane => {
    const normal = normalize(c.normal);
    const [sideways, rising] = [dot(normal, frame.x), dot(normal, upward)];
    const inset = Math.abs(sideways) >= Math.abs(rising)
      ? (sideways > 0 ? pad.left : pad.right)
      : (rising > 0 ? pad.bottom : pad.top);
    return { point: add(c.point, scale(normal, inset)), normal };
  };
  const inner = width - pad.left - pad.right;
  const { padding: _padding, ribStations, cuts, ...rest } = p;
  return {
    ...rest,
    base: world(pad.left, bottom),
    alongX: world(width - pad.right, bottom),
    alongZ: world(pad.left, section.at(section.length - pad.top)),
    tangent: [0, ...section.tangent(pad.bottom)],
    ...(cuts ? { cuts: cuts.map(moved) } : {}),
    ...(ribStations ? { ribStations: ribStations.map((x) => x - pad.left).filter((x) => x > 0 && x < inner) } : {}),
  };
}

export function glassSurface(name: string, params: GlassSurfaceParams): GlassSurface {
  const p = params.padding === undefined ? params : withPadding(params);
  const { tile, profiles } = p;
  if (p.ribStep <= 0 || tile.width <= 0 || tile.length <= 0) {
    throw new Error("glassSurface: rib step and tile size must be > 0");
  }
  const frame = frameFromUp(p.base, p.alongX);
  const width = len(sub(p.alongX, p.base));
  const top = sub(p.alongZ, p.base);
  const tangent = p.tangent ?? [0, 0, 1];
  const section = sectionOf([dot(top, frame.y), dot(top, frame.z)], tangent);
  const fit = tile.fit ?? "cut";

  const ribX = p.ribStations ? [0, ...p.ribStations, width] : stations(width, p.ribStep, "cut");
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

  const cuts = (p.cuts ?? []).map((c, i) => localPlane(c, frame, `cut${i}`));
  const openings = (p.openings ?? []).map((o, i) => o.map((c, j) => localPlane(c, frame, `open${i}_${j}`)));
  const boundaries = [...cuts, ...openings.flat()];
  // Tiles stop half a seam short of every boundary.
  const moved = (c: Boundary, distance: number): Boundary => ({ ...c, point: add(c.point, scale(c.normal, distance)) });
  const tileCuts = cuts.map((c) => moved(c, gap));
  const tileOpenings = openings.map((o) => o.map((c) => moved(c, -gap)));
  const tol = 1e-6 * width;

  // Tile grid: anchored to the final surface, or filled from the base bay by bay.
  const rowStep = section.arcOfChord(tile.length);
  const extent = tile.align ? keptExtent(width, section, cuts, openings, tol) : null;
  const [alignZ, alignX] = (tile.align ?? "bottom-left").split("-");
  const rowS = extent
    ? distinct([0, ...gridLines(extent.s0, extent.s1, rowStep, alignZ === "bottom" ? "start" : alignZ === "top" ? "end" : "center", fit), section.length], tol)
    : stations(section.length, rowStep, fit);
  const rows = rowS.length - 1;
  const columnLines = extent
    ? gridLines(extent.x0, extent.x1, tile.width, alignX === "left" ? "start" : alignX === "right" ? "end" : "center", fit)
    : null;

  /** Inside the cuts and outside the openings; margin > 0 also rejects points on a boundary. */
  const kept = (q: Vec3, margin: number) =>
    cuts.every((c) => side(c, q) >= margin) && openings.every((o) => o.some((c) => side(c, q) < -margin));
  /** The boundary a trimmed rib end stopped on. */
  const boundaryAt = (q: Vec3) => boundaries.reduce((best, c) => (Math.abs(side(c, q)) < Math.abs(side(best, q)) ? c : best)).id;

  /** Frames that fell on a boundary: its rib stands in for them in the load path. */
  const replacedBy = new Map<string, string>();

  /** Straight member trimmed by the boundaries; a trimmed end is carried by the rib there instead. */
  const addMember = (
    d: Pick<GlassDetail, "role" | "bay" | "col" | "row">, id: string, profile: Profile, a: Vec3, b: Vec3, up: Vec3,
    supports: readonly [string, string],
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
    const pieces = trimSegment(a, b, cuts, openings, tol).map((s, i) => {
      const start = add(a, scale(sub(b, a), s.t0));
      const end = add(a, scale(sub(b, a), s.t1));
      details.push({
        ...d,
        supportedBy: [s.from ?? supports[0], s.to ?? supports[1]],
        element: { id: pieceId(id, i), kind: "straight", profile, color: frameColor, start, end, up },
      });
      return { id: pieceId(id, i), start, end };
    });
    return pieces;
  };

  // Main ribs: concentric with the section, so the arc keeps its tangent and its nodes at the
  // row joints give segments parallel to the tiles. Boundaries shorten, split or remove them.
  const ribPieces = ribX.map((x, i) => {
    const axis = (s: number) => point(x, section.at(s), section.normal(s), ribOffset);
    return keptRanges(section.length, (s) => kept(axis(s), tol)).map(([s0, s1], piece) => {
      const id = pieceId(ribId(i), piece);
      const common = {
        id, start: axis(s0), end: axis(s1), profile: profiles.mainRib,
        up: point(0, section.normal(s0)), color: ribColor,
      };
      const inner = rowS.filter((s) => s > s0 + tol && s < s1 - tol);
      const element: Element = section.radius === Infinity
        ? { ...common, kind: "straight" }
        : {
            ...common, kind: "arc", startTangent: point(0, section.tangent(s0)), segmentLength: tile.length,
            divisions: [s0, ...inner, s1].map((s) => (s - s0) / (s1 - s0)),
          };
      const supportedBy = [...(s0 > 0 ? [boundaryAt(axis(s0))] : []), ...(s1 < section.length ? [boundaryAt(axis(s1))] : [])];
      details.push({ role: "mainRib", element, bay: i, supportedBy });
      return { id, s0, s1 };
    });
  });
  const ribAt = (i: number, s: number) =>
    ribPieces[i].find((r) => s >= r.s0 - tol && s <= r.s1 + tol)?.id ?? ribId(i);

  /** Rib along a boundary: its line through every flat tile row, chained across the rows. */
  const addBoundaryRib = (
    c: Boundary, planes: readonly Boundary[], voids: readonly (readonly Boundary[])[], profile: Profile,
    address: Pick<GlassDetail, "cut" | "opening">,
  ) => {
    const offset = axisOffset(profile, tile.thickness);
    const chains: { end: Vec3; nodes: Vec3[]; up: Vec3 }[] = [];
    for (let row = 0; row < rows; row++) {
      const lo = section.at(rowS[row]);
      const hi = section.at(rowS[row + 1]);
      const onStrip = (x: number, t: number) => point(x, [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t]);
      const outline: [number, number][] = [[0, 0], [width, 0], [width, 1], [0, 1]];
      const hits = outline.flatMap(([x, t], i): [number, number][] => {
        const [x2, t2] = outline[(i + 1) % 4];
        const d = side(c, onStrip(x, t));
        const d2 = side(c, onStrip(x2, t2));
        // A plane along the edge of the block counts as crossing it: the rib goes on that edge.
        if (d < tol === d2 < tol) return [];
        const u = Math.min(1, Math.max(0, d / (d - d2)));
        return [[x + (x2 - x) * u, t + (t2 - t) * u]];
      });
      if (hits.length !== 2) continue;
      // Always upwards along the surface, then along X: neighbours then produce the same rib.
      const flip = Math.abs(hits[0][1] - hits[1][1]) > EPS ? hits[0][1] > hits[1][1] : hits[0][0] > hits[1][0];
      const [[xa, ta], [xb, tb]] = flip ? [hits[1], hits[0]] : hits;
      const a = onStrip(xa, ta);
      const b = onStrip(xb, tb);
      /** Offset within the boundary plane, so that neighbouring blocks share the rib. */
      const node = (u: number) => {
        const t = ta + (tb - ta) * u;
        const [ly, lz] = section.normal(rowS[row]);
        const [hy, hz] = section.normal(rowS[row + 1]);
        const n = normalize([0, ly + (hy - ly) * t, lz + (hz - lz) * t]);
        const depth = normalize(sub(n, scale(c.normal, dot(n, c.normal))));
        return { at: add(a, scale(sub(b, a), u)), depth };
      };
      for (const s of trimSegment(a, b, planes, voids, tol)) {
        const start = node(s.t0);
        const end = node(s.t1);
        const last = chains[chains.length - 1];
        const shifted = (q: typeof start) => add(q.at, scale(q.depth, offset));
        if (last && len(sub(last.end, start.at)) <= tol) {
          last.nodes.push(shifted(end));
          last.end = end.at;
        } else {
          chains.push({ end: end.at, nodes: [shifted(start), shifted(end)], up: start.depth });
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
  cuts.forEach((c, i) => addBoundaryRib(c, cuts.filter((o) => o !== c), openings, cutProfile, { cut: i }));
  openings.forEach((o, i) => o.forEach((c) => {
    const others = openings.filter((other) => other !== o);
    addBoundaryRib(c, [...cuts, ...o.filter((q) => q !== c)], others, openingProfile, { opening: i });
  }));

  for (let bay = 0; bay < ribX.length - 1; bay++) {
    const x0 = ribX[bay];
    const x1 = ribX[bay + 1];
    const colX = columnLines
      ? [x0, ...distinct(columnLines, tol).filter((x) => x > x0 + tol && x < x1 - tol), x1]
      : stations(x1 - x0, tile.width, fit).map((x) => x0 + x);
    const cols = colX.length - 1;

    // Horizontal frames at every row joint: rib to rib, carried by the two ribs.
    const horizontals = rowS.map((s, row) => {
      const q = section.at(s);
      const n = section.normal(s);
      return addMember(
        { role: "horizontalFrame", bay, row }, horizontalId(bay, row), profiles.horizontalFrame,
        point(x0, q, n, horizontalOffset), point(x1, q, n, horizontalOffset), point(0, n),
        [ribAt(bay, s), ribAt(bay + 1, s)],
      );
    });
    /** The piece of a horizontal frame over x. */
    const horizontalAt = (row: number, x: number) =>
      horizontals[row].find((h) => x >= h.start[0] - tol && x <= h.end[0] + tol)?.id ?? horizontalId(bay, row);

    for (let row = 0; row < rows; row++) {
      // Rows beyond the final surface hold nothing, though on a curve their frames dip back into it.
      const margin = 1e-3 * tile.length;
      if (extent && (rowS[row + 1] <= extent.s0 + margin || rowS[row] >= extent.s1 - margin)) continue;

      // The tile plane: the chord between two row joints.
      const a = section.at(rowS[row]);
      const b = section.at(rowS[row + 1]);
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const along: P2 = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord];
      const n: P2 = [along[1], -along[0]];

      // Vertical frames at the column joints inside the bay: carried by the two horizontals.
      for (let col = 1; col < cols; col++) {
        addMember(
          { role: "verticalFrame", bay, col, row }, verticalId(bay, col, row), verticalProfile,
          point(colX[col], a, n, verticalOffset), point(colX[col], b, n, verticalOffset), point(0, n),
          [horizontalAt(row, colX[col]), horizontalAt(row + 1, colX[col])],
        );
      }

      const lo = point(0, a, along, gap);
      const hi = point(0, b, along, -gap);
      if (chord <= 2 * gap) continue; // a leftover narrower than the seam holds no glass
      for (let col = 0; col < cols; col++) {
        const xa = colX[col] + gap;
        const xb = colX[col + 1] - gap;
        if (xb <= xa) continue;
        const { pieces, cutBy } = clipTile(
          [[xa, lo[1], lo[2]], [xb, lo[1], lo[2]], [xb, hi[1], hi[2]], [xa, hi[1], hi[2]]], tileCuts, tileOpenings, tol,
        );
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
  return { name, frame, details: result, radius: section.radius, model: { elements: result.map((d) => d.element) } };
}
