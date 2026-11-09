import type { Vec3 } from "./vec";
import type { Profile } from "./profiles";

interface ElementBase {
  readonly id: string;
  /** Display color (r, g, b in 0..1). */
  readonly color?: Vec3;
  /**
   * Diffuse texture (url under public/, e.g. "/textures/stone.jpg"), tiled in world units:
   * `tile` = scene units covered by one repeat (default 100 = 1 m).
   */
  readonly texture?: { readonly url: string; readonly tile?: number };
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
  /** Exact node positions as fractions 0 … 1 of the arc (replaces segmentLength spacing). */
  readonly divisions?: readonly number[];
}

/** Member through explicit nodes, e.g. a rib along a cut through a faceted surface. */
export interface PolylineElement extends MemberBase {
  readonly kind: "polyline";
  /** All nodes; the first and last equal `start` and `end`. */
  readonly nodes: readonly Vec3[];
}

export type Member = StraightElement | ArcElement | PolylineElement;

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
  /** Glass: share of the sky reflected when looking straight at it, 0 … 1 (default 0.08). */
  readonly reflection?: number;
  /** Colour the plate glows with, independent of the light (default none). */
  readonly emissive?: Vec3;
  /** Physically based look as in glTF (0 … 1); with these the colours are linear and `reflection` is unused. */
  readonly metallic?: number;
  readonly roughness?: number;
  /**
   * Facets around the top face (the +normal side), e.g. a ceramic tile: the top is inset by
   * `width` and a sloped strip `depth` deep runs down from it to the plate's edge. Pieces too
   * small for the inset get a smaller one, or none.
   */
  readonly bevel?: { readonly width: number; readonly depth: number };
}

export type Element = Member | PlateElement;

export interface Model {
  readonly elements: readonly Element[];
}
