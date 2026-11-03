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
 * Elliptic arc = circular arc stretched along `projectionAxis`.
 * The base circular arc is built from start to the end projected onto the plane
 * perpendicular to `projectionAxis` (with `startTangent`); its points are then shifted
 * along the axis proportionally to their progress across the base chord.
 * Projecting the result back along `projectionAxis` gives exactly the base circular arc.
 * Example: gothic diagonal rib whose side view equals the wall arch.
 */
export interface EllipticArcElement extends ElementBase {
  readonly kind: "ellipticArc";
  readonly startTangent: Vec3;
  readonly projectionAxis: Vec3;
  readonly segmentLength: number;
}

export type Element = StraightElement | ArcElement | EllipticArcElement;

export interface Model {
  readonly elements: readonly Element[];
}
