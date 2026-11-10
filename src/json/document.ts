/**
 * Structure document: a JSON file that describes a glass and steel building as catalogues of
 * details (profiles, glass, surface types, rail and stair types), a plan of named outlines and
 * levels, and a list of build operations that arrange the instruments (glass surfaces, columns,
 * arches, beams, handrails, stairs …) into one structure.
 *
 * The document holds only names, numbers and references. Anything that needs geometry is an
 * operator (src/json/operators), written once in TypeScript; lengths allow plain arithmetic only.
 *
 * Lengths are numbers in scene units (centimetres), strings with a unit ("1200mm", "4.2m",
 * "35cm"), the name of a level from `levels` (named lengths: heights and plan dimensions alike),
 * or + - * / and parentheses on those ("-half - bay / 2"; a bare number is a plain factor).
 */
import { z } from "zod";

export const Length = z.union([z.number(), z.string()]);
export type LengthSpec = z.infer<typeof Length>;

/** Unitless number, e.g. a count, an angle in degrees or a share. */
export const Num = z.number();

export const Vec3Spec = z.tuple([Length, Length, Length]);
export const P2Spec = z.tuple([Length, Length]);
export const Color = z.tuple([Num, Num, Num]);

/**
 * A direction in a glass surface's section: `[inward, up]` (e.g. [0, 1] vertical, [1, 1] at 45
 * degrees), the name of one in `tangents`, or the older local `[0, inward, up]`.
 */
export const Tangent2Spec = z.tuple([Num, Num]);
export const TangentRef = z.union([z.string(), Tangent2Spec, z.tuple([Num, Num, Num])]);
export type TangentRefSpec = z.infer<typeof TangentRef>;

export const ProfileSpec = z.union([
  z.object({ circle: Length, segments: Num.int().min(3).optional() }).strict(),
  z.object({ rect: z.tuple([Length, Length]) }).strict(),
  z.object({ square: Length }).strict(),
  z.object({ regular: Num.int().min(3), radius: Length }).strict(),
]);
/** A profile: the name of one in `profiles`, or an inline specification. */
export const ProfileRef = z.union([z.string(), ProfileSpec]);
export type ProfileRefSpec = z.infer<typeof ProfileRef>;

export const TileAlign = z.enum([
  "bottom-left", "bottom-center", "bottom-right",
  "middle-left", "middle-center", "middle-right",
  "top-left", "top-center", "top-right",
]);

/**
 * A named glass material: its colour, opacity (`alpha`, 0 invisible … 1 opaque), share of the sky
 * it reflects (`reflection`, 0 … 1) and the colour it glows with (`emissive`, default none).
 * With `metallic` and `roughness` (0 … 1) it is a physically based material exactly as in glTF
 * (`color` = baseColorFactor, `emissive` = emissiveFactor, both linear), and `reflection` is unused.
 */
export const MaterialSpec = z.object({
  color: Color.optional(),
  alpha: Num.optional(),
  reflection: Num.optional(),
  emissive: Color.optional(),
  metallic: Num.min(0).max(1).optional(),
  roughness: Num.min(0).max(1).optional(),
}).strict();
export type MaterialSpecType = z.infer<typeof MaterialSpec>;

/** Glass of a window or screen: a `material` by name, and fields that override it. */
export const GlassSpec = MaterialSpec.extend({
  thickness: Length.optional(),
  material: z.string().optional(),
}).strict();
export type GlassSpecType = z.infer<typeof GlassSpec>;

/**
 * Tile of a glazed surface; `preset` takes the defaults from `glass`, `material` (its own or its
 * preset's) the look from `materials`, fields here override both.
 */
export const TileSpec = z.object({
  preset: z.string().optional(),
  material: z.string().optional(),
  width: Length.optional(),
  length: Length.optional(),
  thickness: Length.optional(),
  gap: Length.optional(),
  fit: z.enum(["cut", "equal"]).optional(),
  align: TileAlign.optional(),
  color: Color.optional(),
  alpha: Num.optional(),
  reflection: Num.optional(),
  emissive: Color.optional(),
  metallic: Num.min(0).max(1).optional(),
  roughness: Num.min(0).max(1).optional(),
  bevel: z.object({ width: Length, depth: Length }).strict().optional(),
}).strict();
export type TileSpecType = z.infer<typeof TileSpec>;

export const Padding = z.union([
  Length,
  z.object({ left: Length.optional(), right: Length.optional(), bottom: Length.optional(), top: Length.optional() }).strict(),
]);

