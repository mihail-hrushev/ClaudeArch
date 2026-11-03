import type { Vec3 } from "./vec";
import type { Profile } from "./profiles";

interface ElementBase {
  readonly id: string;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly profile: Profile;
  /** Display color (r, g, b in 0..1). */
  readonly color?: Vec3;
  /**
   * Reference vector for the profile's local z axis at the start node.
   * Defaults: straight -> world Z (world X for vertical members);
   * curved -> in the curve plane, perpendicular to the start tangent (towards the bend).
   */
  readonly up?: Vec3;
}

export interface StraightElement extends ElementBase {
  readonly kind: "straight";
  /** Optional subdivision into FEM sub-segments (geometry stays one straight bar). */
  readonly segmentLength?: number;
}

/**
 * Circular arc from start to end. The arc plane and curvature are fully defined
 * by the tangent direction at the start node.
 */
export interface ArcElement extends ElementBase {
  readonly kind: "arc";
  readonly startTangent: Vec3;
  /** Maximum length of one straight segment. */
  readonly segmentLength: number;
}

/**
 * Elliptic arc = affine stretch of a reference circular arc.
 * The reference arc runs start → `baseEnd` with `startTangent`. Each of its points is
 * shifted by (end − baseEnd) proportionally to its progress across the reference chord,
 * so the result ends at `end`. Projected along (end − baseEnd), the elliptic arc
 * coincides exactly with the reference arc.
 * Example: gothic diagonal rib (corner → keystone) whose side view equals the wall arch
 * (corner → wall apex = baseEnd).
 */
export interface EllipticArcElement extends ElementBase {
  readonly kind: "ellipticArc";
  readonly startTangent: Vec3;
  readonly baseEnd: Vec3;
  readonly segmentLength: number;
}

export type Element = StraightElement | ArcElement | EllipticArcElement;

export interface Model {
  readonly elements: readonly Element[];
}
