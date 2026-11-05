/**
 * Geometry side of the drawings: element meshes, orthographic views, convex pieces for the
 * painter's algorithm, silhouette / crease edges, and horizontal section cuts.
 * All coordinates here are scene units (cm); paper mapping happens in the drawing.
 */
import type { Element } from "../../src/fem/types";
import { type Vec3, sub, cross, dot, len, scale } from "../../src/fem/vec";
import { discretize } from "../../src/fem/discretize";
import { type MeshData, sweepProfile } from "../../src/fem/sweep";
import { plateSolid } from "../../src/fem/plate";
import type { P2 } from "./svg";

/** Orthographic view: `u` right and `v` up on the sheet, `near` grows towards the viewer. */
export interface View {
  readonly name: string;
  readonly u: (p: Vec3) => number;
  readonly v: (p: Vec3) => number;
  readonly near: (p: Vec3) => number;
  /** Direction of sight, into the scene. */
  readonly sight: Vec3;
}

/** Seen from the front (−Y), X to the right and Z up. */
export const FRONT_VIEW: View = { name: "front", u: (p) => p[0], v: (p) => p[2], near: (p) => -p[1], sight: [0, 1, 0] };
/** Seen from above, X to the right and Y up (front of the building at the bottom of the sheet). */
export const PLAN_VIEW: View = { name: "plan", u: (p) => p[0], v: (p) => p[1], near: (p) => p[2], sight: [0, 0, -1] };

export const project = (view: View, p: Vec3): P2 => [view.u(p), view.v(p)];

/** Triangle mesh of one element, exactly as the renderer builds it. */
export function elementMesh(el: Element): MeshData {
  return el.kind === "plate" ? plateSolid(el) : sweepProfile(discretize(el), el.profile, el.endCut);
}

export const vertex = (m: MeshData, i: number): Vec3 => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];

/** Convex hull (Andrew's monotone chain), counter-clockwise; fewer than 3 distinct points give what there is. */
export function convexHull(points: readonly P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique: P2[] = [];
  for (const p of pts) {
    const q = unique[unique.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) unique.push(p);
  }
  if (unique.length < 3) return unique;
  const turn = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Groups the triangles of an element into convex solids: a straight member or a plate is one;
 * a curved or bent member is convex between two consecutive miter planes, so its triangles are
 * grouped by the nearest segment of the element's node polyline.
 * Returns, per piece, the list of triangle indices.
 */
export function convexPieces(el: Element, mesh: MeshData): number[][] {
  const triangles = mesh.indices.length / 3;
  if (el.kind === "plate" || el.kind === "straight") return [Array.from({ length: triangles }, (_, t) => t)];
  const nodes = discretize(el).nodes;
  const segments = nodes.length - 1;
  if (segments <= 1) return [Array.from({ length: triangles }, (_, t) => t)];
  const pieces: number[][] = Array.from({ length: segments }, () => []);
  for (let t = 0; t < triangles; t++) {
    const a = vertex(mesh, mesh.indices[3 * t]);
    const b = vertex(mesh, mesh.indices[3 * t + 1]);
    const c = vertex(mesh, mesh.indices[3 * t + 2]);
    const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < segments; k++) {
      const d = distanceToSegment(centroid, nodes[k], nodes[k + 1]);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    pieces[best].push(t);
  }
  return pieces.filter((p) => p.length > 0);
}

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return len(sub(sub(p, a), scale(ab, t)));
}

/** Point on the segment a→b at height `z` (a and b on opposite sides of it). */
function crossAt(a: Vec3, b: Vec3, z: number): Vec3 {
  const t = (z - a[2]) / (b[2] - a[2]);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z];
}

/**
 * Points of a piece that lie on or below `maxZ` (all of them when undefined), with the points where
 * triangle edges cross that height: the hull of their projection is the piece's visible outline.
 */
export function pieceOutline(view: View, mesh: MeshData, triangles: readonly number[], maxZ?: number): { hull: P2[]; near: number } {
  const pts: P2[] = [];
  let near = -Infinity;
  const keep = (p: Vec3) => {
    pts.push(project(view, p));
    near = Math.max(near, view.near(p));
  };
  for (const t of triangles) {
    const corners = [0, 1, 2].map((k) => vertex(mesh, mesh.indices[3 * t + k]));
    for (let k = 0; k < 3; k++) {
      const a = corners[k];
      if (maxZ === undefined || a[2] <= maxZ) keep(a);
      if (maxZ !== undefined) {
        const b = corners[(k + 1) % 3];
        if ((a[2] < maxZ) !== (b[2] < maxZ) && a[2] !== b[2]) keep(crossAt(a, b, maxZ));
      }
    }
  }
  return { hull: convexHull(pts), near };
}

export type Segment3 = readonly [Vec3, Vec3];