/** A glazed surface type; `extends` takes everything from another type, fields here override. */
export const SurfaceTypeSpec = z.object({
  extends: z.string().optional(),
  ribStep: Length.optional(),
  ribsOnGrid: z.union([z.boolean(), z.literal("symmetric")]).optional(),
  padding: Padding.optional(),
  tile: TileSpec.optional(),
  profiles: z.object({
    mainRib: ProfileRef.optional(),
    horizontalFrame: ProfileRef.optional(),
    verticalFrame: ProfileRef.optional(),
    cutRib: ProfileRef.optional(),
    openingRib: ProfileRef.optional(),
  }).strict().optional(),
  ribColor: Color.optional(),
  frameColor: Color.optional(),
  /**
   * Tile the surfaces of this type with flat hexagons instead of rectangles (see
   * generators/honeycombSurface): `cell` across the flats (default the tile's width),
   * `orientation` "pointy" or "flat", `offset` moving the glass along its normal.
   */
  honeycomb: z.object({
    cell: Length.optional(),
    orientation: z.enum(["pointy", "flat"]).optional(),
    offset: Length.optional(),
  }).strict().optional(),
}).strict();
export type SurfaceTypeSpecType = z.infer<typeof SurfaceTypeSpec>;

/** A handrail type (see generators/handrail). */
export const HandrailTypeSpec = z.object({
  height: Length,
  middleHeight: Length,
  kickHeight: Length,
  postStep: Length,
  railBeamDrop: Length.optional(),
  profiles: z.object({
    post: ProfileRef,
    topRail: ProfileRef,
    middleRail: ProfileRef,
    kickRail: ProfileRef,
    railBeam: ProfileRef.optional(),
  }).strict(),
  color: Color.optional(),
}).strict();

/** A stair type (see generators/stair). */
export const StairTypeSpec = z.object({
  width: Length,
  riser: Length,
  tread: Length,
  treadThickness: Length,
  platform: z.object({ width: Length, length: Length }).strict(),
  profiles: z.object({ stringer: ProfileRef, post: ProfileRef }).strict(),
  handrail: z.string().optional(),
  color: Color.optional(),
  treadColor: Color.optional(),
}).strict();

/**
 * A plan outline: a counter-clockwise polygon in the ground plane.
 *   regular  a regular polygon: `sides`, and `radius` (to a corner) or `apothem` (to a side);
 *            `rotation` turns it (degrees, first corner from +X)
 *   polygon  explicit corners (any direction; turned counter-clockwise)
 *   rect     width along X and depth along Y around `center`
 *   offset   another outline moved out by `by` (in when negative), sides staying parallel
 *   hull     the convex hull around other outlines, then moved out by `margin`
 *   union    the outline around other outlines that touch or overlap, walked around the
 *            outside; a corner where two only touch is passed twice
 *   beside   a copy of another outline moved in `direction` (degrees from +X) until it just
 *            touches the original, plus `gap`
 *   cross    arms `width` wide along ±X and ±Y (`right`, `rear`, `left`, `front`: distance from the
 *            centre to the centre of the arm's apse), each ending in an apse of `apseSides` flat
 *            facets (0: a flat end); where an arm is missing the crossing closes straight, divided
 *            at the corners of a crossing `crossing` wide (default: the arm width), so the same
 *            sides in the same order are kept when the outline is moved in or out
 *   ellipse  width along X and depth along Y around `center`, `sides` corners (default 48)
 *   apse     a half polygon of `segments` equal sides on the outside of side [plan, i]: that side
 *            is its diameter, its corners lie on the half circle; corner 0 is the side's start, the
 *            last side the diameter back to it
 */
export const PlanSpec = z.union([
  z.object({
    regular: Num.int().min(3), radius: Length.optional(), apothem: Length.optional(),
    center: P2Spec.optional(), rotation: Num.optional(),
  }).strict(),
  z.object({
    cross: z.object({ right: Length.optional(), rear: Length.optional(), left: Length.optional(), front: Length.optional() }).strict(),
    width: Length, apseSides: Num.int().min(0).optional(), crossing: Length.optional(), center: P2Spec.optional(),
  }).strict(),
  z.object({ ellipse: z.tuple([Length, Length]), sides: Num.int().min(3).optional(), center: P2Spec.optional() }).strict(),
  z.object({ polygon: z.array(P2Spec).min(3) }).strict(),
  z.object({ rect: z.tuple([Length, Length]), center: P2Spec.optional() }).strict(),
  z.object({ offset: z.string(), by: Length }).strict(),
  z.object({ hull: z.array(z.string()).min(1), margin: Length.optional() }).strict(),
  z.object({ union: z.array(z.string()).min(1) }).strict(),
  z.object({ beside: z.string(), direction: Num, gap: Length.optional() }).strict(),
  z.object({ apse: z.tuple([z.string(), Num.int()]), segments: Num.int().min(1) }).strict(),
]);
export type PlanSpecType = z.infer<typeof PlanSpec>;

