import type { Element, PlateElement } from "../fem/types";
import { type Profile, rectangleProfile } from "../fem/profiles";
import { type Instance, WORLD_FRAME, assemble } from "../fem/placement";
import { type Vec3, add, sub, scale, dot, len, WORLD_Z } from "../fem/vec";
import { type CutPlane, type GlassSurface, type GlassSurfaceParams, axisOffset, glassSurface } from "./glassSurface";
import { type Handrail, type HandrailParams, handrail } from "./handrail";
import { type Side, sidesOf } from "./curitibaV2";

/** One glazed surface type: its ribs follow the bays of the building, so only tiles and profiles are set. */
export type SurfaceType = Pick<GlassSurfaceParams, "tile" | "profiles">;

/** A classical column: shaft on a base, under a capital wider along the wall than across it. */
export interface ColumnType {
  readonly shaft: Profile;
  readonly base: Profile;
  readonly baseHeight: number;
  /** Local y along the wall, local z into the building. */
  readonly capital: Profile;
  readonly capitalHeight: number;
}

/** A column, beam or arch, and what it transmits its load to. */
export interface PalaceSupport {
  readonly role: "columnBase" | "column" | "capital" | "beam" | "arch";
  readonly element: Element;
  readonly supportedBy: readonly string[];
}

/**
 * Palacio de Cristal style iron and glass pavilion: a Greek cross with its front arm replaced by a
 * stone portico. A high crossing and three arms stand inside a lower aisle running all round them.
 *
 * The whole plan is one outline, moved in for each layer: the same sides, in the same order, for
 * the outer wall, the columns and the nave. Every arm ends in an apse of `apseSides` flat facets,
 * tangent to the arm's width (the sides of a regular polygon parallel to the arm). Roof faces rise
 * from these outlines with one section per layer, measured from the eaves, so neighbouring faces
 * meet exactly on the bisector planes of the plan: hips at the apses, valleys at the inner corners.
 * The barrel vault of an arm and the half dome of its apse are therefore the same kind of surface.
 *
 *   aisle    wall up to `eaves`, curved roof rising to `aisleRoof`, level where it meets the nave
 *   nave     clerestory up to the springing, semicircular barrel vault with its crown at `naveCrown`
 *   drum     square over the crossing up to `drumTop`; the vaults run into it through round openings
 *   dome     cloister vault of four curved faces rising to `domeApex`, cut by the lantern
 *   lantern  pyramid on the dome, up to `lanternTop`
 *
 * Bays are set once, along the nave, and carried out to every other layer, so wall ribs, roof ribs
 * and columns line up. Arcades of round arches stand behind the glass under the eaves and under
 * the clerestory, each with a beam along its crowns.
 *
 * A solid plinth carries the floor, with a ceramic frieze along the foot of the walls and a cornice
 * at the eaves. In front the portico stands on the same level, then a terrace with a balustrade,
 * a wide stair down to the ground, and the lake.
 *
 * Local coordinates: crossing at the origin, side arms along X, rear arm towards +Y, front towards
 * −Y, ground at z = 0. Any consistent length unit works.
 */
