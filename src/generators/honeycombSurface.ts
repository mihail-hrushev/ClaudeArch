import type { Element } from "../fem/types";
import { type Vec3, add, sub, scale, dot, cross, len, normalize } from "../fem/vec";
import { type GlassDetail, axisOffset } from "./glassSurface";
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
 * - Edge ribs: one polyline along each of the four edges of the surface (the cut rib profile).
 * - Tiles: one flat plate per cell (or cut-off part of a cell), less half the seam along every
 *   edge.
 *
 * Six corners on a doubly curved surface are not in one plane. The nodes are therefore moved
 * along the surface normal, all together, until every cell is as nearly flat as the shared
 * nodes allow; each tile is then made exactly flat in its own plane. `planarity` reports how far
 * the nodes still lie from the planes of their tiles: the most a tile edge stands off its rib.
 *
 * `offset` moves the glass of a tile along its own normal: forward (away from the structure)
 * when positive, back when negative. The ribs stay where they are.
 */
export interface HoneycombSurfaceParams extends Pick<
  GlassSurface2Params,
  "base" | "alongX" | "alongZ" | "tangent" | "tangentX" | "sweep" | "through" | "facing" | "tile" | "profiles" | "ribColor"
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
  /** Number of cells (whole or cut off at the edges). */
  readonly cells: number;
}

const RIB_COLOR: Vec3 = [0.3, 0.32, 0.36];
const GLASS_COLOR: Vec3 = [0.62, 0.85, 0.82];
const SQRT3 = Math.sqrt(3);
/** Rounds of node moves that flatten the cells. */
const FLATTEN_ROUNDS = 300;

type P2 = readonly [number, number];
type Side = "bottom" | "right" | "top" | "left";
const SIDES: readonly Side[] = ["bottom", "right", "top", "left"];

