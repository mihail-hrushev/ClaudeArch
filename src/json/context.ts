/**
 * Build context of a structure document: resolves lengths, profiles, surface types, plan
 * outlines, points and planes, keeps the named results of the operations run so far, and
 * collects the elements and instances that become the model.
 */
import type { Element, Model } from "../fem/types";
import { type Profile, circleProfile, rectangleProfile, regularProfile, squareProfile } from "../fem/profiles";
import { type Instance, assemble } from "../fem/placement";
import { removeDuplicateMembers } from "../fem/dedupe";
import { type Vec3, add, sub, scale, dot } from "../fem/vec";
import {
  type P2, type Side, at, centroid, convexHull, counterClockwise, crossPolygon, ellipsePolygon, offsetPolygon, radiusOfApothem,
  regularPolygon, sidesOf, unionOutline,
} from "../fem/plan";
import type { CutPlane, GlassSurfaceParams, GlassSurface } from "../generators/glassSurface";
import type { HandrailParams } from "../generators/handrail";
import type { StairParams } from "../generators/stair";
import type {
  CutSpecType, LengthSpec, OpeningSpecType, PlanSpecType, PointSpecType, ProfileRefSpec, StructureDocumentType, SurfaceTypeSpecType,
  TileSpecType, TangentRefSpec, MaterialSpecType, GlassSpecType } from "./document";

export class BuildError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
  }
}

/** Scene units per unit of length. */
const UNITS: Record<string, number> = { mm: 0.1, cm: 1, m: 100 };

/** A plan outline with its sides. */
export interface Plan {
  readonly name: string;
  readonly polygon: readonly P2[];
  readonly sides: readonly Side[];
  readonly centroid: P2;
}

/** Everything a glass surface needs apart from its placement. */
export type SurfaceType = Pick<GlassSurfaceParams, "ribStep" | "ribsOnGrid" | "padding" | "tile" | "profiles" | "ribColor" | "frameColor">;
export type HandrailType = Omit<HandrailParams, "base" | "alongX" | "padding">;
export type StairType = Omit<StairParams, "path" | "floor" | "height" | "arrival">;

/** A column placed by an operation: others stand arches and beams on it. */
export interface PlacedColumn {
  readonly id: string;
  /** Plan position, at the foot. */
  readonly at: Vec3;
  readonly top: number;
  /** Horizontal direction into the building (undefined for a free-standing column). */
  readonly inward?: Vec3;
  readonly profile: Profile;
}

/** A height field: the structure's surface over a plan point, e.g. a roof. */
export interface HeightField {
  heightAt(q: Vec3): number;
}

/** The bays of one side of an outline: lines across it at `shares` of its length, carried to matching sides. */
export interface BaySide {
  readonly a: Vec3;
  readonly along: Vec3;
  readonly length: number;
  readonly shares: readonly number[];
  /** Kept as equal shares of every matching side instead of fixed lines across. */
  readonly even: boolean;
}

/** Named results an operation can leave for the ones after it. */
export type BuildResult =
  | { readonly kind: "surfaces"; readonly blocks: readonly GlassSurface[] }
  | { readonly kind: "columns"; readonly columns: readonly PlacedColumn[] }
  | { readonly kind: "members"; readonly ids: readonly string[] }
  | { readonly kind: "height"; readonly field: HeightField; readonly blocks?: readonly GlassSurface[] }
  | { readonly kind: "points"; readonly points: readonly Vec3[] }
  | { readonly kind: "bays"; readonly margin: number; readonly sides: readonly BaySide[] };

export class BuildContext {
  readonly elements: Element[] = [];
  readonly instances: Instance[] = [];
  readonly results: Map<string, BuildResult>;
  readonly color: Vec3 | undefined;
  /** The document's physically based finish for members (see `metallic`/`roughness` on the document), if any. */
  readonly finish: { metallic: number; roughness: number } | undefined;
  /** How many groups deep this context builds (0: the document itself). */
  readonly depth: number;
  private readonly plans: Map<string, Plan>;
  private readonly profiles: Map<string, Profile>;
  private readonly surfaceTypes: Map<string, SurfaceType>;
  private readonly ids = new Set<string>();

