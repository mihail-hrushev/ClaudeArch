import type { Element } from "../fem/types";
import { type Vec3, add, sub, scale, dot, cross, len, normalize } from "../fem/vec";
import { type CutPlane, type GlassDetail, type SurfacePadding, axisOffset } from "./glassSurface";
import { type GlassSurface2, type GlassSurface2Params, baseFrame, curvesOf } from "./glassSurface2";

/**
 * Glass surface curved in two directions and tiled with hexagons instead of rectangles.
 *
 *   hexagonal tile → ribs
 *
 * Placed exactly as `glassSurface2`: three points (`base`, `alongX`, `alongZ`), the section
 * tangent `tangent` bending it from the base up to `alongZ` and the base line tangent `tangentX`
 * bending it from the base to `alongX`; `sweep` slides the section along the base line or
 * revolves it about the base line's axis.
 *
 * The surface is unrolled into stations along the base line (u, 0 … its length) and along the
 * section (v, 0 … its length), and a honeycomb of hexagons `cell` wide across the flats is laid
 * over that rectangle, a cell centred on its middle. Cells running past the edges are cut off
 * there.
 *
 * - Ribs: one straight member along every edge two cells share: neighbouring tiles sit on the
 *   same rib. Three meet at every node of the honeycomb.
 * - Boundary ribs: one polyline along each edge of the surface and each cut (the cut rib
 *   profile, or the cut's own), and around each opening (the opening rib profile).
 * - Tiles: one flat plate per cell (or cut-off part of a cell), less half the seam along every
 *   edge.
 *
 * `cuts` trim the surface (keeping the side each normal points to) and `openings` take convex
 * holes out of it (planes with normals into the hole), as in `glassSurface`. A cell an opening
 * bites into is split into convex pieces, each its own tile. `padding` insets the surface from
 * its outline: its edges and cuts move in, openings stay.
 *
 * Six corners on a doubly curved surface are not in one plane. The nodes are therefore moved
 * along the surface normal, all together, until every cell is as nearly flat as the shared
 * nodes allow; each tile is then made exactly flat in its own plane. Nodes on a cut or an
 * opening move within its plane, so they stay on it. Where the surface repeats itself (revolved
 * about its axis, or along a straight base line or section) the nodes it carries onto each other
 * move together, so the whole cells it carries onto each other are identical tiles: one type per
 * height on a revolved surface. `planarity` reports how far the nodes still lie from the planes
 * of their tiles: the most a tile edge stands off its rib.
 *
 * `offset` moves the glass of a tile along its own normal: forward (away from the structure)
 * when positive, back when negative. The ribs stay where they are.
 */
export interface HoneycombSurfaceParams extends Pick<
  GlassSurface2Params,
  "base" | "alongX" | "alongZ" | "tangent" | "tangentX" | "sweep" | "through" | "facing" | "tile" | "profiles" | "ribColor"
  | "cuts" | "openings" | "padding"
> {
  /** Width of one hexagon across its flats (default `tile.width`). */
  readonly cell?: number;
  /**
   * "pointy" (default): corners up and down the section, cells in rows along the base line;
   * "flat": corners along the base line, cells in columns up the section.
   */
  readonly orientation?: "pointy" | "flat";
  /** Glass moved along its own normal, forward (away from the structure) when positive (default 0). */
  readonly offset?: number;
  /** Offsets of single cells, by [col, row] (from 0 at the bottom left), replacing `offset` there. */
  readonly offsets?: readonly { readonly cells: readonly (readonly [number, number])[]; readonly offset: number }[];
}

export interface HoneycombSurface extends GlassSurface2 {
  /** Largest distance of a node from the plane of a tile it belongs to, after flattening. */
  readonly planarity: number;
  /** Number of cells (whole or cut off at the edges, each piece of a cell split by an opening counted). */
  readonly cells: number;
}

