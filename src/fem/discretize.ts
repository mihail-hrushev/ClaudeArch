import type { Element } from "./types";
import {
  type Vec3,
  add, sub, scale, dot, cross, len, normalize, transport,
  WORLD_X, WORLD_Z,
} from "./vec";

/** Local axes of one straight segment: x along the segment, (y, z) span the cross-section. */
export interface SegmentFrame {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

/** An element as a polyline of FEM nodes with a rotation-minimizing frame per segment. */
export interface Discretized {
  readonly nodes: Vec3[];
  readonly frames: SegmentFrame[]; // frames.length === nodes.length - 1
}

export function discretize(el: Element): Discretized {
  const { nodes, defaultUp } =
    el.kind === "arc"
      ? arcNodes(el.start, el.end, el.startTangent, el.segmentLength)
      : straightNodes(el.start, el.end, el.segmentLength);
  return { nodes, frames: buildFrames(nodes, el.up ?? defaultUp) };
}

function straightNodes(start: Vec3, end: Vec3, segLen?: number) {
  const d = sub(end, start);
  const L = len(d);
  if (L < 1e-9) throw new Error("Element has zero length");
  const n = segLen ? Math.max(1, Math.ceil(L / segLen - 1e-9)) : 1;
  const nodes: Vec3[] = [];
  for (let i = 0; i <= n; i++) nodes.push(i === n ? end : add(start, scale(d, i / n)));
  const x = scale(d, 1 / L);
  const defaultUp = Math.abs(dot(x, WORLD_Z)) > 0.999 ? WORLD_X : WORLD_Z;
  return { nodes, defaultUp };
}

/**
 * Circle through start and end, tangent to `tangent` at start.
 *   c = end - start, u = unit part of c perpendicular to t (points to the center)
 *   r = |c|^2 / (2 c·u), sweep = 2·angle(t, c)
 *   p(φ) = center + r(-u cosφ + t sinφ)
 * Nodes lie exactly on the arc; segment count = ceil(arcLength / segLen).
 */
function arcNodes(start: Vec3, end: Vec3, tangent: Vec3, segLen: number) {
  const c = sub(end, start);
  const L = len(c);
  if (L < 1e-9) throw new Error("Arc has zero chord length");
  const t = normalize(tangent);
  const ct = dot(c, t);
  const perp = sub(c, scale(t, ct));
  const pl = len(perp);

  if (pl < 1e-9 * L) {
    if (ct > 0) return straightNodes(start, end, segLen); // tangent along chord -> straight
    throw new Error("Arc tangent points directly away from the end point");
  }

  const u = scale(perp, 1 / pl);
  const r = (L * L) / (2 * pl);
  const center = add(start, scale(u, r));
  const sweep = 2 * Math.acos(Math.max(-1, Math.min(1, ct / L)));
  const n = Math.max(1, Math.ceil((r * sweep) / segLen - 1e-9));

  const nodes: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const phi = (sweep * i) / n;
    nodes.push(add(center, add(scale(u, -r * Math.cos(phi)), scale(t, r * Math.sin(phi)))));
  }
  nodes.push(end);
  return { nodes, defaultUp: u };
}

/** Initial frame from `up`, then parallel-transported along the polyline (no twist). */
function buildFrames(nodes: Vec3[], up: Vec3): SegmentFrame[] {
  const frames: SegmentFrame[] = [];
  for (let k = 0; k < nodes.length - 1; k++) {
    const x = normalize(sub(nodes[k + 1], nodes[k]));
    const z =
      k === 0
        ? normalize(sub(up, scale(x, dot(up, x))))
        : normalize(transport(frames[k - 1].z, frames[k - 1].x, x));
    frames.push({ x, y: cross(z, x), z });
  }
  return frames;
}
