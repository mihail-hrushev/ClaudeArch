/**
 * Structure document: a JSON file that describes a glass and steel building as catalogues of
 * details (profiles, glass, surface types, rail and stair types), a plan of named outlines and
 * levels, and a list of build operations that arrange the instruments (glass surfaces, columns,
 * arches, beams, handrails, stairs …) into one structure.
 *
 * The document holds only names, numbers and references: no expressions. Anything that needs
 * geometry or arithmetic is an operator (src/json/operators), written once in TypeScript.
 *
 * Lengths are numbers in scene units (centimetres), strings with a unit ("1200mm", "4.2m",
 * "35cm"), or the name of a level from `levels`.
 */
import { z } from "zod";

export const Length = z.union([z.number(), z.string()]);
export type LengthSpec = z.infer<typeof Length>;

/** Unitless number, e.g. a count, an angle in degrees or a share. */
export const Num = z.number();

export const Vec3Spec = z.tuple([Length, Length, Length]);
export const P2Spec = z.tuple([Length, Length]);
export const Color = z.tuple([Num, Num, Num]);

export const ProfileSpec = z.union([
  z.object({ circle: Length, segments: Num.int().min(3).optional() }).strict(),
  z.object({ rect: z.tuple([Length, Length]) }).strict(),
  z.object({ square: Length }).strict(),
]);
/** A profile: the name of one in `profiles`, or an inline specification. */
export const ProfileRef = z.union([z.string(), ProfileSpec]);
export type ProfileRefSpec = z.infer<typeof ProfileRef>;

export const TileAlign = z.enum([
  "bottom-left", "bottom-center", "bottom-right",
  "middle-left", "middle-center", "middle-right",
  "top-left", "top-center", "top-right",
]);

/** Tile of a glazed surface; `preset` takes the defaults from `glass`, fields here override. */
export const TileSpec = z.object({
  preset: z.string().optional(),
  width: Length.optional(),
  length: Length.optional(),
  thickness: Length.optional(),
  gap: Length.optional(),
  fit: z.enum(["cut", "equal"]).optional(),
  align: TileAlign.optional(),
  color: Color.optional(),
  alpha: Num.optional(),
  reflection: Num.optional(),
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
  ribsOnGrid: z.boolean().optional(),
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
 */
export const PlanSpec = z.union([
  z.object({
    regular: Num.int().min(3), radius: Length.optional(), apothem: Length.optional(),
    center: P2Spec.optional(), rotation: Num.optional(),
  }).strict(),
  z.object({ polygon: z.array(P2Spec).min(3) }).strict(),
  z.object({ rect: z.tuple([Length, Length]), center: P2Spec.optional() }).strict(),
  z.object({ offset: z.string(), by: Length }).strict(),
  z.object({ hull: z.array(z.string()).min(1), margin: Length.optional() }).strict(),
  z.object({ union: z.array(z.string()).min(1) }).strict(),
  z.object({ beside: z.string(), direction: Num, gap: Length.optional() }).strict(),
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
 *   { plan }                     all the sides of a plan: keeps the inside (as an opening: a hole
 *                                of that outline)
 */
export const CutSpec = z.union([
  z.object({ point: PointSpec, normal: Vec3Spec }).strict(),
  z.object({ plan: z.string(), side: Num.int(), end: Num.int().min(0).max(1).optional(), inset: Length.optional() }).strict(),
  z.object({ plan: z.string(), inset: Length.optional() }).strict(),
]);
export type CutSpecType = z.infer<typeof CutSpec>;

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

export const StructureDocument = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Default colour of ribs, frames and supports. */
  color: Color.optional(),
  view: View.optional(),
  profiles: z.record(ProfileSpec).optional(),
  /** Glass (or tile) presets, referenced by `tile.preset`. */
  glass: z.record(TileSpec).optional(),
  surfaces: z.record(SurfaceTypeSpec).optional(),
  handrails: z.record(HandrailTypeSpec).optional(),
  stairs: z.record(StairTypeSpec).optional(),
  /** Named heights, usable wherever a length is expected. */
  levels: z.record(Length).optional(),
  /** Named outlines, in order: one may refer to those before it. */
  plan: z.record(PlanSpec).optional(),
  build: z.array(OperationSpec),
}).strict();
export type StructureDocumentType = z.infer<typeof StructureDocument>;