const RIB_COLOR: Vec3 = [0.3, 0.32, 0.36];
const GLASS_COLOR: Vec3 = [0.62, 0.85, 0.82];
const SQRT3 = Math.sqrt(3);
/** Rounds of node moves that flatten the cells. */
const FLATTEN_ROUNDS = 300;
/**
 * How strongly each node is held on the surface while the cells are flattened, against the pull
 * of one cell. Without it a smooth bend of the whole surface (a vertical wall leaning into a
 * barrel) costs the cells next to nothing and the nodes drift into it.
 */
const HOLD = 0.5;

type P2 = readonly [number, number];
type Side = "bottom" | "right" | "top" | "left";
const SIDES: readonly Side[] = ["bottom", "right", "top", "left"];

/** The rectangle of the unrolled surface the honeycomb covers. */
interface Domain { readonly u0: number; readonly u1: number; readonly v0: number; readonly v1: number }

/** Convex polygon (counter-clockwise in u, v) kept inside the domain. */
function clipToRect(polygon: readonly P2[], { u0, u1, v0, v1 }: Domain): P2[] {
  // Each edge of the rectangle: distance inside it, and the point on it (snapped exactly onto its line).
  const edges: [(q: P2) => number, (a: P2, b: P2, t: number) => P2][] = [
    [(q) => q[1] - v0, (a, b, t) => [a[0] + (b[0] - a[0]) * t, v0]],
    [(q) => u1 - q[0], (a, b, t) => [u1, a[1] + (b[1] - a[1]) * t]],
    [(q) => v1 - q[1], (a, b, t) => [a[0] + (b[0] - a[0]) * t, v1]],
    [(q) => q[0] - u0, (a, b, t) => [u0, a[1] + (b[1] - a[1]) * t]],
  ];
  let out: P2[] = [...polygon];
  for (const [inside, on] of edges) {
    if (!out.length) break;
    const next: P2[] = [];
    out.forEach((a, i) => {
      const b = out[(i + 1) % out.length];
      const [da, db] = [inside(a), inside(b)];
      if (da >= 0) next.push(a);
      if ((da < 0) !== (db < 0)) next.push(on(a, b, da / (da - db)));
    });
    out = next;
  }
  return out;
}

const area2 = (q: readonly P2[]) => q.reduce((sum, a, i) => {
  const b = q[(i + 1) % q.length];
  return sum + (a[0] * b[1] - b[0] * a[1]) / 2;
}, 0);

/** Normal of a polygon by Newell's method: counter-clockwise around it. */
function newell(points: readonly Vec3[]): Vec3 {
  let n: Vec3 = [0, 0, 0];
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  });
  return normalize(n);
}

const centroid = (points: readonly Vec3[]) => scale(points.reduce((s, q) => add(s, q), [0, 0, 0] as Vec3), 1 / points.length);

/**
 * A flat convex polygon (counter-clockwise around `n`) with every edge moved in by `gap`;
 * empty if it closes up.
 */
function inset(points: readonly Vec3[], n: Vec3, gap: number): Vec3[] {
  // Corners on a straight run (e.g. where a cut or an opening ends on a cell edge) are no corners.
  const corners = points.filter((q, i) => {
    const [p, r] = [points[(i + points.length - 1) % points.length], points[(i + 1) % points.length]];
    return len(cross(sub(q, p), sub(r, q))) > 1e-9 * len(sub(q, p)) * len(sub(r, q));
  });
  if (corners.length < 3) return [];
  if (gap <= 0) return corners;
  const e1 = normalize(sub(corners[1], corners[0]));
  const e2 = cross(n, e1);
  const flat = corners.map((q): P2 => [dot(sub(q, corners[0]), e1), dot(sub(q, corners[0]), e2)]);
  const lines = flat.map((a, i) => {
    const b = flat[(i + 1) % flat.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: P2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    return { at: [a[0] - d[1] * gap, a[1] + d[0] * gap] as P2, d };
  });
  const moved = lines.map((l1, i) => {
    const l0 = lines[(i + lines.length - 1) % lines.length];
    const det = l0.d[0] * l1.d[1] - l0.d[1] * l1.d[0];
    const [rx, ry] = [l1.at[0] - l0.at[0], l1.at[1] - l0.at[1]];
    const t = (rx * l1.d[1] - ry * l1.d[0]) / det;
    return [l0.at[0] + l0.d[0] * t, l0.at[1] + l0.d[1] * t] as P2;
  });
  // Moved in past a short edge the polygon turns inside out: no glass is left.
  const a = area2(moved);
  if (!(a > 0) || moved.some((q, i) => {
    const [p, r] = [moved[(i + moved.length - 1) % moved.length], moved[(i + 1) % moved.length]];
    return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) < -1e-9 * a;
  })) return [];
  return moved.map(([x, y]) => add(corners[0], add(scale(e1, x), scale(e2, y))));
}