export interface CrystalPalaceParams {
  readonly plan: {
    /** Overall length, apse to apse along X. */
    readonly length: number;
    /** Overall depth from the front wall to the rear apse, without the portico. */
    readonly depth: number;
    /** Width of an arm between its outer walls. */
    readonly armWidth: number;
    /** Width of the aisle, from the outer wall to the nave. */
    readonly aisleWidth: number;
    /** Flat facets around each apse. */
    readonly apseSides: number;
    /** Target bay width; each side divides into equal bays. */
    readonly bayStep: number;
  };
  /** Heights above the ground. */
  readonly levels: {
    /** Top of the plinth: the floor. */
    readonly floor: number;
    readonly eaves: number;
    /** Top of the aisle roof, foot of the clerestory. */
    readonly aisleRoof: number;
    readonly naveCrown: number;
    readonly drumTop: number;
    /** Where the four faces of the dome would meet. */
    readonly domeApex: number;
    readonly lanternTop: number;
  };
  readonly lantern: { readonly width: number; readonly color: Vec3 };
  readonly surfaces: {
    readonly wall: SurfaceType;
    readonly aisleRoof: SurfaceType;
    readonly clerestory: SurfaceType;
    readonly vault: SurfaceType;
    readonly drum: SurfaceType;
    readonly dome: SurfaceType;
  };
  readonly structure: {
    readonly wallColumn: ColumnType;
    readonly naveColumn: ColumnType;
    readonly arch: Profile;
    readonly beam: Profile;
  };
  readonly plinth: {
    /** Width of the plinth, centred on the wall line. */
    readonly thickness: number;
    readonly color: Vec3;
    /** Floor slab inside. */
    readonly slab: { readonly thickness: number; readonly color: Vec3 };
    /** Ceramic band on the plinth, at the foot of the glass. */
    readonly frieze: { readonly height: number; readonly thickness: number; readonly color: Vec3 };
    /** Band under the eaves and around the top of the drum. */
    readonly cornice: { readonly height: number; readonly thickness: number; readonly color: Vec3 };
  };
  readonly portico: {
    readonly width: number;
    readonly depth: number;
    /** Columns across the front; a second row stands behind them against the wall. */
    readonly columns: number;
    readonly column: ColumnType;
    /** Clear height from the floor to the entablature. */
    readonly columnHeight: number;
    readonly entablature: number;
    /** How far the cornice on the entablature reaches out. */
    readonly overhang: number;
    readonly cornice: number;
    readonly color: Vec3;
  };
  readonly terrace: {
    readonly width: number;
    readonly depth: number;
    readonly balustrade: Omit<HandrailParams, "base" | "alongX" | "padding" | "railBeamDrop" | "color">;
    readonly color: Vec3;
  };
  readonly stair: {
    readonly width: number;
    readonly riser: number;
    readonly tread: number;
    readonly color: Vec3;
  };
  readonly lake: {
    /** Along X and Y: an ellipse touching the foot of the stair. */
    readonly width: number;
    readonly depth: number;
    readonly level: number;
    readonly color: Vec3;
    readonly alpha: number;
    readonly reflection: number;
  };
  readonly color?: Vec3;
}

type P2 = readonly [number, number];

/** Segment length of the arches. */
const ARCH_SEGMENT = 20;
/** Straight pieces of the round openings in the drum. */
const OPENING_FACETS = 16;
/** Corners of the outline of the lake. */
const LAKE_CORNERS = 48;
/** A bay line closer to a corner than this share of a bay is left out. */
const SHORTEST_BAY = 0.25;

const at = ([x, y]: P2, z = 0): Vec3 => [x, y, z];
const halfDepth = (profile: Profile) => Math.max(...profile.outline.map(([, z]) => Math.abs(z)));
const halfWidth = (profile: Profile) => Math.max(...profile.outline.map(([y]) => Math.abs(y)));
/** How far the structure of a surface reaches behind its glass. */
const reachOf = ({ profiles, tile }: SurfaceType) =>
  Math.max(...[profiles.mainRib, profiles.cutRib ?? profiles.mainRib].map((rib) => axisOffset(rib, tile.thickness) + halfDepth(rib)));

/** Side of an outline: part of an apse, of an arm, or the front of the crossing. */
interface PlanSide extends Side {
  readonly kind: "apse" | "arm" | "crossing";
  /** The end of an arm side that stops at the crossing. */
  readonly crossingEnd?: "a" | "b";
}

interface Outline {
  readonly sides: readonly PlanSide[];
  /** Corners of each apse. */
  readonly apses: readonly (readonly P2[])[];
}

/** Slope at the eaves of an arc: level at its crown, or vertical at the eaves if that would lean out. */
const slopeOf = (run: number, rise: number) => Math.min(Math.PI / 2, 2 * Math.atan2(rise, run));
const tangentOf = (slope: number): Vec3 => [0, Math.cos(slope), Math.sin(slope)];

/** Height of the arc of `slopeOf` at `left` before the end of its run. */
function arcHeight(run: number, rise: number, left: number) {
  const slope = slopeOf(run, rise);
  const radius = Math.hypot(run, rise) / (2 * Math.sin(slope - Math.atan2(rise, run)));
  const [cx, cz] = [radius * Math.sin(slope), -radius * Math.cos(slope)];
  return cz + Math.sqrt(radius ** 2 - (run - left - cx) ** 2);
}