/**
 * A point in space.
 *   [x, y, z]                   coordinates
 *   { corner: [plan, i], z }    corner i of a plan outline, at height z (default 0)
 *   { side: [plan, i], at, inward, z }
 *                               on side i of an outline: `at` is the distance from its start
 *                               (default: the middle), `inward` moves it into the plan
 *   { column: [result, i], z }  axis of column i of a `columns` result (z default: its foot)
 */
export const PointSpec = z.union([
  Vec3Spec,
  z.object({ corner: z.tuple([z.string(), Num.int()]), z: Length.optional() }).strict(),
  z.object({
    side: z.tuple([z.string(), Num.int()]), at: Length.optional(), inward: Length.optional(), z: Length.optional(),
  }).strict(),
  z.object({ column: z.tuple([z.string(), Num.int()]), z: Length.optional() }).strict(),
]);
export type PointSpecType = z.infer<typeof PointSpec>;

/**
 * A cutting plane, keeping the side its normal points to.
 *   { point, normal }            explicit plane
 *   { plan, side: i, end: 0|1 }  bisector plane at one end of side i of a plan (keeps that side's sector)
 *   { plan, side: i }            the plane of side i, keeping the inside of the plan
 *   ... outside: true            either of those two, keeping the other side
 *   { plan }                     all the sides of a plan: keeps the inside (as an opening: a hole
 *                                of that outline)
 */
export const CutSpec = z.union([
  z.object({ point: PointSpec, normal: Vec3Spec }).strict(),
  z.object({ plan: z.string(), side: Num.int(), end: Num.int().min(0).max(1).optional(), inset: Length.optional(), outside: z.boolean().optional() }).strict(),
  z.object({ plan: z.string(), inset: Length.optional() }).strict(),
]);
export type CutSpecType = z.infer<typeof CutSpec>;

/**
 * An opening in a glazed surface: a hole of a plan outline (its name), explicit planes with their
 * normals pointing into the hole, or a round-headed arch standing on side i of a plan at `at`
 * from its start (default: the middle), springing at `spring`, of `radius`, in `facets` flat
 * pieces (default 16): the end of a barrel vault running into a wall.
 */
export const OpeningSpec = z.union([
  z.string(),
  z.array(CutSpec),
  z.object({
    arch: z.object({
      side: z.tuple([z.string(), Num.int()]), at: Length.optional(), spring: Length, radius: Length, facets: Num.int().min(2).optional(),
    }).strict(),
  }).strict(),
]);
export type OpeningSpecType = z.infer<typeof OpeningSpec>;

export const View = z.object({
  target: Vec3Spec,
  radius: Length,
  /** Orbit angles in degrees. */
  alpha: Num,
  beta: Num,
}).strict();

/** One build step; the operator's own schema validates the rest of its fields. */
export const OperationSpec = z.object({ op: z.string(), name: z.string().optional() }).passthrough();
export type OperationSpecType = z.infer<typeof OperationSpec>;

/**
 * A reusable assembly: its own outlines and build steps, written in its local coordinates (as if
 * placed at the origin, unrotated). A `group` step builds it and places the result.
 */
export const GroupSpec = z.object({
  description: z.string().optional(),
  /** Outlines seen only inside the group; they may shadow the document's. */
  plan: z.record(PlanSpec).optional(),
  build: z.array(OperationSpec),
}).strict();

export const StructureDocument = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** The material of ribs, frames and supports, by name from `materials` (e.g. "steel"). */
  material: z.string().optional(),
  /** Default colour of ribs, frames and supports (overrides the material's). */
  color: Color.optional(),
  /**
   * With these (0 … 1; they override the material's) every member is a physically based material
   * exactly as in glTF, e.g. black ironwork: `color` is then linear (glTF baseColorFactor) and the
   * members are lit by the HDRI sky.
   */
  metallic: Num.min(0).max(1).optional(),
  roughness: Num.min(0).max(1).optional(),
  view: View.optional(),
  profiles: z.record(ProfileSpec).optional(),
  /** Materials by name: glass for presets, tiles and window glass; the framing (`material` above) and bands. */
  materials: z.record(MaterialSpec).optional(),
  /** Glass (or tile) presets, referenced by `tile.preset`. */
  glass: z.record(TileSpec).optional(),
  surfaces: z.record(SurfaceTypeSpec).optional(),
  handrails: z.record(HandrailTypeSpec).optional(),
  stairs: z.record(StairTypeSpec).optional(),
  /** Named heights, usable wherever a length is expected. */
  levels: z.record(Length).optional(),
  /** Named section tangents `[inward, up]`, usable wherever a surface tangent is expected. */
  tangents: z.record(Tangent2Spec).optional(),
  /** Named outlines, in order: one may refer to those before it. */
  plan: z.record(PlanSpec).optional(),
  /** Reusable assemblies, placed by `group` steps. */
  groups: z.record(GroupSpec).optional(),
  build: z.array(OperationSpec),
}).strict();
export type StructureDocumentType = z.infer<typeof StructureDocument>;