/** Drops the nodes of straight runs. */
const mergeCollinear = (nodes: readonly Vec3[]) => nodes.filter((q, i) =>
  i === 0 || i === nodes.length - 1 || len(cross(normalize(sub(q, nodes[i - 1])), normalize(sub(nodes[i + 1], q)))) > 1e-9);

/** A plane trimming the surface, in the block's frame, with the id of the rib along it. */
interface Boundary {
  readonly id: string;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly profile?: CutPlane["profile"];
  readonly cut?: number;
  readonly opening?: number;
}

export function honeycombSurface(name: string, p: HoneycombSurfaceParams): HoneycombSurface {
  const { tile, profiles } = p;
  const cell = p.cell ?? tile.width;
  if (!(cell > 0) || !(tile.thickness > 0)) throw new Error("honeycombSurface: cell and tile thickness must be > 0");
  const frame = baseFrame(p);
  const { section, path } = curvesOf(p, frame);
  const [width, height] = [path.length, section.length];
  const revolve = p.sweep === "revolve" && path.radius !== Infinity;

  /** The point of the surface at station u of the base line and v of the section. */
  const surface = (u: number, v: number): Vec3 => {
    const [oy, ox] = path.at(u);
    const [y, z] = section.at(v);
    if (!revolve) return [ox, oy + y, z];
    const [ey, ex] = path.normal(u);
    return [ox + ex * y, oy + ey * y, z];
  };
  const step = 1e-3 * cell;
  /** Unit normal of the surface towards the structure. */
  const normal = (u: number, v: number): Vec3 => {
    const along = sub(surface(u + step, v), surface(u - step, v));
    const up = sub(surface(u, v + step), surface(u, v - step));
    const n = cross(up, along);
    if (len(n) < 1e-9 * step * step) throw new Error("honeycombSurface: the surface folds or closes to a point (a revolved section on its axis?)");
    return normalize(n);
  };

  // Padding: the edges move in along the unrolled surface, a cut by the padding of the side it faces most.
  const pad: Required<SurfacePadding> = typeof p.padding === "number"
    ? { left: p.padding, right: p.padding, bottom: p.padding, top: p.padding }
    : { left: 0, right: 0, bottom: 0, top: 0, ...p.padding };
  const domain: Domain = { u0: pad.left, u1: width - pad.right, v0: pad.bottom, v1: height - pad.top };
  if (domain.u1 <= domain.u0 || domain.v1 <= domain.v0) throw new Error("honeycombSurface: padding leaves no surface");
  const [topY, topZ] = section.at(height);
  const upward = normalize(add(scale(frame.y, topY), scale(frame.z, topZ)));
  const paddedCut = (c: CutPlane): CutPlane => {
    const n = normalize(c.normal);
    const [sideways, rising] = [dot(n, frame.x), dot(n, upward)];
    const by = Math.abs(sideways) >= Math.abs(rising) ? (sideways > 0 ? pad.left : pad.right) : (rising > 0 ? pad.bottom : pad.top);
    return { ...c, point: add(c.point, scale(n, by)), normal: n };
  };

  // Cuts and openings, in the block's frame.
  const local = (v: Vec3): Vec3 => [dot(v, frame.x), dot(v, frame.y), dot(v, frame.z)];
  const toLocal = (c: CutPlane, id: string, address: Pick<Boundary, "cut" | "opening">): Boundary =>
    ({ id, point: local(sub(c.point, frame.origin)), normal: normalize(local(c.normal)), profile: c.profile, ...address });
  const cuts = (p.cuts ?? []).map((c, i) => toLocal(paddedCut(c), `cut${i}`, { cut: i }));
  const openings = (p.openings ?? []).map((o, i) => o.map((c, j) => toLocal(c, `open${i}_${j}`, { opening: i })));
  const planes = [...cuts, ...openings.flat()];

  const sideOf = (c: Boundary, [u, v]: P2) => dot(sub(surface(u, v), c.point), c.normal);
  /** Where the surface crosses the plane between two points of the unrolled rectangle (the same whichever way round). */
  const crossing = (c: Boundary, a: P2, b: P2): P2 => {
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
    const inside = sideOf(c, a) >= 0;
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if ((sideOf(c, [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid]) >= 0) === inside) lo = mid;
      else hi = mid;
    }
    const t = (lo + hi) / 2;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  /** The part of a cell on one side of a plane (`sign` 1: where its normal points); its edge along the plane is straight between the two crossings. */
  const clipBy = (polygon: readonly P2[], c: Boundary, sign: 1 | -1): P2[] => {
    const out: P2[] = [];
    polygon.forEach((a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      const [da, db] = [sign * sideOf(c, a), sign * sideOf(c, b)];
      if (da >= 0) out.push(a);
      if ((da < 0) !== (db < 0)) out.push(crossing(c, a, b));
    });
    return out;
  };

  // The honeycomb over the domain, a cell centred on its middle.
  const radius = cell / SQRT3;
  const flatTop = p.orientation === "flat";
  const [du, dv] = flatTop ? [1.5 * radius, cell] : [cell, 1.5 * radius];
  const corners = Array.from({ length: 6 }, (_, k) => {
    const a = ((flatTop ? 0 : 30) + 60 * k) * (Math.PI / 180);
    return [radius * Math.cos(a), radius * Math.sin(a)] as P2;
  });
  const odd = (k: number) => ((k % 2) + 2) % 2;
  const [midU, midV] = [(domain.u0 + domain.u1) / 2, (domain.v0 + domain.v1) / 2];
  const reachU = Math.ceil((domain.u1 - domain.u0) / 2 / du) + 2;
  const reachV = Math.ceil((domain.v1 - domain.v0) / 2 / dv) + 2;
  const minArea = 1e-4 * (SQRT3 / 2) * cell * cell;
  const tol = 1e-6 * cell;

  interface Cell { col: number; row: number; piece: number; nodes: number[] }
  const nodeUV: P2[] = [];
  const nodeKeys = new Map<string, number>();
  const q = 1e-6 * cell;
  const nodeOf = ([u, v]: P2) => {
    const key = `${Math.round(u / q)},${Math.round(v / q)}`;
    let id = nodeKeys.get(key);
    if (id === undefined) {
      id = nodeUV.length;
      nodeKeys.set(key, id);
      nodeUV.push([u, v]);
    }
    return id;
  };
  /**
   * A corner all but on an edge of the surface is put on it: a cell size that nearly fits (e.g.
   * a rounded share of a circle) would otherwise leave a sliver of an edge next to the clip.
   */
  const snap = 1e-3 * cell;
  const snapped = (x: number, lo: number, hi: number) => (Math.abs(x - lo) < snap ? lo : Math.abs(x - hi) < snap ? hi : x);
  /** A convex polygon less an opening: the convex pieces outside it (itself if it misses the opening). */
  const withoutOpening = (polygon: P2[], planesOfOpening: readonly Boundary[]): P2[][] => {
    const out: P2[][] = [];
    let rest = polygon;
    for (const c of planesOfOpening) {
      const outside = clipBy(rest, c, -1);
      rest = clipBy(rest, c, 1);
      if (rest.length < 3 || area2(rest) < minArea) return [polygon];
      if (outside.length >= 3 && area2(outside) >= minArea) out.push(outside);
    }
    return out;
  };
  const raw: Cell[] = [];
  for (let i = -reachU; i <= reachU; i++) {
    for (let j = -reachV; j <= reachV; j++) {
      const centre: P2 = flatTop
        ? [midU + i * du, midV + (j + odd(i) / 2) * dv]
        : [midU + (i + odd(j) / 2) * du, midV + j * dv];
      const hexagon = corners.map(([x, y]) => [snapped(centre[0] + x, domain.u0, domain.u1), snapped(centre[1] + y, domain.v0, domain.v1)] as P2);
      let piece = clipToRect(hexagon, domain);
      for (const c of cuts) if (piece.length >= 3) piece = clipBy(piece, c, 1);
      if (piece.length < 3 || area2(piece) < minArea) continue;
      let pieces = [piece];
      for (const o of openings) pieces = pieces.flatMap((q) => withoutOpening(q, o));
      pieces.forEach((polygon, k) => {
        const nodes = polygon.map(nodeOf).filter((n, m, all) => n !== all[(m + 1) % all.length]);
        if (nodes.length >= 3) raw.push({ col: i, row: j, piece: k, nodes });
      });
    }
  }
  if (!raw.length) throw new Error("honeycombSurface: no cell fits on the surface (or nothing is left after the cuts and openings)");
  const [col0, row0] = [Math.min(...raw.map((c) => c.col)), Math.min(...raw.map((c) => c.row))];
  const cells = raw.map((c) => ({ ...c, col: c.col - col0, row: c.row - row0 }));

  // Edges on the boundary belong to one cell only; an edge two cells share is a rib between them.
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const edgeUses = new Map<string, number>();
  for (const c of cells) c.nodes.forEach((a, k) => {
    const key = edgeKey(a, c.nodes[(k + 1) % c.nodes.length]);
    edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
  });
  const onBoundary = new Set<number>();
  for (const c of cells) c.nodes.forEach((a, k) => {
    const b = c.nodes[(k + 1) % c.nodes.length];
    if (edgeUses.get(edgeKey(a, b)) === 1) onBoundary.add(a).add(b);
  });

  // Nodes on the surface, then moved along its normal until the cells are as flat as they can be.
  const base = nodeUV.map(([u, v]) => surface(u, v));
  const normals = nodeUV.map(([u, v]) => normal(u, v));
  /** The planes a boundary node lies on: it stays on them. */
  const planesAt = nodeUV.map((uv, id) => (onBoundary.has(id) ? planes.filter((c) => Math.abs(sideOf(c, uv)) <= tol) : []));
  /** The surface normal, turned into the plane for a node on a cut or an opening so that it stays on it. */
  const liftDirection = nodeUV.map((_, id) => {
    const n = normals[id];
    if (!planesAt[id].length) return n;
    const c = planesAt[id][0].normal;
    const d = sub(n, scale(c, dot(n, c)));
    return scale(d, 1 / dot(d, n)); // as far along the normal as the normal itself
  });
  const lift = new Float64Array(nodeUV.length);
  const at = (n: number) => add(base[n], scale(liftDirection[n], lift[n]));
  /** Each cell's plane: through the middle of its nodes, square to their Newell normal (towards the glass side). */
  const planeOf = (c: Cell) => {
    const points = c.nodes.map(at);
    return { centre: centroid(points), n: newell(points), points };
  };
  // Where moving along the surface is a rigid motion (around the axis when revolved, along a
  // straight base line or section), nodes it carries onto each other move together: cells it
  // carries onto each other then stay the same shape, so whole cells repeat.
  const alongU = revolve || path.radius === Infinity;
  const alongV = section.radius === Infinity && !revolve;
  const groupKeys = new Map<string, number>();
  const groupOf = nodeUV.map(([u, v], id) => {
    // A cut or an opening breaks the repeat: its nodes move on their own, within its plane.
    const key = planesAt[id].length ? `node${id}` : `${alongU ? "" : Math.round(u / q)},${alongV ? "" : Math.round(v / q)}`;
    if (!groupKeys.has(key)) groupKeys.set(key, groupKeys.size);
    return groupKeys.get(key)!;
  });
  const sum = new Float64Array(groupKeys.size);
  const count = new Float64Array(groupKeys.size);
  const groupLift = new Float64Array(groupKeys.size);
  const groupSize = new Float64Array(groupKeys.size);
  for (const g of groupOf) groupSize[g] += 1;
  for (let round = 0; round < FLATTEN_ROUNDS; round++) {
    sum.fill(0);
    count.fill(0);
    for (const c of cells) {
      if (c.nodes.length < 4) continue; // three nodes are always in a plane
      const { centre, n, points } = planeOf(c);
      c.nodes.forEach((id, k) => {
        sum[groupOf[id]] -= dot(sub(points[k], centre), n) / dot(liftDirection[id], n);
        count[groupOf[id]] += 1;
      });
    }
    // Each node also pulls its group back towards the surface (lift 0).
    groupLift.fill(0);
    for (let id = 0; id < lift.length; id++) groupLift[groupOf[id]] = lift[id];
    for (let g = 0; g < sum.length; g++) {
      const held = HOLD * groupSize[g];
      if (count[g] + held > 0) groupLift[g] += (sum[g] - held * groupLift[g]) / (count[g] + held);
    }
    for (let id = 0; id < lift.length; id++) lift[id] = groupLift[groupOf[id]];
  }
  const node = nodeUV.map((_, id) => at(id));

  const details: GlassDetail[] = [];
  const ribColor = p.ribColor ?? RIB_COLOR;
  const ribOffset = axisOffset(profiles.mainRib, tile.thickness);
  const edgeProfile = profiles.cutRib ?? profiles.mainRib;
  const openingProfile = profiles.openingRib ?? edgeProfile;
  /** The edges of the surface a node lies on, as boundary lines (`edge_bottom` …). */
  const sidesOf = ([u, v]: P2) => SIDES.filter((s) =>
    Math.abs(s === "bottom" ? v - domain.v0 : s === "right" ? domain.u1 - u : s === "top" ? domain.v1 - v : u - domain.u0) <= tol);
  /** The boundary lines a node lies on: the edges of the surface, the cuts and the planes of the openings. */
  const linesOf = nodeUV.map((uv, id) => [...sidesOf(uv).map((s) => `edge_${s}`), ...planesAt[id].map((c) => c.id)]);
  const planeById = new Map(planes.map((c) => [c.id, c]));

  // Boundary ribs: the boundary edges along each line chained into polylines, one per unbroken run.
  const lineEdges = new Map<string, [number, number][]>();
  for (const c of cells) {
    c.nodes.forEach((a, k) => {
      const b = c.nodes[(k + 1) % c.nodes.length];
      if (edgeUses.get(edgeKey(a, b)) !== 1) return;
      const line = linesOf[a].find((l) => linesOf[b].includes(l));
      if (line) (lineEdges.get(line) ?? lineEdges.set(line, []).get(line)!).push([a, b]);
    });
  }
  /** The boundary rib under each cell edge along a line. */
  const boundaryRib = new Map<string, string>();
  /** The boundary ribs through each node: a rib ending there rests on them. */
  const boundaryRibsAt = new Map<number, string[]>();
  for (const [line, edges] of lineEdges) {
    const plane = planeById.get(line);
    const profile = plane?.profile ?? (plane?.opening !== undefined ? openingProfile : edgeProfile);
    const offset = axisOffset(profile, tile.thickness);
    /** Along a plane the rib stands back within it, so blocks cut by the same plane share it. */
    const depth = (id: number) => (plane ? normalize(sub(normals[id], scale(plane.normal, dot(normals[id], plane.normal)))) : normals[id]);
    const next = new Map<number, number[]>();
    for (const [a, b] of edges) {
      (next.get(a) ?? next.set(a, []).get(a)!).push(b);
      (next.get(b) ?? next.set(b, []).get(b)!).push(a);
    }
    const used = new Set<string>();
    const starts = [...next.keys()].sort((a, b) => next.get(a)!.length - next.get(b)!.length); // open ends first
    let piece = 0;
    for (const first of starts) {
      if (next.get(first)!.every((b) => used.has(edgeKey(first, b)))) continue;
      const id = piece === 0 ? line : `${line}_${piece}`;
      piece += 1;
      const chain = [first];
      for (let at = first; ;) {
        const to = next.get(at)!.find((b) => !used.has(edgeKey(at, b)));
        if (to === undefined) break;
        used.add(edgeKey(at, to));
        boundaryRib.set(edgeKey(at, to), id);
        for (const n of [at, to]) (boundaryRibsAt.get(n) ?? boundaryRibsAt.set(n, []).get(n)!).push(id);
        chain.push(to);
        at = to;
      }
      const nodes = mergeCollinear(chain.map((n) => add(node[n], scale(depth(n), offset))));
      details.push({
        role: "mainRib", supportedBy: [],
        ...(plane?.cut !== undefined ? { cut: plane.cut } : {}), ...(plane?.opening !== undefined ? { opening: plane.opening } : {}),
        element: { id, kind: "polyline", nodes, start: nodes[0], end: nodes[nodes.length - 1], profile, up: depth(chain[0]), color: ribColor },
      });
    }
  }

  // Ribs: one per edge two cells share.
  const ribs = new Map<string, string>();
  /** The rib under the edge a → b of a cell: a shared rib, or the boundary rib of the line it runs along. */
  const ribUnder = (a: number, b: number): string | undefined => {
    const key = edgeKey(a, b);
    if (edgeUses.get(key) === 1) return boundaryRib.get(key);
    let id = ribs.get(key);
    if (id === undefined) {
      id = `rib${ribs.size}`;
      ribs.set(key, id);
      const [na, nb] = [normals[a], normals[b]];
      const [start, end] = [add(node[a], scale(na, ribOffset)), add(node[b], scale(nb, ribOffset))];
      const d = normalize(sub(end, start));
      const mean = add(na, nb);
      details.push({
        role: "mainRib",
        supportedBy: [...new Set([a, b].flatMap((n) => boundaryRibsAt.get(n) ?? []))],
        element: { id, kind: "straight", profile: profiles.mainRib, start, end, up: normalize(sub(mean, scale(d, dot(mean, d)))), color: ribColor },
      });
    }
    return id;
  };

  const offsets = new Map<string, number>();
  for (const o of p.offsets ?? []) for (const [c, r] of o.cells) offsets.set(`${c},${r}`, o.offset);
  const gap = (tile.gap ?? 0) / 2;
  let planarity = 0;
  for (const c of cells) {
    const supportedBy = c.nodes.flatMap((a, k) => ribUnder(a, c.nodes[(k + 1) % c.nodes.length]) ?? []);
    const { centre, n, points } = planeOf(c);
    planarity = Math.max(planarity, ...points.map((q) => Math.abs(dot(sub(q, centre), n))));
    const flat = points.map((q) => sub(q, scale(n, dot(sub(q, centre), n))));
    const glass = inset(flat, n, gap);
    if (glass.length < 3) continue;
    const shift = scale(n, offsets.get(`${c.col},${c.row}`) ?? p.offset ?? 0);
    const element: Element = {
      id: `hex_c${c.col}_r${c.row}${c.piece ? `_${c.piece}` : ""}`, kind: "plate", thickness: tile.thickness, corners: glass.map((q) => add(q, shift)),
      color: tile.color ?? GLASS_COLOR, alpha: tile.alpha ?? 0.3, reflection: tile.reflection,
      ...(tile.emissive ? { emissive: tile.emissive } : {}),
      ...(tile.metallic !== undefined ? { metallic: tile.metallic } : {}),
      ...(tile.roughness !== undefined ? { roughness: tile.roughness } : {}),
      ...(tile.bevel ? { bevel: tile.bevel } : {}),
    };
    details.push({ role: "tile", col: c.col, row: c.row, supportedBy: [...new Set(supportedBy)], element });
  }

  return {
    name, frame, details, radius: section.radius, radiusX: path.radius, planarity, cells: cells.length,
    model: { elements: details.map((d) => d.element) },
  };
}