/** Corners of an apse around `center`, heading along `axis`, its sides `apothem` from the centre. */
function apseCorners(center: P2, axis: P2, apothem: number, sides: number): P2[] {
  const turn = Math.PI / (sides + 1);
  const radius = apothem / Math.cos(turn / 2);
  return Array.from({ length: sides + 1 }, (_, i) => {
    const angle = -Math.PI / 2 + turn * (i + 0.5);
    const [u, v] = [radius * Math.cos(angle), radius * Math.sin(angle)];
    return [center[0] + axis[0] * u - axis[1] * v, center[1] + axis[1] * u + axis[0] * v];
  });
}

/**
 * Plan outline at `half` from the arm axes, counter-clockwise from the right apse. The front runs
 * straight across, divided at ±`split`, the corners of the crossing.
 */
function outlineOf(half: number, split: number, centers: { side: number; rear: number }, apseSides: number): Outline {
  const apses = [
    apseCorners([centers.side, 0], [1, 0], half, apseSides),
    apseCorners([0, centers.rear], [0, 1], half, apseSides),
    apseCorners([-centers.side, 0], [-1, 0], half, apseSides),
  ];
  const corners: P2[] = [...apses[0], [half, half], ...apses[1], [-half, half], ...apses[2], [-split, -half], [split, -half]];
  type Kind = Pick<PlanSide, "kind" | "crossingEnd">;
  const apse = (): Kind[] => [...Array.from({ length: apseSides }, (): Kind => ({ kind: "apse" })), { kind: "arm", crossingEnd: "b" }];
  const fromCrossing: Kind = { kind: "arm", crossingEnd: "a" };
  const kinds: Kind[] = [...apse(), fromCrossing, ...apse(), fromCrossing, ...apse(), { kind: "crossing" }, fromCrossing];
  return { apses, sides: sidesOf(corners).map((s, i) => ({ ...s, ...kinds[i] })) };
}

function validate({ plan, levels }: CrystalPalaceParams, half: number, naveHalf: number, centers: { side: number; rear: number }) {
  const heights = [0, levels.floor, levels.eaves, levels.aisleRoof, levels.naveCrown - naveHalf, levels.naveCrown, levels.drumTop, levels.domeApex, levels.lanternTop];
  if (heights.some((h, i) => i > 0 && h <= heights[i - 1])) {
    throw new Error(`crystalPalace: levels must rise; floor, eaves, aisle roof, nave springing, nave crown, drum, dome, lantern are ${heights.slice(1).join(", ")}`);
  }
  if (plan.apseSides < 1 || naveHalf <= 0) throw new Error("crystalPalace: needs an apse side and an aisle narrower than half the arm");
  if (centers.side <= half || centers.rear <= half) throw new Error("crystalPalace: the arms are too short for the arm width and the apses");
}

