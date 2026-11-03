import type { Member } from "./types";
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

/** Parametric curve on s ∈ [0, 1] plus the default profile "up" at the start. */
interface Curve {
  readonly at: (s: number) => Vec3;
  readonly defaultUp: Vec3;
  /** Exact segment lengths are possible without resampling (straight lines, circles). */
  readonly uniform: boolean;
}

export function discretize(el: Member): Discretized {
  const curve = curveOf(el);
  const segLen = el.segmentLength;
  const nodes = curve.uniform ? sampleUniform(curve, segLen) : sampleByArcLength(curve, segLen!);
  nodes[0] = el.start;
  nodes[nodes.length - 1] = el.end;
  return { nodes, frames: buildFrames(nodes, el.up ?? curve.defaultUp) };
}

function curveOf(el: Member): Curve {
  switch (el.kind) {
    case "straight":
      return lineCurve(el.start, el.end);
    case "arc":
      return arcCurve(el.start, el.end, el.startTangent);
    case "ellipticArc":
      return ellipticCurve(el.start, el.end, el.startTangent, el.baseStart ?? el.start, el.baseEnd);
    case "groinArc":
      return groinCurve(el);
  }
}

/**
 * Point of a member at height z (members rising monotonically in z, e.g. ribs).
 * Exact on the member's curve (bisection on the curve parameter), not on its polyline.
 */
export function pointAtHeight(el: Member, z: number): Vec3 {
  if (el.kind === "groinArc") return groinPoint(el, z);
  return curvePointAtZ(curveOf(el), z);
}

function curvePointAtZ(curve: Curve, z: number): Vec3 {
  let lo = 0;
  let hi = 1;
  const rising = curve.at(1)[2] >= curve.at(0)[2];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (curve.at(mid)[2] < z === rising) lo = mid;
    else hi = mid;
  }
  return curve.at((lo + hi) / 2);
}

function groinPoint(el: Extract<Member, { kind: "groinArc" }>, z: number): Vec3 {
  const a = curvePointAtZ(arcCurve(el.archA.start, el.archA.end, el.archA.startTangent), z);
  const b = curvePointAtZ(arcCurve(el.archB.start, el.archB.end, el.archB.startTangent), z);
  const p = intersectPlanLines(a, el.dirA, b, el.dirB);
  return [p[0], p[1], z];
}

/** Plan (XY) intersection of the lines p + t·u and q + s·v. */
export function intersectPlanLines(p: Vec3, u: Vec3, q: Vec3, v: Vec3): Vec3 {
  const denom = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(denom) < 1e-12) throw new Error("Parallel plan lines do not intersect");
  const w = sub(q, p);
  const t = (w[0] * v[1] - w[1] * v[0]) / denom;
  return add(p, scale(u, t));
}

function groinCurve(el: Extract<Member, { kind: "groinArc" }>): Curve {
  const z0 = el.start[2];
  const z1 = el.end[2];
  const plan = sub(el.end, el.start);
  return {
    at: (s) => groinPoint(el, z0 + (z1 - z0) * s),
    // Springing tangent is vertical: profile up = horizontal, towards the end in plan.
    defaultUp: normalize([plan[0], plan[1], 0]),
    uniform: false,
  };
}

function lineCurve(start: Vec3, end: Vec3): Curve {
  const d = sub(end, start);
  if (len(d) < 1e-9) throw new Error("Element has zero length");
  const x = normalize(d);
  return {
    at: (s) => add(start, scale(d, s)),
    defaultUp: Math.abs(dot(x, WORLD_Z)) > 0.999 ? WORLD_X : WORLD_Z,
    uniform: true,
  };
}

/**
 * Circle through start and end, tangent to `tangent` at start.
 *   c = end - start, u = unit part of c perpendicular to t (points to the center)
 *   r = |c|^2 / (2 c·u), sweep = 2·angle(t, c)
 *   p(φ) = center + r(-u cosφ + t sinφ)
 */
function arcCurve(start: Vec3, end: Vec3, tangent: Vec3): Curve {
  const c = sub(end, start);
  const L = len(c);
  if (L < 1e-9) throw new Error("Arc has zero chord length");
  const t = normalize(tangent);
  const ct = dot(c, t);
  const perp = sub(c, scale(t, ct));
  const pl = len(perp);

  if (pl < 1e-9 * L) {
    if (ct > 0) return lineCurve(start, end); // tangent along chord -> straight
    throw new Error("Arc tangent points directly away from the end point");
  }

  const u = scale(perp, 1 / pl);
  const r = (L * L) / (2 * pl);
  const center = add(start, scale(u, r));
  const sweep = 2 * Math.acos(Math.max(-1, Math.min(1, ct / L)));
  return {
    at: (s) => add(center, add(scale(u, -r * Math.cos(sweep * s)), scale(t, r * Math.sin(sweep * s)))),
    defaultUp: u,
    uniform: true,
  };
}

/**
 * Reference circular arc baseStart → baseEnd, shifted by (start − baseStart) blended into
 * (end − baseEnd) in proportion to progress across the reference chord
 * (an affine image of a circle → ellipse).
 */
function ellipticCurve(start: Vec3, end: Vec3, tangent: Vec3, baseStart: Vec3, baseEnd: Vec3): Curve {
  const base = arcCurve(baseStart, baseEnd, tangent);
  const shift0 = sub(start, baseStart);
  const dShift = sub(sub(end, baseEnd), shift0);

  const u = base.defaultUp; // in the reference plane, perpendicular to the tangent
  const span = dot(sub(baseEnd, baseStart), u);
  if (Math.abs(span) < 1e-9) throw new Error("Elliptic arc: reference chord has no extent across the tangent");

  const at = (s: number): Vec3 => {
    const p = base.at(s);
    return add(add(p, shift0), scale(dShift, dot(sub(p, baseStart), u) / span));
  };
  // Profile up: the reference "up" mapped through the same shear (stays in the curve plane).
  const mappedU = normalize(add(u, scale(dShift, 1 / span)));
  return { at, defaultUp: mappedU, uniform: false };
}

/** Equal parameter steps — exact for lines and circles. */
function sampleUniform(curve: Curve, segLen?: number): Vec3[] {
  const n = segLen ? Math.max(1, Math.ceil(curveLength(curve) / segLen - 1e-9)) : 1;
  return Array.from({ length: n + 1 }, (_, i) => curve.at(i / n));
}

/** Nodes at equal arc-length spacing (≤ segLen), via a dense lookup table. */
function sampleByArcLength(curve: Curve, segLen: number, dense = 2000): Vec3[] {
  const pts: Vec3[] = [];
  const cum: number[] = [0];
  for (let i = 0; i <= dense; i++) {
    pts.push(curve.at(i / dense));
    if (i > 0) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  }
  const total = cum[dense];
  const n = Math.max(1, Math.ceil(total / segLen - 1e-9));
  const nodes: Vec3[] = [pts[0]];
  let j = 0;
  for (let k = 1; k < n; k++) {
    const target = (total * k) / n;
    while (cum[j + 1] < target) j++;
    const f = (target - cum[j]) / (cum[j + 1] - cum[j]);
    nodes.push(curve.at((j + f) / dense));
  }
  nodes.push(pts[dense]);
  return nodes;
}

function curveLength(curve: Curve, samples = 512): number {
  let L = 0;
  let prev = curve.at(0);
  for (let i = 1; i <= samples; i++) {
    const p = curve.at(i / samples);
    L += len(sub(p, prev));
    prev = p;
  }
  return L;
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