const key = (p: Vec3) => `${Math.round(p[0] * 1000)}|${Math.round(p[1] * 1000)}|${Math.round(p[2] * 1000)}`;

/**
 * Edges of the mesh worth a line in the view: silhouette edges (one face towards the viewer, the
 * other away), creases sharper than `creaseCos` with a face towards the viewer, and open edges.
 * Flat-shaded faces own their vertices, so adjacency is rebuilt from the vertex positions.
 */
export function visibleEdges(mesh: MeshData, view: View, creaseCos = 0.5): Segment3[] {
  const ids = new Map<string, number>();
  const points: Vec3[] = [];
  const idOf = (p: Vec3) => {
    const k = key(p);
    let id = ids.get(k);
    if (id === undefined) {
      id = points.length;
      ids.set(k, id);
      points.push(p);
    }
    return id;
  };
  const triangles = mesh.indices.length / 3;
  const normals: Vec3[] = [];
  const front: boolean[] = [];
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  for (let t = 0; t < triangles; t++) {
    const p = [0, 1, 2].map((k) => vertex(mesh, mesh.indices[3 * t + k]));
    const n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    const l = len(n);
    if (l < 1e-9) {
      normals.push([0, 0, 0]);
      front.push(false);
      continue;
    }
    normals.push(scale(n, 1 / l));
    front.push(dot(normals[t], view.sight) < -1e-9);
    const v = p.map(idOf);
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      if (a === b) continue;
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = edges.get(ek);
      if (e) e.faces.push(t);
      else edges.set(ek, { a, b, faces: [t] });
    }
  }
  const out: Segment3[] = [];
  for (const e of edges.values()) {
    let draw = false;
    if (e.faces.length !== 2) draw = true;
    else {
      const [f, g] = e.faces;
      if (front[f] !== front[g]) draw = true;
      else if ((front[f] || front[g]) && dot(normals[f], normals[g]) < creaseCos) draw = true;
    }
    if (draw) out.push([points[e.a], points[e.b]]);
  }
  return out;
}

/** The part of a segment at or below `maxZ`, or null. */
export function clipBelow(s: Segment3, maxZ: number): Segment3 | null {
  const [a, b] = s;
  if (a[2] <= maxZ && b[2] <= maxZ) return s;
  if (a[2] > maxZ && b[2] > maxZ) return null;
  const c = crossAt(a, b, maxZ);
  return a[2] <= maxZ ? [a, c] : [c, b];
}

/**
 * Section of a closed mesh by the horizontal plane z = `cutZ`: the intersection segments of its
 * triangles chained into closed loops (3D points, all at z = cutZ). `open` collects the segments
 * that could not be chained (an open mesh, or a numerical mismatch).
 */
export function cutLoops(mesh: MeshData, cutZ: number): { loops: Vec3[][]; open: Segment3[] } {
  const segs: Segment3[] = [];
  const triangles = mesh.indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const p = [0, 1, 2].map((k) => vertex(mesh, mesh.indices[3 * t + k]));
    const hits: Vec3[] = [];
    for (let k = 0; k < 3; k++) {
      let a = p[k];
      let b = p[(k + 1) % 3];
      if ((a[2] < cutZ) === (b[2] < cutZ)) continue;
      // Canonical order: both triangles sharing this edge compute bit-identical points.
      if (key(a) > key(b)) [a, b] = [b, a];
      hits.push(crossAt(a, b, cutZ));
    }
    if (hits.length === 2) segs.push([hits[0], hits[1]]);
  }
  // Chain by endpoint keys.
  const at = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      const list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    }
  });
  const used = new Array<boolean>(segs.length).fill(false);
  const loops: Vec3[][] = [];
  const open: Segment3[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop: Vec3[] = [segs[i][0], segs[i][1]];
    const startKey = key(segs[i][0]);
    let closed = false;
    for (let guard = 0; guard < segs.length; guard++) {
      const tailKey = key(loop[loop.length - 1]);
      if (tailKey === startKey) {
        closed = true;
        break;
      }
      const next = (at.get(tailKey) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = true;
      const s = segs[next];
      loop.push(key(s[0]) === tailKey ? s[1] : s[0]);
    }
    if (closed) {
      loop.pop();
      if (loop.length >= 3) loops.push(loop);
    } else {
      for (let k = 0; k < loop.length - 1; k++) open.push([loop[k], loop[k + 1]]);
    }
  }
  return { loops, open };
}

/** Bounding box of a mesh. */
export function meshBounds(mesh: MeshData, into = { min: [Infinity, Infinity, Infinity] as number[], max: [-Infinity, -Infinity, -Infinity] as number[] }) {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k];
      if (v < into.min[k]) into.min[k] = v;
      if (v > into.max[k]) into.max[k] = v;
    }
  }
  return into;
}
