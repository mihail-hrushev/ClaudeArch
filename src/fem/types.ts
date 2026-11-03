import type { Vec3 } from "./vec";
import type { Profile } from "./profiles";

interface ElementBase {
  readonly id: string;
  /** Display color (r, g, b in 0..1). */
  readonly color?: Vec3;
}

/** Line element (beam): start/end nodes and a cross-section profile swept along its axis. */
interface MemberBase extends ElementBase {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly profile: Profile;
  /**
   * Reference vector for the profile's local z axis at the start node.
   * Defaults: straight -> world Z (world X for vertical members);
   * curved -> in the curve plane, perpendicular to the start tangent (towards the bend).
   */
  readonly up?: Vec3;
  /**
   * Normal of the plane the member end is cut on (through `end`; default: perpendicular to
   * the end tangent). E.g. the mirror plane of a pointed arch, so both halves close at the apex.
   */
  readonly endCut?: Vec3;
}

export interface StraightElement extends MemberBase {
  readonly kind: "straight";
  /** Optional subdivision into FEM sub-segments (geometry stays one straight bar). */
  readonly segmentLength?: number;
}

/**
 * Circular arc from start to end. The arc plane and curvature are fully defined
 * by the tangent direction at the start node.
 */
export interface ArcElement extends MemberBase {
  readonly kind: "arc";
  readonly startTangent: Vec3;
  /** Maximum length of one straight segment. */
  readonly segmentLength: number;
}

/**
 * Elliptic arc = affine stretch of a reference circular arc.
 * The reference arc runs `baseStart` (default: start) → `baseEnd` with `startTangent`.
 * Each of its points is shifted by a blend of (start − baseStart) and (end − baseEnd),
 * proportional to its progress across the reference chord, so the result runs start → end.
 * When both shifts are parallel, projecting the elliptic arc along them gives exactly the
 * reference arc.
 * Example: gothic diagonal rib (springing → keystone) whose side view equals the wall arch.
 */
export interface EllipticArcElement extends MemberBase {
  readonly kind: "ellipticArc";
  readonly startTangent: Vec3;
  readonly baseStart?: Vec3;
  readonly baseEnd: Vec3;
  readonly segmentLength: number;
}

/** Circular arch used as a reference (same definition as an arc element). */
export interface ArchRef {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly startTangent: Vec3;
}

/**
 * Groin rib: intersection curve of two cylindrical vault surfaces — arch A extruded along
 * the horizontal direction `dirA` and arch B extruded along `dirB`. At every height z the
 * rib point is the plan intersection of the line through A(z) along dirA and the line
 * through B(z) along dirB. Seen along dirA it coincides with arch A, along dirB with arch B.
 * Both arches must rise monotonically to the same height. `start`/`end` are the curve ends.
 */
export interface GroinArcElement extends MemberBase {
  readonly kind: "groinArc";
  readonly archA: ArchRef;
  readonly dirA: Vec3;
  readonly archB: ArchRef;
  readonly dirB: Vec3;
  readonly segmentLength: number;
}

export type Member = StraightElement | ArcElement | EllipticArcElement | GroinArcElement;

/**
 * Flat plate (shell) element, e.g. one glass pane.
 * `corners` are the nodes of the mid-surface: a convex coplanar polygon (usually 4 corners;
 * 3–5 where a pane is cut by a rib), counter-clockwise around the plate normal.
 * The solid extends ±thickness/2 along the normal.
 */
export interface PlateElement extends ElementBase {
  readonly kind: "plate";
  readonly corners: readonly Vec3[];
  readonly thickness: number;
  /** 0 = invisible … 1 = opaque (glass < 1). */
  readonly alpha?: number;
}

export type Element = Member | PlateElement;

export const isMember = (el: Element): el is Member => el.kind !== "plate";

export interface Model {
  readonly elements: readonly Element[];
}