  /** The document's context, or with `parent` a group's: it sees what the parent has, and keeps what it adds. */
  constructor(readonly doc: StructureDocumentType, parent?: BuildContext) {
    // The framing's look: its named material, with the document's own fields over it.
    const m = doc.material ? this.material(doc.material, "material") : {};
    this.color = doc.color ?? (m.color as Vec3 | undefined);
    const metallic = doc.metallic ?? m.metallic;
    const roughness = doc.roughness ?? m.roughness;
    this.finish = metallic === undefined && roughness === undefined ? undefined : { metallic: metallic ?? 0, roughness: roughness ?? 1 };
    this.depth = parent ? parent.depth + 1 : 0;
    this.results = new Map(parent?.results);
    this.plans = new Map(parent?.plans);
    this.profiles = parent?.profiles ?? new Map();
    this.surfaceTypes = parent?.surfaceTypes ?? new Map();
    if (!parent) for (const [name, spec] of Object.entries(doc.plan ?? {})) this.plans.set(name, this.makePlan(name, spec));
  }

  /** A context for building a group: its own outlines, elements and results. */
  child(plans: Record<string, PlanSpecType> | undefined, path: string): BuildContext {
    const c = new BuildContext(this.doc, this);
    for (const [name, spec] of Object.entries(plans ?? {})) {
      try {
        c.plans.set(name, c.makePlan(name, spec));
      } catch (e) {
        throw e instanceof BuildError ? new BuildError(e.message, `${path}.plan.${name}`) : e;
      }
    }
    return c;
  }

  // ---- lengths ---------------------------------------------------------------------------------

