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
   * Defaults: straight -> world Z (world X for vertical members); arc -> towards the arc center.
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
  /** Maximum arc length of one straight segment. */
  readonly segmentLength: number;
}

export type Element = StraightElement | ArcElement;

export interface Model {
  readonly elements: readonly Element[];
}