/** Convex polygon (counter-clockwise in u, v) kept inside the rectangle 0 … w, 0 … h. */
function clipToRect(polygon: readonly P2[], w: number, h: number): P2[] {
  // Each edge of the rectangle: distance inside it, and the point on it (snapped exactly onto its line).
  const edges: [(q: P2) => number, (a: P2, b: P2, t: number) => P2][] = [
    [(q) => q[1], (a, b, t) => [a[0] + (b[0] - a[0]) * t, 0]],
    [(q) => w - q[0], (a, b, t) => [w, a[1] + (b[1] - a[1]) * t]],
    [(q) => h - q[1], (a, b, t) => [a[0] + (b[0] - a[0]) * t, h]],
    [(q) => q[0], (a, b, t) => [0, a[1] + (b[1] - a[1]) * t]],
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
  if (gap <= 0) return [...points];
  const e1 = normalize(sub(points[1], points[0]));
  const e2 = cross(n, e1);
  const flat = points.map((q): P2 => [dot(sub(q, points[0]), e1), dot(sub(q, points[0]), e2)]);
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
  return moved.map(([x, y]) => add(points[0], add(scale(e1, x), scale(e2, y))));
}

/** Drops the nodes of straight runs. */
const mergeCollinear = (nodes: readonly Vec3[]) => nodes.filter((q, i) =>
  i === 0 || i === nodes.length - 1 || len(cross(normalize(sub(q, nodes[i - 1])), normalize(sub(nodes[i + 1], q)))) > 1e-9);

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

  // The honeycomb over the unrolled rectangle, a cell centred on its middle.
  const radius = cell / SQRT3;
  const flatTop = p.orientation === "flat";
  const [du, dv] = flatTop ? [1.5 * radius, cell] : [cell, 1.5 * radius];
  const corners = Array.from({ length: 6 }, (_, k) => {
    const a = ((flatTop ? 0 : 30) + 60 * k) * (Math.PI / 180);
    return [radius * Math.cos(a), radius * Math.sin(a)] as P2;
  });
  const odd = (k: number) => ((k % 2) + 2) % 2;
  const reachU = Math.ceil(width / 2 / du) + 2;
  const reachV = Math.ceil(height / 2 / dv) + 2;
  const minArea = 1e-4 * (SQRT3 / 2) * cell * cell;

  interface Cell { col: number; row: number; nodes: number[] }
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
  const raw: Cell[] = [];
  for (let i = -reachU; i <= reachU; i++) {
    for (let j = -reachV; j <= reachV; j++) {
      const centre: P2 = flatTop
        ? [width / 2 + i * du, height / 2 + (j + odd(i) / 2) * dv]
        : [width / 2 + (i + odd(j) / 2) * du, height / 2 + j * dv];
      const piece = clipToRect(corners.map(([x, y]) => [centre[0] + x, centre[1] + y] as P2), width, height);
      if (piece.length < 3 || area2(piece) < minArea) continue;
      const nodes = piece.map(nodeOf).filter((n, k, all) => n !== all[(k + 1) % all.length]);
      if (nodes.length >= 3) raw.push({ col: i, row: j, nodes });
    }
  }
  if (!raw.length) throw new Error("honeycombSurface: no cell fits on the surface");
  const [col0, row0] = [Math.min(...raw.map((c) => c.col)), Math.min(...raw.map((c) => c.row))];
  const cells = raw.map((c) => ({ ...c, col: c.col - col0, row: c.row - row0 }));

  // Nodes on the surface, then moved along its normal until the cells are as flat as they can be.
  const base = nodeUV.map(([u, v]) => surface(u, v));
  const normals = nodeUV.map(([u, v]) => normal(u, v));
  const lift = new Float64Array(nodeUV.length);
  const at = (n: number) => add(base[n], scale(normals[n], lift[n]));
  /** Each cell's plane: through the middle of its nodes, square to their Newell normal (towards the glass side). */
  const planeOf = (c: Cell) => {
    const points = c.nodes.map(at);
    return { centre: centroid(points), n: newell(points), points };
  };
  const sum = new Float64Array(nodeUV.length);
  const count = new Float64Array(nodeUV.length);
  for (let round = 0; round < FLATTEN_ROUNDS; round++) {
    sum.fill(0);
    count.fill(0);
    for (const c of cells) {
      if (c.nodes.length < 4) continue; // three nodes are always in a plane
      const { centre, n, points } = planeOf(c);
      c.nodes.forEach((id, k) => {
        sum[id] -= dot(sub(points[k], centre), n) / dot(normals[id], n);
        count[id] += 1;
      });
    }
    for (let id = 0; id < lift.length; id++) if (count[id]) lift[id] += sum[id] / count[id];
  }
  const node = nodeUV.map((_, id) => at(id));

  const details: GlassDetail[] = [];
  const ribColor = p.ribColor ?? RIB_COLOR;
  const ribOffset = axisOffset(profiles.mainRib, tile.thickness);
  const edgeProfile = profiles.cutRib ?? profiles.mainRib;
  const edgeOffset = axisOffset(edgeProfile, tile.thickness);
  const tol = 1e-6 * cell;

  /** The edges of the surface a node lies on. */
  const sidesOf = (id: number): Side[] => {
    const [u, v] = nodeUV[id];
    return SIDES.filter((s) => (s === "bottom" ? v : s === "right" ? width - u : s === "top" ? height - v : u) <= tol);
  };
  const edgeId = (s: Side) => `edge_${s}`;

  // Edge ribs: along each edge of the surface through the nodes on it.
  const edgeNodes = new Map<Side, number[]>(SIDES.map((s) => [s, []]));
  nodeUV.forEach((_, id) => sidesOf(id).forEach((s) => edgeNodes.get(s)!.push(id)));
  for (const s of SIDES) {
    const ids = edgeNodes.get(s)!;
    const along = (id: number) => nodeUV[id][s === "bottom" || s === "top" ? 0 : 1];
    ids.sort((a, b) => along(a) - along(b));
    if (ids.length < 2) continue;
    const nodes = mergeCollinear(ids.map((id) => add(node[id], scale(normals[id], edgeOffset))));
    details.push({
      role: "mainRib", supportedBy: [],
      element: { id: edgeId(s), kind: "polyline", nodes, start: nodes[0], end: nodes[nodes.length - 1], profile: edgeProfile, up: normals[ids[0]], color: ribColor },
    });
  }

  // Ribs: one per edge two cells share.
  const ribs = new Map<string, string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  /** The rib under the edge a → b of a cell: a shared rib, or the edge rib of the surface edge it runs along. */
  const ribUnder = (a: number, b: number): string => {
    const along = sidesOf(a).find((s) => sidesOf(b).includes(s));
    if (along) return edgeId(along);
    const key = edgeKey(a, b);
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
        supportedBy: [...new Set([...sidesOf(a), ...sidesOf(b)].map(edgeId))],
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
    const supportedBy = c.nodes.map((a, k) => ribUnder(a, c.nodes[(k + 1) % c.nodes.length]));
    const { centre, n, points } = planeOf(c);
    planarity = Math.max(planarity, ...points.map((q) => Math.abs(dot(sub(q, centre), n))));
    const flat = points.map((q) => sub(q, scale(n, dot(sub(q, centre), n))));
    const glass = inset(flat, n, gap);
    if (glass.length < 3) continue;
    const shift = scale(n, offsets.get(`${c.col},${c.row}`) ?? p.offset ?? 0);
    const element: Element = {
      id: `hex_c${c.col}_r${c.row}`, kind: "plate", thickness: tile.thickness, corners: glass.map((q) => add(q, shift)),
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