  /**
   * A length in scene units from a number, "<n><unit>", a level name, or simple arithmetic on
   * those: + - * / and parentheses, e.g. "-half - bay / 2" (a bare number is a plain factor).
   */
  length(spec: LengthSpec, path = "length", resolving: readonly string[] = []): number {
    if (typeof spec === "number") return spec;
    const level = this.doc.levels?.[spec];
    if (level !== undefined) {
      if (resolving.includes(spec)) throw new BuildError(`level "${spec}" refers to itself`, path);
      return this.length(level, `levels.${spec}`, [...resolving, spec]);
    }
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|m)\s*$/.exec(spec);
    if (m) return Number(m[1]) * UNITS[m[2]];
    return this.expression(spec, path, resolving);
  }

  /** Arithmetic on lengths and level names; see `length`. */
  private expression(text: string, path: string, resolving: readonly string[]): number {
    const tokens = text.match(/\d+(?:\.\d+)?(?:mm|cm|m)?(?![A-Za-z_])|[A-Za-z_][A-Za-z0-9_]*|[-+*/()]|\S/g) ?? [];
    let i = 0;
    const fail = (why: string): never => {
      throw new BuildError(`"${text}" is not a length: ${why} (a number with a unit, a level, or + - * / ( ) on those)`, path);
    };
    const primary = (): number => {
      const t = tokens[i++];
      if (t === undefined) return fail("it ends too early");
      if (t === "-") return -primary();
      if (t === "+") return primary();
      if (t === "(") {
        const v = sum();
        if (tokens[i++] !== ")") fail("a ( is not closed");
        return v;
      }
      const num = /^(\d+(?:\.\d+)?)(mm|cm|m)?$/.exec(t);
      if (num) return Number(num[1]) * (num[2] ? UNITS[num[2]] : 1);
      if (/^[A-Za-z_]/.test(t)) {
        if (this.doc.levels?.[t] === undefined) fail(`"${t}" is not a level`);
        return this.length(t, path, resolving);
      }
      return fail(`unexpected "${t}"`);
    };
    const product = (): number => {
      let v = primary();
      while (tokens[i] === "*" || tokens[i] === "/") v = tokens[i++] === "*" ? v * primary() : v / primary();
      return v;
    };
    const sum = (): number => {
      let v = product();
      while (tokens[i] === "+" || tokens[i] === "-") v = tokens[i++] === "+" ? v + product() : v - product();
      return v;
    };
    const v = sum();
    if (i < tokens.length) fail(`unexpected "${tokens[i]}"`);
    if (!Number.isFinite(v)) fail("it is not finite");
    return v;
  }

  optionalLength(spec: LengthSpec | undefined, path: string): number | undefined {
    return spec === undefined ? undefined : this.length(spec, path);
  }

  vec3(spec: readonly [LengthSpec, LengthSpec, LengthSpec], path: string): Vec3 {
    return [this.length(spec[0], `${path}[0]`), this.length(spec[1], `${path}[1]`), this.length(spec[2], `${path}[2]`)];
  }

  /** A section tangent as the local [0, inward, up] of a glass surface. */
  tangent(spec: TangentRefSpec, path: string): Vec3 {
    if (typeof spec === "string") {
      const named = this.doc.tangents?.[spec];
      if (!named) throw new BuildError(`unknown tangent "${spec}"`, path);
      return [0, named[0], named[1]];
    }
    return spec.length === 2 ? [0, spec[0], spec[1]] : [spec[0], spec[1], spec[2]];
  }

  p2(spec: readonly [LengthSpec, LengthSpec], path: string): P2 {
    return [this.length(spec[0], `${path}[0]`), this.length(spec[1], `${path}[1]`)];
  }

  // ---- catalogues ------------------------------------------------------------------------------

  profile(ref: ProfileRefSpec, path: string): Profile {
    if (typeof ref === "string") {
      const found = this.profiles.get(ref);
      if (found) return found;
      const spec = this.doc.profiles?.[ref];
      if (!spec) throw new BuildError(`unknown profile "${ref}"`, path);
      const made = this.profile(spec, `profiles.${ref}`);
      this.profiles.set(ref, made);
      return made;
    }
    if ("circle" in ref) return circleProfile(this.length(ref.circle, `${path}.circle`), ref.segments);
    if ("regular" in ref) return regularProfile(ref.regular, this.length(ref.radius, `${path}.radius`));
    if ("rect" in ref) return rectangleProfile(this.length(ref.rect[0], `${path}.rect[0]`), this.length(ref.rect[1], `${path}.rect[1]`));
    return squareProfile(this.length(ref.square, `${path}.square`));
  }

  /** A glass material by name from `materials`. */
  material(name: string, path: string): MaterialSpecType {
    const found = this.doc.materials?.[name];
    if (!found) throw new BuildError(`unknown material "${name}"`, path);
    return found;
  }

  /**
   * The look of a window's or screen's glass: its material, then its own fields, then the
   * operator's defaults.
   */
  glass(spec: GlassSpecType | undefined, path: string, defaults: { color: Vec3; alpha: number; reflection: number }) {
    const m = spec?.material ? this.material(spec.material, `${path}.material`) : {};
    const color = spec?.color ?? m.color ?? defaults.color;
    const emissive = spec?.emissive ?? m.emissive;
    const metallic = spec?.metallic ?? m.metallic;
    const roughness = spec?.roughness ?? m.roughness;
    return {
      color: color as Vec3, alpha: spec?.alpha ?? m.alpha ?? defaults.alpha, reflection: spec?.reflection ?? m.reflection ?? defaults.reflection,
      ...(emissive ? { emissive: emissive as Vec3 } : {}),
      ...(metallic !== undefined ? { metallic } : {}),
      ...(roughness !== undefined ? { roughness } : {}),
    };
  }

  /** A tile from its preset, its material, the fields given, and the `base` tile of an extended type. */
  private tile(spec: TileSpecType | undefined, path: string, base?: SurfaceType["tile"]): SurfaceType["tile"] | undefined {
    if (!spec) return base;
    const preset = spec.preset ? this.doc.glass?.[spec.preset] : undefined;
    if (spec.preset && !preset) throw new BuildError(`unknown glass preset "${spec.preset}"`, `${path}.preset`);
    const materialName = spec.material ?? preset?.material;
    const material = materialName ? this.material(materialName, `${path}.material`) : undefined;
    const merged = { ...material, ...preset, ...spec };
    const look = material ? undefined : base;
    const size = (key: "width" | "length" | "thickness" | "gap") => {
      if (merged[key] === undefined) return base?.[key];
      return this.length(merged[key]!, `${path}.${key}`);
    };
    const [width, length, thickness] = [size("width"), size("length"), size("thickness")];
    if (width === undefined || length === undefined || thickness === undefined) {
      throw new BuildError("tile needs width, length and thickness (own, from its preset or from the extended type)", path);
    }
    return {
      width, length, thickness, gap: size("gap"),
      fit: merged.fit ?? base?.fit, align: merged.align ?? base?.align,
      // A tile naming a material takes its whole look from it, none from the extended type.
      color: merged.color ?? look?.color, alpha: merged.alpha ?? look?.alpha, reflection: merged.reflection ?? look?.reflection,
      emissive: merged.emissive ?? look?.emissive,
      metallic: merged.metallic ?? look?.metallic, roughness: merged.roughness ?? look?.roughness,
      bevel: merged.bevel
        ? { width: this.length(merged.bevel.width, `${path}.bevel.width`), depth: this.length(merged.bevel.depth, `${path}.bevel.depth`) }
        : base?.bevel,
    };
  }

  padding(spec: SurfaceTypeSpecType["padding"], path: string): SurfaceType["padding"] {
    if (spec === undefined) return undefined;
    if (typeof spec === "number" || typeof spec === "string") return this.length(spec, path);
    // Only the sides given: an explicit `undefined` would override the generator's zero defaults.
    const out: { left?: number; right?: number; bottom?: number; top?: number } = {};
    for (const side of ["left", "right", "bottom", "top"] as const) {
      if (spec[side] !== undefined) out[side] = this.length(spec[side]!, `${path}.${side}`);
    }
    return out;
  }

  /** A surface type by name, or inline; `extends` chains are merged field by field. */
  surfaceType(ref: string | SurfaceTypeSpecType, path: string, seen: string[] = []): SurfaceType {
    if (typeof ref === "string") {
      const found = this.surfaceTypes.get(ref);
      if (found) return found;
      const spec = this.doc.surfaces?.[ref];
      if (!spec) throw new BuildError(`unknown surface type "${ref}"`, path);
      if (seen.includes(ref)) throw new BuildError(`surface type "${ref}" extends itself`, path);
      const made = this.surfaceType(spec, `surfaces.${ref}`, [...seen, ref]);
      this.surfaceTypes.set(ref, made);
      return made;
    }
    const base = ref.extends ? this.surfaceType(ref.extends, `${path}.extends`, seen) : undefined;
    const tile = this.tile(ref.tile, `${path}.tile`, base?.tile);
    const p = ref.profiles ?? {};
    const prof = (key: keyof typeof p) => (p[key] === undefined ? base?.profiles[key] : this.profile(p[key]!, `${path}.profiles.${key}`));
    const profiles = {
      mainRib: prof("mainRib"), horizontalFrame: prof("horizontalFrame"), verticalFrame: prof("verticalFrame"),
      cutRib: prof("cutRib"), openingRib: prof("openingRib"),
    };
    if (!profiles.mainRib || !profiles.horizontalFrame) throw new BuildError("profiles.mainRib and profiles.horizontalFrame are required", path);
    if (!tile) throw new BuildError("tile is required", path);
    const ribStep = ref.ribStep === undefined ? base?.ribStep : this.length(ref.ribStep, `${path}.ribStep`);
    return {
      ribStep: ribStep ?? Number.POSITIVE_INFINITY,
      ribsOnGrid: ref.ribsOnGrid ?? base?.ribsOnGrid,
      padding: ref.padding === undefined ? base?.padding : this.padding(ref.padding, `${path}.padding`),
      tile,
      profiles: { ...profiles, mainRib: profiles.mainRib, horizontalFrame: profiles.horizontalFrame },
      ribColor: ref.ribColor ?? base?.ribColor ?? this.color,
      frameColor: ref.frameColor ?? base?.frameColor ?? this.color,
    };
  }

  handrailType(name: string, path: string): HandrailType {
    const spec = this.doc.handrails?.[name];
    if (!spec) throw new BuildError(`unknown handrail type "${name}"`, path);
    const p = `handrails.${name}`;
    const prof = (key: keyof typeof spec.profiles) => (spec.profiles[key] === undefined ? undefined : this.profile(spec.profiles[key]!, `${p}.profiles.${key}`));
    return {
      height: this.length(spec.height, `${p}.height`), middleHeight: this.length(spec.middleHeight, `${p}.middleHeight`),
      kickHeight: this.length(spec.kickHeight, `${p}.kickHeight`), postStep: this.length(spec.postStep, `${p}.postStep`),
      railBeamDrop: this.optionalLength(spec.railBeamDrop, `${p}.railBeamDrop`),
      profiles: { post: prof("post")!, topRail: prof("topRail")!, middleRail: prof("middleRail")!, kickRail: prof("kickRail")!, railBeam: prof("railBeam") },
      color: spec.color ?? this.color,
    };
  }

  stairType(name: string, path: string): StairType {
    const spec = this.doc.stairs?.[name];
    if (!spec) throw new BuildError(`unknown stair type "${name}"`, path);
    const p = `stairs.${name}`;
    const rail = spec.handrail ? this.handrailType(spec.handrail, `${p}.handrail`) : undefined;
    return {
      width: this.length(spec.width, `${p}.width`), riser: this.length(spec.riser, `${p}.riser`), tread: this.length(spec.tread, `${p}.tread`),
      treadThickness: this.length(spec.treadThickness, `${p}.treadThickness`),
      platform: { width: this.length(spec.platform.width, `${p}.platform.width`), length: this.length(spec.platform.length, `${p}.platform.length`) },
      profiles: { stringer: this.profile(spec.profiles.stringer, `${p}.profiles.stringer`), post: this.profile(spec.profiles.post, `${p}.profiles.post`) },
      handrail: rail && (({ railBeamDrop: _drop, color: _color, ...rest }) => ({ ...rest, profiles: { ...rest.profiles, railBeam: undefined } }))(rail),
      color: spec.color ?? this.color, treadColor: spec.treadColor,
    };
  }

  // ---- plan ------------------------------------------------------------------------------------

  private makePlan(name: string, spec: PlanSpecType): Plan {
    const path = `plan.${name}`;
    let polygon: P2[];
    if ("regular" in spec) {
      if ((spec.radius === undefined) === (spec.apothem === undefined)) throw new BuildError("give radius or apothem", path);
      const radius = spec.radius !== undefined ? this.length(spec.radius, `${path}.radius`) : radiusOfApothem(spec.regular, this.length(spec.apothem!, `${path}.apothem`));
      polygon = regularPolygon(spec.regular, radius, spec.center ? this.p2(spec.center, `${path}.center`) : [0, 0], ((spec.rotation ?? 0) * Math.PI) / 180);
    } else if ("polygon" in spec) {
      polygon = counterClockwise(spec.polygon.map((q, i) => this.p2(q, `${path}.polygon[${i}]`)));
    } else if ("rect" in spec) {
      const [w, d] = [this.length(spec.rect[0], `${path}.rect[0]`) / 2, this.length(spec.rect[1], `${path}.rect[1]`) / 2];
      const [cx, cy] = spec.center ? this.p2(spec.center, `${path}.center`) : [0, 0];
      polygon = [[cx - w, cy - d], [cx + w, cy - d], [cx + w, cy + d], [cx - w, cy + d]];
    } else if ("cross" in spec) {
      const half = this.length(spec.width, `${path}.width`) / 2;
      const arm = (key: keyof typeof spec.cross) => this.optionalLength(spec.cross[key], `${path}.cross.${key}`);
      const arms = { right: arm("right"), rear: arm("rear"), left: arm("left"), front: arm("front") };
      if (Object.values(arms).every((v) => v === undefined)) throw new BuildError("a cross needs at least one arm", path);
      const crossing = this.optionalLength(spec.crossing, `${path}.crossing`);
      polygon = crossPolygon(
        spec.center ? this.p2(spec.center, `${path}.center`) : [0, 0], half, arms, spec.apseSides ?? 0, crossing === undefined ? half : crossing / 2,
      );
    } else if ("ellipse" in spec) {
      polygon = ellipsePolygon(
        spec.sides ?? 48, this.length(spec.ellipse[0], `${path}.ellipse[0]`) / 2, this.length(spec.ellipse[1], `${path}.ellipse[1]`) / 2,
        spec.center ? this.p2(spec.center, `${path}.center`) : [0, 0],
      );
    } else if ("offset" in spec) {
      polygon = offsetPolygon(this.plan(spec.offset, `${path}.offset`).polygon, this.length(spec.by, `${path}.by`));
    } else if ("union" in spec) {
      polygon = unionOutline(spec.union.map((n) => this.plan(n, `${path}.union`).polygon));
    } else if ("apse" in spec) {
      // A half polygon on the outside of a side: the side is its diameter, the corners on the half circle.
      const s = this.sideOf(spec.apse[0], spec.apse[1], `${path}.apse`);
      const m = scale(add(s.a, s.b), 0.5);
      const r = s.length / 2;
      const u = scale(s.along, -1);
      const out = scale(s.inward, -1);
      const n = spec.segments;
      polygon = counterClockwise(Array.from({ length: n + 1 }, (_, k): P2 => {
        const t = (Math.PI * k) / n;
        const q = add(m, add(scale(u, r * Math.cos(t)), scale(out, r * Math.sin(t))));
        return [q[0], q[1]];
      }));
    } else if ("beside" in spec) {
      const original = this.plan(spec.beside, `${path}.beside`).polygon;
      const angle = (spec.direction * Math.PI) / 180;
      const dir: P2 = [Math.cos(angle), Math.sin(angle)];
      const reach = original.map(([x, y]) => x * dir[0] + y * dir[1]);
      const move = Math.max(...reach) - Math.min(...reach) + (this.optionalLength(spec.gap, `${path}.gap`) ?? 0);
      polygon = original.map(([x, y]) => [x + dir[0] * move, y + dir[1] * move]);
    } else {
      const hull = convexHull(spec.hull.flatMap((n) => this.plan(n, `${path}.hull`).polygon));
      polygon = spec.margin === undefined ? hull : offsetPolygon(hull, this.length(spec.margin, `${path}.margin`));
    }
    return { name, polygon, sides: sidesOf(polygon), centroid: centroid(polygon) };
  }

  plan(name: string, path: string): Plan {
    const plan = this.plans.get(name);
    if (!plan) throw new BuildError(`unknown plan outline "${name}"`, path);
    return plan;
  }

  /** Registers an outline an operation derived, for the ones after it. */
  addPlan(name: string, polygon: readonly P2[], path: string): Plan {
    if (this.plans.has(name)) throw new BuildError(`plan outline "${name}" already exists`, path);
    const ccw = counterClockwise(polygon);
    const plan = { name, polygon: ccw, sides: sidesOf(ccw), centroid: centroid(ccw) };
    this.plans.set(name, plan);
    return plan;
  }

  private sideOf(plan: string, index: number, path: string): Side {
    const sides = this.plan(plan, path).sides;
    const side = sides[((index % sides.length) + sides.length) % sides.length];
    return side;
  }

  // ---- points and planes -----------------------------------------------------------------------

  point(spec: PointSpecType, path: string): Vec3 {
    if (Array.isArray(spec)) return this.vec3(spec as readonly [LengthSpec, LengthSpec, LengthSpec], path);
    const z = (d: number, s: LengthSpec | undefined) => (s === undefined ? d : this.length(s, `${path}.z`));
    if ("corner" in spec) {
      const polygon = this.plan(spec.corner[0], `${path}.corner`).polygon;
      const q = polygon[((spec.corner[1] % polygon.length) + polygon.length) % polygon.length];
      return at(q, z(0, spec.z));
    }
    if ("side" in spec) {
      const s = this.sideOf(spec.side[0], spec.side[1], `${path}.side`);
      const along = spec.at === undefined ? s.length / 2 : this.length(spec.at, `${path}.at`);
      const inward = this.optionalLength(spec.inward, `${path}.inward`) ?? 0;
      const q = add(add(s.a, scale(s.along, along)), scale(s.inward, inward));
      return [q[0], q[1], z(0, spec.z)];
    }
    const c = this.column(spec.column[0], spec.column[1], `${path}.column`);
    return [c.at[0], c.at[1], z(c.at[2], spec.z)];
  }

  /** Planes of a cut specification (one, or all the sides of an outline). */
  planes(spec: CutSpecType, path: string): CutPlane[] {
    if ("point" in spec) return [{ point: this.point(spec.point, `${path}.point`), normal: this.vec3(spec.normal, `${path}.normal`) }];
    const inset = this.optionalLength(spec.inset, `${path}.inset`) ?? 0;
    const moved = (c: CutPlane): CutPlane => ({ point: add(c.point, scale(c.normal, inset)), normal: c.normal });
    if ("side" in spec) {
      const s = this.sideOf(spec.plan, spec.side, `${path}.plan`);
      const plane = spec.end === undefined ? { point: s.a, normal: s.inward } : s.corners[spec.end];
      return [moved(spec.outside ? { point: plane.point, normal: scale(plane.normal, -1) } : plane)];
    }
    return this.plan(spec.plan, `${path}.plan`).sides.map((s) => moved({ point: s.a, normal: s.inward }));
  }

  cuts(specs: readonly CutSpecType[] | undefined, path: string): CutPlane[] {
    return (specs ?? []).flatMap((c, i) => this.planes(c, `${path}[${i}]`));
  }

  /** Openings: each a convex hole given by a plan name, a list of planes with normals pointing in, or an arch on a side. */
  openings(specs: readonly OpeningSpecType[] | undefined, path: string): CutPlane[][] {
    return (specs ?? []).map((o, i) => {
      const p = `${path}[${i}]`;
      if (typeof o === "string") return this.planes({ plan: o }, p);
      if (Array.isArray(o)) return this.cuts(o, p);
      const s = this.sideOf(o.arch.side[0], o.arch.side[1], `${p}.arch.side`);
      const along = this.optionalLength(o.arch.at, `${p}.arch.at`) ?? s.length / 2;
      const spring = this.length(o.arch.spring, `${p}.arch.spring`);
      const radius = this.length(o.arch.radius, `${p}.arch.radius`);
      const facets = o.arch.facets ?? 16;
      const centre: Vec3 = [s.a[0] + s.along[0] * along, s.a[1] + s.along[1] * along, spring];
      return Array.from({ length: facets }, (_, j): CutPlane => {
        const angle = (Math.PI * (j + 0.5)) / facets;
        const radial = add(scale(s.along, Math.cos(angle) * radius), [0, 0, Math.sin(angle) * radius]);
        return { point: add(centre, radial), normal: scale(radial, -1) };
      });
    });
  }

  // ---- results ---------------------------------------------------------------------------------

  put(name: string, result: BuildResult, path: string): void {
    if (this.results.has(name)) throw new BuildError(`result "${name}" already exists`, path);
    this.results.set(name, result);
  }

  get<K extends BuildResult["kind"]>(name: string, kind: K, path: string): Extract<BuildResult, { kind: K }> {
    const found = this.results.get(name);
    if (!found) throw new BuildError(`unknown result "${name}"`, path);
    if (found.kind !== kind) throw new BuildError(`"${name}" is a ${found.kind} result, not ${kind}`, path);
    return found as Extract<BuildResult, { kind: K }>;
  }

  /** A height field, or a level: both say how high the structure is over a point. */
  height(spec: LengthSpec | { readonly on: string; readonly offset?: LengthSpec }, path: string): (q: Vec3) => number {
    if (typeof spec === "number" || typeof spec === "string") {
      const h = this.length(spec, path);
      return () => h;
    }
    const field = this.get(spec.on, "height", `${path}.on`).field;
    const offset = this.optionalLength(spec.offset, `${path}.offset`) ?? 0;
    return (q) => field.heightAt(q) + offset;
  }

  /**
   * Bay lines of a bays result on side k of a plan with the same sides in the same order (the
   * outline the bays were set on, or one moved in or out of it), as distances from the side's
   * start: carried across as lines, or kept as equal shares of the side.
   */
  bayStations(result: string, plan: Plan, k: number, path: string): number[] {
    const bays = this.get(result, "bays", path);
    if (bays.sides.length !== plan.sides.length) {
      throw new BuildError(`"${result}" has ${bays.sides.length} sides, plan "${plan.name}" ${plan.sides.length}`, path);
    }
    const s = plan.sides[k];
    const r = bays.sides[k];
    if (r.even) return r.shares.map((t) => t * s.length);
    if (Math.abs(dot(r.along, s.along)) < 1 - 1e-6) throw new BuildError(`side ${k} of "${plan.name}" is not parallel to side ${k} of "${result}"`, path);
    const shift = dot(sub(r.a, s.a), s.along);
    const sign = dot(r.along, s.along) > 0 ? 1 : -1;
    return r.shares.map((t) => shift + sign * t * r.length).filter((u) => u > bays.margin && u < s.length - bays.margin);
  }

  column(result: string, index: number, path: string): PlacedColumn {
    const columns = this.get(result, "columns", path).columns;
    const c = columns[((index % columns.length) + columns.length) % columns.length];
    if (!c) throw new BuildError(`"${result}" has no columns`, path);
    return c;
  }

  // ---- output ----------------------------------------------------------------------------------

  /** Unique element id: the name as given, or with a running number when taken. */
  id(name: string): string {
    let id = name;
    for (let n = 2; this.ids.has(id); n++) id = `${name}_${n}`;
    this.ids.add(id);
    return id;
  }

  addElement(el: Element): Element {
    const placed = { ...el, id: this.id(el.id) };
    this.elements.push(placed);
    return placed;
  }

  addInstance(instance: Instance): void {
    this.instances.push(instance);
  }

  /** The finished model: instances assembled, duplicates of shared members removed. */
  model(): Model {
    const model = removeDuplicateMembers({ elements: [...assemble(this.instances).elements, ...this.elements] });
    const finish = this.finish;
    if (!finish) return model;
    // The document's finish for every member without one of its own.
    return {
      ...model,
      elements: model.elements.map((el) => (el.kind === "plate" || el.metallic !== undefined || el.roughness !== undefined ? el : { ...el, ...finish })),
    };
  }
}