export function crystalPalace(p: CrystalPalaceParams): Instance & {
  readonly blocks: readonly GlassSurface[];
  readonly supports: readonly PalaceSupport[];
  readonly handrails: readonly Handrail[];
} {
  const { plan, levels, surfaces, structure, plinth, portico, terrace, stair, lake } = p;
  const half = plan.armWidth / 2;
  const naveHalf = half - plan.aisleWidth;
  const naveSpring = levels.naveCrown - naveHalf;

  // The apse reaches furthest with a facet or a corner on its axis, whichever the side count gives.
  const reach = Math.max(...apseCorners([0, 0], [1, 0], half, plan.apseSides).map(([x]) => x));
  const centers = { side: plan.length / 2 - reach, rear: plan.depth - half - reach };
  validate(p, half, naveHalf, centers);

  const wallInset = reachOf(surfaces.wall) + halfWidth(structure.wallColumn.shaft);
  const naveInset = reachOf(surfaces.clerestory) + halfWidth(structure.naveColumn.shaft);
  const outer = outlineOf(half, naveHalf, centers, plan.apseSides);
  const nave = outlineOf(naveHalf, naveHalf, centers, plan.apseSides);
  const wallLine = outlineOf(half - wallInset, naveHalf, centers, plan.apseSides);
  const naveLine = outlineOf(naveHalf - naveInset, naveHalf - naveInset, centers, plan.apseSides);

  // Bays, as shares of each side of the nave. An apse counts them on its wider outer facet.
  const bayShares = nave.sides.map((s, k) => {
    const n = Math.max(1, Math.round((s.kind === "apse" ? outer.sides[k].length : s.length) / plan.bayStep));
    return Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
  });
  /** Bay lines on side k of any outline, as distances from its start. */
  const marksOn = (outline: Outline, k: number) => {
    const s = outline.sides[k];
    const reference = nave.sides[k];
    const margin = SHORTEST_BAY * plan.bayStep;
    if (s.kind === "apse") return bayShares[k].map((t) => t * s.length);
    const shift = dot(sub(reference.a, s.a), s.along);
    return bayShares[k].map((t) => t * reference.length + shift).filter((u) => u > margin && u < s.length - margin);
  };

  const colors = p.color ? { ribColor: p.color, frameColor: p.color } : {};
  const blocks: GlassSurface[] = [];
  type Placement = Pick<GlassSurfaceParams, "base" | "alongX" | "alongZ"> & Partial<GlassSurfaceParams>;
  /** A surface with ribs on the given bay lines; `from` is where the block starts along its side. */
  const surface = (name: string, type: SurfaceType, marks: readonly number[], width: number, placement: Placement, from = 0) => {
    blocks.push(glassSurface(name, {
      ...colors, ...type, ...placement, ribStep: plan.bayStep,
      ribStations: marks.map((u) => u - from).filter((x) => x > 0 && x < width),
    }));
  };
  const lifted = (q: Vec3, z: number) => add(q, [0, 0, z]);
  /** The corners of a side away from the crossing: a vault or clerestory stops square on the crossing. */
  const outerCorners = (s: PlanSide) => s.corners.filter((_, i) => s.crossingEnd !== (i === 0 ? "a" : "b"));

  const wallFoot = levels.floor + plinth.frieze.height;
  outer.sides.forEach((s, k) => {
    const marks = marksOn(outer, k);
    surface(`wall${k}`, surfaces.wall, marks, s.length, {
      base: lifted(s.a, wallFoot), alongX: lifted(s.b, wallFoot), alongZ: lifted(s.a, levels.eaves), cuts: s.corners,
    });

    // The aisle roof widens towards the nave at an inner corner: the block covers both of its edges.
    const inner = nave.sides[k];
    const from = Math.min(0, dot(sub(inner.a, s.a), s.along));
    const to = Math.max(s.length, dot(sub(inner.b, s.a), s.along));
    const eaves = lifted(add(s.a, scale(s.along, from)), levels.eaves);
    const rise = levels.aisleRoof - levels.eaves;
    surface(`aisle_roof${k}`, surfaces.aisleRoof, marks, to - from, {
      base: eaves, alongX: add(eaves, scale(s.along, to - from)),
      alongZ: add(add(eaves, scale(s.inward, plan.aisleWidth)), [0, 0, rise]),
      tangent: tangentOf(slopeOf(plan.aisleWidth, rise)), cuts: s.corners,
    }, from);
  });

  nave.sides.forEach((s, k) => {
    if (s.kind === "crossing") return;
    const marks = marksOn(nave, k);
    const cuts = outerCorners(s);
    surface(`clerestory${k}`, surfaces.clerestory, marks, s.length, {
      base: lifted(s.a, levels.aisleRoof), alongX: lifted(s.b, levels.aisleRoof), alongZ: lifted(s.a, naveSpring), cuts,
    });
    const spring = lifted(s.a, naveSpring);
    surface(`vault${k}`, surfaces.vault, marks, s.length, {
      base: spring, alongX: lifted(s.b, naveSpring),
      alongZ: add(add(spring, scale(s.inward, naveHalf)), [0, 0, naveHalf]), cuts,
    });
  });

  // Drum and dome over the crossing. The front stands on the aisle roof, the three other faces on
  // the springing of the arm they open into, around the vault.
  const crossing = sidesOf([[-naveHalf, -naveHalf], [naveHalf, -naveHalf], [naveHalf, naveHalf], [-naveHalf, naveHalf]]);
  const crossingBays = bayShares[nave.sides.findIndex((q) => q.kind === "crossing")];
  const domeRise = levels.domeApex - levels.drumTop;
  const lanternHalf = p.lantern.width / 2;
  const lanternFoot = levels.drumTop + arcHeight(naveHalf, domeRise, lanternHalf);
  crossing.forEach((s, k) => {
    const open = k > 0;
    const foot = open ? naveSpring : levels.aisleRoof;
    const middle = scale(add(s.a, s.b), 0.5);
    const facets = Array.from({ length: OPENING_FACETS }, (_, i): CutPlane => {
      const angle = (Math.PI * (i + 0.5)) / OPENING_FACETS;
      const radial = add(scale(s.along, Math.cos(angle) * naveHalf), [0, 0, Math.sin(angle) * naveHalf]);
      return { point: add(lifted(middle, naveSpring), radial), normal: scale(radial, -1) };
    });
    surface(`drum${k}`, surfaces.drum, open ? [] : crossingBays.map((t) => t * s.length), s.length, {
      base: lifted(s.a, foot), alongX: lifted(s.b, foot), alongZ: lifted(s.a, levels.drumTop), cuts: s.corners,
      ...(open ? { openings: [facets] } : {}),
    });
    surface(`dome${k}`, surfaces.dome, [], s.length, {
      base: lifted(s.a, levels.drumTop), alongX: lifted(s.b, levels.drumTop), alongZ: [0, 0, levels.domeApex],
      tangent: tangentOf(slopeOf(naveHalf, domeRise)),
      cuts: [...s.corners, { point: [0, 0, lanternFoot], normal: [0, 0, -1] }],
    });
  });

  // Solid parts: blocks and bands along the plan.
  const solids: Element[] = [];
  const box = (id: string, [x0, x1]: P2, [y0, y1]: P2, [z0, z1]: P2, color: Vec3) => solids.push({
    id, kind: "straight", color, profile: rectangleProfile(y1 - y0, z1 - z0),
    start: [x0, (y0 + y1) / 2, (z0 + z1) / 2], end: [x1, (y0 + y1) / 2, (z0 + z1) / 2],
  });
  /** A band along every side of a closed outline, its ends running on to close the corners. */
  const band = (id: string, sides: readonly Side[], thickness: number, [z0, z1]: P2, color: Vec3) => sides.forEach((s, k) => {
    const miter = (other: Side) => (thickness / 2) * Math.tan(Math.acos(Math.min(1, Math.abs(dot(other.along, s.along)))) / 2);
    solids.push({
      id: `${id}${k}`, kind: "straight", color, profile: rectangleProfile(thickness, z1 - z0),
      start: lifted(add(s.a, scale(s.along, -miter(sides[(k + sides.length - 1) % sides.length]))), (z0 + z1) / 2),
      end: lifted(add(s.b, scale(s.along, miter(sides[(k + 1) % sides.length]))), (z0 + z1) / 2),
    });
  });
  band("plinth", outer.sides, plinth.thickness, [0, levels.floor], plinth.color);
  band("frieze", outer.sides, plinth.frieze.thickness, [levels.floor, wallFoot], plinth.frieze.color);
  band("eaves_cornice", outer.sides, plinth.cornice.thickness, [levels.eaves - plinth.cornice.height, levels.eaves], plinth.cornice.color);
  band("drum_cornice", crossing, plinth.cornice.thickness, [levels.drumTop - plinth.cornice.height, levels.drumTop], plinth.cornice.color);

  // Floor: convex plates under the arms and the apses.
  const plates: PlateElement[] = [];
  const plate = (id: string, corners: readonly Vec3[], thickness: number, color: Vec3, more: Partial<PlateElement> = {}) =>
    plates.push({ id, kind: "plate", corners, thickness, color, alpha: 1, ...more });
  const slab = plinth.slab;
  const slabZ = levels.floor - slab.thickness / 2;
  const apseStart = half * Math.tan(Math.PI / (plan.apseSides + 1) / 2);
  const [sideEnd, rearEnd] = [centers.side + apseStart, centers.rear + apseStart];
  plate("floor_arms", [[-sideEnd, -half, slabZ], [sideEnd, -half, slabZ], [sideEnd, half, slabZ], [-sideEnd, half, slabZ]], slab.thickness, slab.color);
  plate("floor_rear", [[-half, half, slabZ], [half, half, slabZ], [half, rearEnd, slabZ], [-half, rearEnd, slabZ]], slab.thickness, slab.color);
  outer.apses.forEach((apse, i) => plate(`floor_apse${i}`, apse.map((q) => at(q, slabZ)), slab.thickness, slab.color));

  // Lantern: a pyramid on the opening the dome leaves.
  sidesOf([[-lanternHalf, -lanternHalf], [lanternHalf, -lanternHalf], [lanternHalf, lanternHalf], [-lanternHalf, lanternHalf]])
    .forEach((s, k) => plate(`lantern${k}`, [lifted(s.a, lanternFoot), lifted(s.b, lanternFoot), [0, 0, levels.lanternTop]], 1, p.lantern.color));

  // Columns behind the glass, one per bay line; those at the crossing corners rise to the drum top.
  const supports: PalaceSupport[] = [];
  const supportColor = p.color ? { color: p.color } : {};
  const column = (id: string, foot: Vec3, top: number, type: ColumnType, inward: Vec3, color: { color?: Vec3 } = supportColor) => {
    const neck: Vec3 = [foot[0], foot[1], top - type.capitalHeight];
    const seat = lifted(foot, type.baseHeight);
    supports.push(
      { role: "columnBase", supportedBy: [], element: { id: `${id}_base`, kind: "straight", profile: type.base, ...color, start: foot, end: seat } },
      { role: "column", supportedBy: [`${id}_base`], element: { id, kind: "straight", profile: type.shaft, ...color, start: seat, end: neck } },
      {
        role: "capital", supportedBy: [id],
        element: { id: `${id}_capital`, kind: "straight", profile: type.capital, up: inward, ...color, start: neck, end: [foot[0], foot[1], top] },
      },
    );
  };
  const pointsOn = (outline: Outline, k: number) => {
    const s = outline.sides[k];
    return [0, ...marksOn(outline, k), s.length].map((u) => add(s.a, scale(s.along, u)));
  };
  /** A column on every bay line of an outline, each once, as high as the tallest `top` asked of it. */
  const columnsOn = (name: string, outline: Outline, type: ColumnType, top: (s: PlanSide, q: Vec3) => number) => {
    const found = new Map<string, { q: Vec3; top: number; inward: Vec3 }>();
    outline.sides.forEach((s, k) => pointsOn(outline, k).forEach((q) => {
      const key = `${Math.round(q[0])}_${Math.round(q[1])}`;
      const height = top(s, q);
      const known = found.get(key);
      if (!known || height > known.top) found.set(key, { q, top: height, inward: s.inward });
    }));
    [...found.values()].forEach((c, i) => column(`${name}${i}`, lifted(c.q, levels.floor), c.top, type, c.inward));
  };
  columnsOn("wall_column", wallLine, structure.wallColumn, () => levels.eaves);
  const inCrossing = naveHalf - naveInset;
  const atCrossing = (q: Vec3) => Math.abs(Math.abs(q[0]) - inCrossing) < 1e-6 && Math.abs(Math.abs(q[1]) - inCrossing) < 1e-6;
  columnsOn("nave_column", naveLine, structure.naveColumn, (s, q) =>
    atCrossing(q) ? levels.drumTop : s.kind === "crossing" ? levels.aisleRoof : naveSpring);

  // Arcades: a beam along the crowns of round arches between each two columns.
  const archHalf = halfDepth(structure.arch);
  const beamHalf = halfDepth(structure.beam);
  const arcade = (name: string, outline: Outline, top: number) => outline.sides.forEach((_, k) => {
    const points = pointsOn(outline, k);
    points.slice(1).forEach((end, j) => {
      const start = points[j];
      const id = `${name}${k}_${j}`;
      const spring = top - 2 * beamHalf - archHalf - len(sub(end, start)) / 2;
      supports.push(
        {
          role: "beam", supportedBy: [`${id}_arch`],
          element: { id: `${id}_beam`, kind: "straight", profile: structure.beam, ...supportColor, start: lifted(start, top - beamHalf), end: lifted(end, top - beamHalf) },
        },
        {
          role: "arch", supportedBy: [],
          element: {
            id: `${id}_arch`, kind: "arc", profile: structure.arch, ...supportColor, startTangent: WORLD_Z, segmentLength: ARCH_SEGMENT,
            start: lifted(start, spring), end: lifted(end, spring),
          },
        },
      );
    });
  });
  arcade("wall_arcade", wallLine, levels.eaves - plinth.cornice.height);
  arcade("nave_arcade", naveLine, levels.aisleRoof);

  // Portico: columns on a stone base under an entablature, in front of the crossing.
  const stone = { color: portico.color };
  const [porticoBack, porticoFront] = [-half, -half - portico.depth];
  const colonnadeHalf = portico.width / 2 - halfWidth(portico.column.capital);
  const entablatureFoot = levels.floor + portico.columnHeight;
  const columnOffset = halfDepth(portico.column.capital);
  Array.from({ length: portico.columns }, (_, i) => -colonnadeHalf + (2 * colonnadeHalf * i) / Math.max(1, portico.columns - 1)).forEach((x, i) => {
    column(`portico_column${i}`, [x, porticoFront + columnOffset, levels.floor], entablatureFoot, portico.column, [0, 1, 0], stone);
    column(`portico_back_column${i}`, [x, porticoBack - columnOffset, levels.floor], entablatureFoot, portico.column, [0, 1, 0], stone);
  });
  const porticoX: P2 = [-portico.width / 2, portico.width / 2];
  const entablatureTop = entablatureFoot + portico.entablature;
  box("portico_base", porticoX, [porticoFront, porticoBack], [0, levels.floor], portico.color);
  box("portico_entablature", porticoX, [porticoFront, porticoBack], [entablatureFoot, entablatureTop], portico.color);
  box(
    "portico_cornice", [porticoX[0] - portico.overhang, porticoX[1] + portico.overhang], [porticoFront - portico.overhang, porticoBack],
    [entablatureTop, entablatureTop + portico.cornice], portico.color,
  );

  // Terrace in front of the portico, then the stair down to the ground.
  const terraceFront = porticoFront - terrace.depth;
  const terraceX: P2 = [-terrace.width / 2, terrace.width / 2];
  box("terrace", terraceX, [terraceFront, porticoFront], [0, levels.floor], terrace.color);
  const steps = Math.max(1, Math.round(levels.floor / stair.riser));
  for (let i = 1; i < steps; i++) {
    const back = terraceFront - (i - 1) * stair.tread;
    box(`stair_step${i}`, [-stair.width / 2, stair.width / 2], [back - stair.tread, back], [0, levels.floor * (1 - i / steps)], stair.color);
  }
  const stairFoot = terraceFront - (steps - 1) * stair.tread;

  // Balustrade along the terrace, open at the stair and at the portico.
  const onTerrace = (x: number, y: number): Vec3 => [x, y, levels.floor];
  const rail = (name: string, base: Vec3, alongX: Vec3) => handrail(name, { ...terrace.balustrade, color: terrace.color, base, alongX });
  const handrails = [
    rail("balustrade_left", onTerrace(terraceX[0], porticoFront), onTerrace(terraceX[0], terraceFront)),
    rail("balustrade_front_left", onTerrace(terraceX[0], terraceFront), onTerrace(-stair.width / 2, terraceFront)),
    rail("balustrade_front_right", onTerrace(stair.width / 2, terraceFront), onTerrace(terraceX[1], terraceFront)),
    rail("balustrade_right", onTerrace(terraceX[1], terraceFront), onTerrace(terraceX[1], porticoFront)),
  ];

  // Lake: an ellipse in front, touching the foot of the stair.
  const lakeY = stairFoot - lake.depth / 2;
  plate("lake", Array.from({ length: LAKE_CORNERS }, (_, i): Vec3 => {
    const angle = (2 * Math.PI * i) / LAKE_CORNERS;
    return [(lake.width / 2) * Math.cos(angle), lakeY + (lake.depth / 2) * Math.sin(angle), lake.level];
  }), 1, lake.color, { alpha: lake.alpha, reflection: lake.reflection });

  return {
    name: "crystal_palace", frame: WORLD_FRAME, blocks, supports, handrails,
    model: {
      elements: [...assemble([...blocks, ...handrails]).elements, ...supports.map((s) => s.element), ...solids, ...plates],
    },
  };
}
