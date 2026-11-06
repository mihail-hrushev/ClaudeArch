import type { Element } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type Instance, WORLD_FRAME, assemble } from "../fem/placement";
import { type Vec3, add, sub, scale, dot, cross, len, normalize, WORLD_Z } from "../fem/vec";
import { type CutPlane, type GlassSurface, type GlassSurfaceParams, axisOffset, glassSurface } from "./glassSurface";
import { type Handrail, type HandrailParams, handrail } from "./handrail";
import { type Stair, type StairParams, type StairSeat, stair } from "./stair";

/**
 * Definition of one structural surface type. `ribStep` is the target main rib spacing, adjusted
 * so each side divides into equal bays; `profiles.cutRib` is used for corners, hips and tower feet.
 * `padding` is optional; ground walls use it to stand clear of their columns.
 */
export type SurfaceType = Pick<GlassSurfaceParams, "ribStep" | "tile" | "profiles" | "padding">;

/** Definition of the walkway handrails; each section gets its own ends. */
export type HandrailType = Omit<HandrailParams, "base" | "alongX" | "padding" | "railBeamDrop" | "color">;

/** Definition of the stairs; each gets its own position, and the walkway's handrail. */
export type StairType = Omit<StairParams, "path" | "floor" | "height" | "arrival" | "handrail" | "color">;

/** A column, arch or beam of the ambulatory, and what it carries. */
export interface SupportDetail {
  readonly role: "column" | "shaft" | "arch" | "beam" | "groundArch" | "eavesBeam" | "floorArch" | "floorBeam" | "walkArch" | "stairArch";
  readonly element: Element;
  /** Ids of the supports it transmits its load to (columns stand on the ground). */
  readonly supportedBy: readonly string[];
  /** Names of the blocks, or ids of the supports, resting on it. */
  readonly carries: readonly string[];
}

/**
 * Curitiba Botanical Garden style greenhouse built only from glass surfaces: same massing as
 * `curitiba`, three octagonal towers touching corner to corner, wrapped by a lower 10-sided
 * ground floor with a curved hip roof.
 *
 * Every part is a glassSurface with the same tiles: tower walls, domes, ground walls and roof
 * faces. Corners and hips are cuts between neighbouring surfaces, so their main ribs are shared.
 * `surfaces` defines each of the four surface types the same way.
 *
 * Inside, the tower walls stand on the structure below the roof: a column under every corner and
 * between each two columns a round arch, its crown just touching the middle of the wall's foot rib.
 * Every ground wall surface fits exactly between two columns in the wall line, and the roof above
 * it is a surface with the same edges, main ribs and padding. From each ground column a roof beam
 * runs under the roof to a tower column: along the hip where a hip ends on that column, otherwise
 * straight from the nearest wall. An arch below carries each beam, raised until it just touches
 * it. Columns shared by two towers have no beam.
 *
 * Along the ground walls an eaves beam runs under the roof from column to column, carried at mid
 * span by a round arch between the same columns, as under the tower walls. Both stand just behind
 * the wall structure, against the inner face of the columns.
 *
 * The ambulatory carries a walk floor over its inner half. Along each of those column lines a
 * horizontal beam runs from tower column to ground column, and an arch between the same columns
 * meets it from below at mid span, on the centre line of the ambulatory. The deck spans from the
 * tower columns out to that centre line, one surface of ceramic tiles per bay between two floor
 * beams, its main ribs spanning beam to beam under the tiles and a cut rib resting on every
 * beam and edge; a handrail section runs along both edges, their rail beams carrying the deck
 * edges between the floor beams. Between each two tower columns an arch meets the rail beam of
 * the inner edge from below at mid span.
 *
 * A stair inside each side tower follows the octagon, close along three of its sides: lower flight,
 * platform around the corner, upper flight, and a platform around the next corner with a bridge
 * through a gap in the inner handrail. That platform has no posts: towards the gap it rests on the
 * rail beam, which the walk arch carries, and on the tower column at the corner. Two half arches
 * rise from that column to carry its inner side, their crowns ending inside the beams at the bend
 * and at the end of the platform, each with its own shaft. The two stairs are mirrored on both
 * axes, so each is the other turned half way around.
 *
 * Arches do not land on the columns themselves. The tower columns are the main columns carrying
 * the towers; every arch line has its own slender shaft of the arch section touching the column,
 * from the ground to the highest arch on it. Each ground column has one such shaft on its inner
 * side. Arches in the same plane share their shafts.
 *
 * Local coordinates: center tower at the origin, towers along X, front towards −Y, ground at z = 0.
 */
export interface CuritibaV2Params {
  /** One definition per structural surface type. */
  readonly surfaces: {
    readonly towerWall: SurfaceType;
    readonly towerDome: SurfaceType;
    readonly groundWall: SurfaceType;
    /** Main ribs and padding follow the ground wall below. */
    readonly groundRoof: Omit<SurfaceType, "ribStep" | "padding">;
  };
  readonly tower: {
    /** Inradius of the octagon (center → wall). */
    readonly apothem: number;
    readonly wallHeight: number;
    /** Dome rise above the walls. */
    readonly rise: number;
  };
  readonly ground: {
    /** Outer wall distance beyond the tower outline. */
    readonly margin: number;
    readonly wallHeight: number;
    /** Roof slope at the eaves in degrees, flattening to horizontal along the tower axis. */
    readonly roofAngle: number;
  };
  /** Structure of the ambulatory, the space around the towers inside the ground walls. */
  readonly ambulatory: {
    readonly column: Profile;
    /** Local y across the arch, local z along its radius. */
    readonly arch: Profile;
    /** Column in the ground wall line: local y along the wall, local z into the building. */
    readonly wallColumn: Profile;
    /** Beam under the roof along the ground walls, from column to column. */
    readonly eavesBeam: Profile;
    /** Roof beam from a ground column to a tower column: local y across, local z through its depth. */
    readonly roofBeam: Profile;
  };
  readonly walkFloor: {
    /** Walking surface above the ground. */
    readonly height: number;
    /** From the walking surface down to the top of the floor beams: the deck's tiles and ribs fill it. */
    readonly deckThickness: number;
    /** Horizontal beam from a tower column to a ground column. */
    readonly beam: Profile;
    /** The deck: tiles on top, its structure below. Local Z of each bay points at its tower, X across. */
    readonly deck: SurfaceType;
    readonly handrail: HandrailType;
    readonly stair: StairType;
  };
  readonly color?: Vec3;
}

const OCTAGON = 8;
/** How far a tower wall runs down behind the roof. */
const OVERLAP = 10;

type P2 = readonly [number, number];

const at = ([x, y]: P2, z = 0): Vec3 => [x, y, z];

/** Segment length of the arches. */
const ARCH_SEGMENT = 20;
/** The three tower sides each stair follows, last the one it arrives at. */
const STAIR_SIDES: readonly (readonly [tower: number, sides: readonly [number, number, number]])[] = [
  [2, [5, 6, 7]],
  [0, [1, 2, 3]],
];
/** Free space between a tower column and the end of a handrail. */
const COLUMN_CLEARANCE = 5;
/** Shorter pieces of a handrail between a column and a gap are left out. */
const SHORTEST_SECTION = 10;
/** Longest straight piece of a roof beam. */
const BEAM_SEGMENT = 25;
/** Points along an arch where it is tested against its beam. */
const ARCH_SAMPLES = 200;

/** One side of a counter-clockwise plan polygon, with the bisector planes at its two corners. */
export interface Side {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly length: number;
  /** Unit vector along the side. */
  readonly along: Vec3;
  /** Horizontal unit normal towards the inside. */
  readonly inward: Vec3;
  readonly corners: readonly CutPlane[];
}

export function sidesOf(polygon: readonly P2[]): Side[] {
  const n = polygon.length;
  const dir = (i: number) => normalize(sub(at(polygon[(i + 1) % n]), at(polygon[i])));
  return polygon.map((p, i) => {
    const a = at(p);
    const b = at(polygon[(i + 1) % n]);
    const along = dir(i);
    return {
      a, b, along, length: len(sub(b, a)), inward: cross(WORLD_Z, along),
      corners: [
        { point: a, normal: normalize(add(dir((i + n - 1) % n), along)) },
        { point: b, normal: scale(normalize(add(along, dir((i + 1) % n))), -1) },
      ],
    };
  });
}

/** Regular octagon around (cx, 0), corners at 0°, 45°, …: one faces the front. */
const octagon = (cx: number, radius: number): P2[] => Array.from({ length: OCTAGON }, (_, i) => {
  const angle = (2 * Math.PI * i) / OCTAGON;
  return [cx + radius * Math.cos(angle), radius * Math.sin(angle)];
});

/** Plan of the ground floor: the outline of the towers moved out by `margin`. */
function groundPlan(apothem: number, radius: number, spacing: number, margin: number): P2[] {
  // Lines as (normal angle, distance from the origin along it), counter-clockwise from the front.
  const offset = apothem + margin;
  const end = (cx: number, angle: number) => ({ angle, distance: offset + cx * Math.cos(angle) });
  const step = (2 * Math.PI) / OCTAGON;
  const lines = [
    { angle: -Math.PI / 2, distance: radius + margin },
    ...[-1.5, -0.5, 0.5, 1.5].map((k) => end(spacing, k * step)),
    { angle: Math.PI / 2, distance: radius + margin },
    ...[2.5, 3.5, 4.5, 5.5].map((k) => end(-spacing, k * step)),
  ];
  return lines.map((l, i) => {
    const m = lines[(i + lines.length - 1) % lines.length];
    const det = Math.cos(m.angle) * Math.sin(l.angle) - Math.sin(m.angle) * Math.cos(l.angle);
    return [
      (m.distance * Math.sin(l.angle) - l.distance * Math.sin(m.angle)) / det,
      (l.distance * Math.cos(m.angle) - m.distance * Math.cos(l.angle)) / det,
    ];
  });
}

/** A column being collected from the corners of the tower walls. */
interface Column {
  readonly id: string;
  /** Height of the foot rib it carries. */
  readonly level: number;
  /** Corner rib positions it stands under; touching towers share a column between theirs. */
  readonly under: Vec3[];
  readonly carries: string[];
}

/** A column in the line of the ground walls, carrying the end of an arch. */
interface WallColumn {
  readonly id: string;
  readonly center: Vec3;
  /** Horizontal direction of its long side, into the building. */
  readonly inward: Vec3;
  readonly carries: readonly string[];
}

/** Slender column of the arch section touching a main column, carrying the arches on one line. */
interface Shaft {
  readonly id: string;
  readonly at: Vec3;
  /** Springing of the highest arch on it. */
  top: number;
  readonly carries: string[];
}

/** Plan position of a column. */
const columnCenter = (c: Column): Vec3 =>
  scale(c.under.reduce((sum, q) => add(sum, q), [0, 0, 0]), 1 / c.under.length);

export function curitibaV2(p: CuritibaV2Params): Instance & {
  readonly blocks: readonly GlassSurface[];
  readonly supports: readonly SupportDetail[];
  readonly handrails: readonly Handrail[];
  readonly stairs: readonly Stair[];
} {
  const { tower, ground } = p;
  const radius = tower.apothem / Math.cos(Math.PI / OCTAGON);
  const spacing = 2 * radius;
  const towerPlans = [-spacing, 0, spacing].map((cx) => octagon(cx, radius));
  const plan = sidesOf(groundPlan(tower.apothem, radius, spacing, ground.margin));
  const blocks: GlassSurface[] = [];

  const colors = p.color ? { ribColor: p.color, frameColor: p.color } : {};
  /** Block parameters of a surface type on a side of the given length. */
  const define = (type: SurfaceType, length: number) => ({
    ...colors, ...type, ribStep: length / Math.max(1, Math.round(length / type.ribStep)),
  });

  // Roof section, the same on all faces: an arc rising from the eaves, level at `crown`.
  const crown = radius + ground.margin;
  const slope = (ground.roofAngle * Math.PI) / 180;
  const roofRise = crown * Math.tan(slope / 2);
  const roofRadius = crown / Math.sin(slope);
  /** Height of the roof at a plan point: its section at the distance from the nearest eaves. */
  const roofHeight = (q: Vec3) => {
    const d = Math.min(crown, ...plan.map((s) => dot(sub(q, s.a), s.inward)));
    return ground.wallHeight + roofRise - roofRadius + Math.sqrt(roofRadius ** 2 - (crown - d) ** 2);
  };

  // Foot rib of the tower walls: how far behind the glass it runs and how far below its axis it reaches.
  const footRib = p.surfaces.towerWall.profiles.cutRib ?? p.surfaces.towerWall.profiles.mainRib;
  const footDepth = axisOffset(footRib, p.surfaces.towerWall.tile.thickness);
  const footHalf = Math.max(...footRib.outline.map(([y]) => Math.abs(y)));
  const columns = new Map<string, Column>();
  const footBeams: { wall: string; a: Column; b: Column }[] = [];
  const columnAt = (corner: Vec3, level: number, axis: P2, wall: string) => {
    const id = `column_${Math.round(corner[0])}_${Math.round(corner[1])}`;
    const column = columns.get(id) ?? { id, level, under: [], carries: [] };
    columns.set(id, column);
    column.under.push(add(corner, scale(normalize(sub(at(axis), corner)), footDepth)));
    column.carries.push(wall);
    return column;
  };

  // Towers: wall and dome per octagon side.
  towerPlans.forEach((towerPlan, t) => {
    const axis: P2 = [(t - 1) * spacing, 0];
    const sides = sidesOf(towerPlan);
    const roofAt = sides.map((s) => roofHeight(s.a));
    const foot = Math.min(...roofAt) - OVERLAP;
    sides.forEach((s, k) => {
      const name = `tower${t}_side${k}`;
      // The wall stops on the roof: a straight line under the curved roof between its corners.
      const low = add(s.a, [0, 0, roofAt[k] - OVERLAP]);
      const high = add(s.b, [0, 0, roofAt[(k + 1) % OCTAGON] - OVERLAP]);
      const up = cross(s.inward, sub(high, low));
      footBeams.push({
        wall: `${name}_wall`,
        a: columnAt(s.a, low[2], axis, `${name}_wall`),
        b: columnAt(s.b, high[2], axis, `${name}_wall`),
      });
      blocks.push(glassSurface(`${name}_wall`, {
        ...define(p.surfaces.towerWall, s.length),
        base: add(s.a, [0, 0, foot]), alongX: add(s.b, [0, 0, foot]), alongZ: add(s.a, [0, 0, tower.wallHeight]),
        cuts: [...s.corners, { point: low, normal: up[2] < 0 ? scale(up, -1) : up }],
      }));
      blocks.push(glassSurface(`${name}_dome`, {
        ...define(p.surfaces.towerDome, s.length),
        base: add(s.a, [0, 0, tower.wallHeight]), alongX: add(s.b, [0, 0, tower.wallHeight]),
        alongZ: at(axis, tower.wallHeight + tower.rise),
        cuts: s.corners,
      }));
    });
  });

  // Beams and arches from the tower columns to columns in the ground walls. These are worked out
  // first, because the walls and roof surfaces fit between the ground columns.
  const groundType = p.surfaces.groundWall;
  const roofType = p.surfaces.groundRoof;
  const archHalf = Math.max(...p.ambulatory.arch.outline.map(([, z]) => Math.abs(z)));
  const wallColumnHalf = Math.max(...p.ambulatory.wallColumn.outline.map(([y]) => Math.abs(y)));
  const wallColumnDepth = Math.max(...p.ambulatory.wallColumn.outline.map(([, z]) => Math.abs(z)));
  const depthOf = (profile: Profile) => Math.max(...profile.outline.map(([, z]) => Math.abs(z)));
  const ribReach = (rib: Profile, type: { readonly tile: SurfaceType["tile"] }) => axisOffset(rib, type.tile.thickness) + depthOf(rib);
  const wallReach = Math.max(
    ribReach(groundType.profiles.mainRib, groundType),
    ribReach(groundType.profiles.cutRib ?? groundType.profiles.mainRib, groundType),
  );
  // A ground column stands far enough in for the shaft behind it to clear the wall ribs.
  const wallColumnInset = Math.max(wallColumnDepth, wallReach - wallColumnDepth);
  const planName = (k: number) => `ground_side${(k + plan.length) % plan.length}`;
  const distance = (a: Vec3, b: Vec3) => len(sub(a, b));
  const freeColumns = [...columns.values()].filter((c) => c.under.length <= 2);

  const hipColumns = plan.map((s) =>
    freeColumns.reduce((best, c) => (distance(columnCenter(c), s.a) < distance(columnCenter(best), s.a) ? c : best)));
  const landings = plan.map((): { u: number; column: Column }[] => []);
  for (const column of freeColumns.filter((c) => !hipColumns.includes(c))) {
    const center = columnCenter(column);
    const away = plan.map((s) => dot(sub(center, s.a), s.inward));
    const k = away.indexOf(Math.min(...away));
    landings[k].push({ u: dot(sub(center, plan[k].a), plan[k].along), column });
  }
  landings.forEach((l) => l.sort((a, b) => a.u - b.u));

  /** Column in the wall line, turned along `inward`, between the two wall surfaces beside it. */
  const wallColumnAt = (id: string, onWall: Vec3, inward: Vec3, along: Vec3, carries: string[]): WallColumn => ({
    id, carries, inward,
    center: add(onWall, scale(inward, wallColumnInset + wallColumnHalf / Math.tan(Math.acos(dot(along, inward))))),
  });
  const roofArches: { column: Column; wall: WallColumn; roofs: string[] }[] = [];
  plan.forEach((s, k) => {
    const before = (k + plan.length - 1) % plan.length;
    const inward = normalize(add(plan[before].inward, s.inward));
    roofArches.push({
      column: hipColumns[k], roofs: [`${planName(before)}_roof${landings[before].length}`, `${planName(k)}_roof0`],
      wall: wallColumnAt(`wall_column_${k}`, s.a, inward, s.along, [
        `${planName(before)}_wall${landings[before].length}`, `${planName(k)}_wall0`,
      ]),
    });
    landings[k].forEach(({ u, column }, j) => roofArches.push({
      column, roofs: [`${planName(k)}_roof${j}`, `${planName(k)}_roof${j + 1}`],
      wall: wallColumnAt(`wall_column_${k}_${j}`, add(s.a, scale(s.along, u)), s.inward, s.along, [
        `${planName(k)}_wall${j}`, `${planName(k)}_wall${j + 1}`,
      ]),
    }));
  });

  // Ground floor: a wall and a roof surface between each two columns; the towers rise through the roof.
  const towerVoids = towerPlans.map((towerPlan) => sidesOf(towerPlan).map((s): CutPlane => ({ point: s.a, normal: s.inward })));
  plan.forEach((s, k) => {
    const name = `ground_side${k}`;
    const marks = landings[k].map((l) => l.u);
    // At the corners a bay stops on the side of the column, the same way for wall and roof.
    const columnSide = (c: CutPlane): CutPlane => ({ point: add(c.point, scale(c.normal, wallColumnHalf)), normal: c.normal });
    for (let j = 0; j <= marks.length; j++) {
      const from = j > 0 ? marks[j - 1] + wallColumnHalf : 0;
      const to = j < marks.length ? marks[j] - wallColumnHalf : s.length;
      const base = add(s.a, scale(s.along, from));
      const end = add(s.a, scale(s.along, to));
      const bay = define(groundType, to - from);
      const cuts = [...(j === 0 ? [columnSide(s.corners[0])] : []), ...(j === marks.length ? [columnSide(s.corners[1])] : [])];
      blocks.push(glassSurface(`${name}_wall${j}`, {
        ...bay, cuts, base, alongX: end, alongZ: add(base, [0, 0, ground.wallHeight]),
      }));
      const eaves = add(base, [0, 0, ground.wallHeight]);
      blocks.push(glassSurface(`${name}_roof${j}`, {
        ...bay, ...roofType, cuts, openings: towerVoids,
        base: eaves, alongX: add(end, [0, 0, ground.wallHeight]),
        alongZ: add(add(eaves, scale(s.inward, crown)), [0, 0, roofRise]),
        tangent: [0, Math.cos(slope), Math.sin(slope)],
      }));
    }
  });

  // Interior: columns up to the foot ribs, and an arch under the middle of every foot rib.
  const supportColor = p.color ? { color: p.color } : {};
  const columnDetails = [...columns.values()].map((c): SupportDetail => {
    const base = columnCenter(c);
    return {
      role: "column", supportedBy: [], carries: [...new Set(c.carries)],
      element: {
        id: c.id, kind: "straight", start: base, end: add(base, [0, 0, c.level + footHalf]),
        profile: p.ambulatory.column, ...supportColor,
      },
    };
  });
  // Shafts: one per arch line at a tower column, one per ground column.
  const shafts = new Map<string, Shaft>();
  const shaft = (id: string, at: Vec3) => {
    const found = shafts.get(id) ?? { id, at, top: 0, carries: [] };
    shafts.set(id, found);
    return found;
  };
  const towerColumnRadius = Math.max(...p.ambulatory.column.outline.map(([y]) => Math.abs(y)));
  const towerShaft = (column: Column, towards: Vec3) => {
    const center = columnCenter(column);
    const direction = normalize(sub(towards, center));
    const angle = Math.round((Math.atan2(direction[1], direction[0]) * 180) / Math.PI);
    return shaft(`shaft_${column.id}_${angle}`, add(center, scale(direction, towerColumnRadius + archHalf)));
  };
  const wallShaft = (wall: WallColumn) =>
    shaft(`shaft_${wall.id}`, add(wall.center, scale(wall.inward, wallColumnDepth + archHalf)));
  /** A semicircular arch from shaft to shaft, springing at `spring`. */
  const archBetween = (id: string, role: SupportDetail["role"], a: Shaft, b: Shaft, spring: number, carries: readonly string[]): SupportDetail => {
    for (const end of [a, b]) {
      end.top = Math.max(end.top, spring);
      end.carries.push(id);
    }
    return {
      role, supportedBy: [a.id, b.id], carries,
      element: {
        id, kind: "arc", start: add(a.at, [0, 0, spring]), end: add(b.at, [0, 0, spring]),
        startTangent: WORLD_Z, segmentLength: ARCH_SEGMENT, profile: p.ambulatory.arch, ...supportColor,
      },
    };
  };

  /** Half of a semicircular arch, from a shaft at the column up to its crown at the seat. */
  const halfArch = (seat: StairSeat, column: Column): SupportDetail => {
    const from = towerShaft(column, at([seat.at[0], seat.at[1]]));
    const spring = seat.at[2] - len(sub(at([seat.at[0], seat.at[1]]), from.at));
    from.top = Math.max(from.top, spring);
    from.carries.push(seat.id);
    return {
      role: "stairArch", supportedBy: [from.id], carries: seat.carries,
      element: {
        id: seat.id, kind: "arc", start: add(from.at, [0, 0, spring]), end: seat.at,
        startTangent: WORLD_Z, segmentLength: ARCH_SEGMENT, profile: p.ambulatory.arch, ...supportColor,
      },
    };
  };

  const archDetails = footBeams.map(({ wall, a, b }): SupportDetail => {
    const [towardsB, towardsA] = [towerShaft(a, columnCenter(b)), towerShaft(b, columnCenter(a))];
    const run = len(sub(columnCenter(b), columnCenter(a)));
    // The foot rib rises from a to b: its underside at mid span, measured vertically.
    const underside = (a.level + b.level) / 2 - footHalf * Math.hypot(1, (b.level - a.level) / run);
    const spring = underside - archHalf - len(sub(towardsA.at, towardsB.at)) / 2;
    return archBetween(`arch_${wall}`, "arch", towardsB, towardsA, spring, [wall]);
  });
  const wallColumnDetails = roofArches.map(({ wall }): SupportDetail => ({
    role: "column", supportedBy: [], carries: wall.carries,
    element: {
      id: wall.id, kind: "straight", start: wall.center, end: add(wall.center, [0, 0, ground.wallHeight]),
      profile: p.ambulatory.wallColumn, up: wall.inward, ...supportColor,
    },
  }));
  const beamHalf = Math.max(...p.ambulatory.roofBeam.outline.map(([, z]) => Math.abs(z)));
  const beamDetails: SupportDetail[] = [];
  const wallArchDetails = roofArches.map(({ column, wall, roofs }): SupportDetail => {
    const start = columnCenter(column);
    const wallEnd = wall.center;
    const span = len(sub(wallEnd, start));
    const onPlan = (h: number) => add(start, scale(sub(wallEnd, start), h / span));
    /** Vertical length of a distance measured square to the roof, along the beam. */
    const square = (h: number, distance: number) =>
      distance * Math.hypot(1, (roofHeight(onPlan(h + 1)) - roofHeight(onPlan(h - 1))) / 2);

    // The beam: its top on the roof surface, all the way from the tower column to the wall column.
    const pieces = Math.ceil(span / BEAM_SEGMENT);
    const nodes = Array.from({ length: pieces + 1 }, (_, i) => {
      const h = (span * i) / pieces;
      return add(onPlan(h), [0, 0, roofHeight(onPlan(h)) - square(h, beamHalf)]);
    });
    const beamId = `beam_${column.id}`;
    const archId = `arch_${column.id}`;
    beamDetails.push({
      role: "beam", supportedBy: [archId, column.id, wall.id], carries: roofs,
      element: {
        id: beamId, kind: "polyline", nodes, start: nodes[0], end: nodes[pieces],
        profile: p.ambulatory.roofBeam, up: [0, 0, -1], ...supportColor,
      },
    });

    // The arch: a semicircle raised until its back first meets the beam, wherever along the slope.
    const [inner, outerShaft] = [towerShaft(column, wallEnd), wallShaft(wall)];
    const arch = len(sub(outerShaft.at, inner.at));
    const fromStart = dot(sub(inner.at, start), sub(wallEnd, start)) / span;
    const outer = arch / 2 + archHalf;
    const spring = Math.min(...Array.from({ length: ARCH_SAMPLES + 1 }, (_, i) => {
      const along = (arch * i) / ARCH_SAMPLES;
      const h = fromStart + along;
      return roofHeight(onPlan(h)) - square(h, 2 * beamHalf) - Math.sqrt(outer ** 2 - (along - arch / 2) ** 2);
    }));
    return archBetween(archId, "arch", inner, outerShaft, spring, [beamId]);
  });
  // Ground arches: between the shafts of each two ground columns, behind the ribs of the wall.
  const eavesHalf = depthOf(p.ambulatory.eavesBeam);
  const wallColumnById = new Map(roofArches.map(({ wall }) => [wall.id, wall]));
  const groundDetails = plan.flatMap((s, k): SupportDetail[] => {
    const ids = [
      `wall_column_${k}`, ...landings[k].map((_, j) => `wall_column_${k}_${j}`), `wall_column_${(k + 1) % plan.length}`,
    ];
    const shaftOf = (id: string) => wallShaft(wallColumnById.get(id)!);
    return ids.slice(1).flatMap((id, j): SupportDetail[] => {
      const [from, to] = [shaftOf(ids[j]), shaftOf(id)];
      const [start, end] = [from.at, to.at];
      const middle = scale(add(start, end), 0.5);
      // The beam stays under the roof ribs, the arch rises to the middle of its underside.
      const slopeUp = roofHeight(add(middle, s.inward)) - roofHeight(middle);
      const top = Math.min(ground.wallHeight, roofHeight(middle) - ribReach(roofType.profiles.mainRib, roofType) * Math.hypot(1, slopeUp));
      const spring = top - 2 * eavesHalf - archHalf - len(sub(end, start)) / 2;
      const beam = `eaves_beam_${k}_${j}`;
      const arch = `ground_arch_${k}_${j}`;
      return [
        {
          role: "eavesBeam", supportedBy: [arch, ids[j], id], carries: [`${planName(k)}_wall${j}`, `${planName(k)}_roof${j}`],
          element: {
            id: beam, kind: "straight", start: add(start, [0, 0, top - eavesHalf]), end: add(end, [0, 0, top - eavesHalf]),
            profile: p.ambulatory.eavesBeam, ...supportColor,
          },
        },
        archBetween(arch, "groundArch", from, to, spring, [beam]),
      ];
    });
  });

  // Walk floor: a beam and an arch along every column line, in the same plane as the roof arch.
  const walk = p.walkFloor;
  const floorHalf = Math.max(...walk.beam.outline.map(([, z]) => Math.abs(z)));
  const underDeck = walk.height - walk.deckThickness;
  const lines = roofArches.map(({ column, wall }) => {
    const inner = columnCenter(column);
    return { column, wall, inner, middle: scale(add(inner, wall.center), 0.5), beam: `floor_beam_${column.id}` };
  });
  const deckName = (i: number) => `walk_deck${(i + lines.length) % lines.length}`;
  const floorDetails = lines.flatMap(({ column, wall, inner, beam }, i): SupportDetail[] => {
    const arch = `floor_arch_${column.id}`;
    const [fromTower, fromWall] = [towerShaft(column, wall.center), wallShaft(wall)];
    const spring = underDeck - 2 * floorHalf - archHalf - len(sub(fromWall.at, fromTower.at)) / 2;
    return [
      {
        role: "floorBeam", supportedBy: [arch, column.id, wall.id], carries: [deckName(i - 1), deckName(i)],
        element: {
          id: beam, kind: "straight", start: add(inner, [0, 0, underDeck - floorHalf]), end: add(wall.center, [0, 0, underDeck - floorHalf]),
          profile: walk.beam, ...supportColor,
        },
      },
      archBetween(arch, "floorArch", fromTower, fromWall, spring, [beam]),
    ];
  });

  // Walkway: one deck bay between each two neighbouring beams, around the towers. Its inner edge
  // follows the tower columns, through the column where two towers touch. Each bay is a tiled
  // surface facing up, cut to the bay outline, its tile grid centred on the bay and turned to its
  // section: local Z from the middle of the bay towards the centre of its tower, X across.
  const columnClear = towerColumnRadius + 2 * archHalf + COLUMN_CLEARANCE;
  const joined = (a: Column, b: Column) => footBeams.some((f) => (f.a === a && f.b === b) || (f.a === b && f.b === a));
  const onWalk = (q: Vec3): Vec3 => [q[0], q[1], walk.height];
  const handrails: Handrail[] = [];
  const walkArchDetails: SupportDetail[] = [];
  const stairArchDetails: SupportDetail[] = [];
  const stairs: Stair[] = [];
  const { railBeam: _railBeam, ...stairRailProfiles } = walk.handrail.profiles;

  // Stairs: their centre line runs inside the tower, parallel to the line of its columns.
  const stairReach = towerColumnRadius + COLUMN_CLEARANCE;
  const stairInset = walk.stair.width / 2 + stairReach;
  const crossing = (a: { at: Vec3; along: Vec3 }, b: { at: Vec3; along: Vec3 }): Vec3 => {
    const d = sub(b.at, a.at);
    const t = (d[0] * b.along[1] - d[1] * b.along[0]) / (a.along[0] * b.along[1] - a.along[1] * b.along[0]);
    return add(a.at, scale(a.along, t));
  };
  // Each is built at its gap below, once the rail beam carrying its cantilever is known.
  const stairGaps = new Map<string, { middle: Vec3; column: Column; build: (carriedBy: readonly string[]) => Stair }>();
  for (const [tower, sides] of STAIR_SIDES) {
    const plan3 = sidesOf(towerPlans[tower]);
    const [first, second, third] = sides.map((k) => {
      const beam = footBeams.find((f) => f.wall === `tower${tower}_side${k}_wall`)!;
      return { at: add(columnCenter(beam.a), scale(plan3[k].inward, stairInset)), along: plan3[k].along, inward: plan3[k].inward, wall: beam.wall, beam };
    });
    const flight = (walk.height / walk.stair.riser / 2 - 1) * walk.stair.tread;
    const toCorner = flight + walk.stair.platform.length / 2;
    const [cornerA, cornerB] = [crossing(first, second), crossing(second, third)];
    const onThird = add(cornerB, scale(third.along, walk.stair.width));
    const column = [third.beam.a, third.beam.b].find((c) => c === second.beam.a || c === second.beam.b)!;
    const build = (carriedBy: readonly string[]) => stair(`stair${tower}`, {
      ...walk.stair, ...supportColor, height: walk.height,
      path: [add(cornerA, scale(first.along, -toCorner)), cornerA, cornerB, onThird],
      arrival: {
        length: len(sub(cornerB, cornerA)) - toCorner + walk.stair.width,
        exit: { side: "right", length: walk.stair.width, reach: stairReach, carriedBy, column: { id: column.id, at: columnCenter(column) } },
      },
      handrail: { ...walk.handrail, profiles: stairRailProfiles },
    });
    const middle = add(add(cornerB, scale(third.along, walk.stair.width / 2)), scale(third.inward, -stairInset));
    stairGaps.set(third.wall, { middle, column, build });
  }
  const railBeam = walk.handrail.profiles.railBeam;
  const underEdge = underDeck - (railBeam ? 2 * Math.max(...railBeam.outline.map(([, z]) => Math.abs(z))) : 0);
  const deckMid = walk.height - walk.deck.tile.thickness / 2;
  /** The tower a tower column belongs to (columns on the beam lines are never shared). */
  const towerOf = (c: Column) => Number(/^tower(\d+)/.exec(c.carries[0])![1]);
  const towerCenter = (t: number): Vec3 => [(t - 1) * spacing, 0, deckMid];
  lines.forEach((a, i) => {
    const b = lines[(i + 1) % lines.length];
    const between = joined(a.column, b.column)
      ? []
      : [...columns.values()].filter((c) => c.under.length > 2 && joined(a.column, c) && joined(c, b.column));
    const innerColumns = [b.column, ...between, a.column];
    const innerEdge = innerColumns.map(columnCenter);
    const section = (name: string, from: Vec3, to: Vec3, padding: HandrailParams["padding"]) => handrail(name, {
      ...walk.handrail, ...supportColor, padding, railBeamDrop: walk.deckThickness, base: onWalk(from), alongX: onWalk(to),
    });
    handrails.push(section(`walk_outer${i}`, a.middle, b.middle, 0));
    innerEdge.slice(1).forEach((q, j) => {
      const name = `walk_inner${i}_${j}`;
      const wall = footBeams.find((f) => joined(f.a, f.b) && [f.a, f.b].includes(innerColumns[j]) && [f.a, f.b].includes(innerColumns[j + 1]))?.wall;
      const gap = wall && stairGaps.get(wall);
      if (gap) {
        // A stair arrives here: a gap in the handrail, the rail beam runs through.
        const length = len(sub(innerEdge[j], q));
        const middle = dot(sub(gap.middle, q), normalize(sub(innerEdge[j], q)));
        const [gapStart, gapEnd] = [middle - walk.stair.width / 2, middle + walk.stair.width / 2];
        const parts: HandrailParams["padding"][] = [
          ...(gapStart - columnClear > SHORTEST_SECTION ? [{ left: columnClear, right: length - gapStart }] : []),
          ...(length - gapEnd - columnClear > SHORTEST_SECTION ? [{ left: gapEnd, right: columnClear }] : []),
        ];
        const names = parts.map((_, n) => (n ? `${name}_b` : name));
        parts.forEach((padding, n) => handrails.push(section(names[n], q, innerEdge[j], padding)));
        const built = gap.build(names);
        stairs.push(built);
        stairArchDetails.push(...built.seats.map((seat) => halfArch(seat, gap.column)));
      } else {
        handrails.push(section(name, q, innerEdge[j], columnClear));
      }
      const [first, second] = [towerShaft(innerColumns[j + 1], innerEdge[j]), towerShaft(innerColumns[j], q)];
      const spring = underEdge - archHalf - len(sub(second.at, first.at)) / 2;
      walkArchDetails.push(archBetween(`walk_arch${i}_${j}`, "walkArch", first, second, spring, [name]));
    });
    // The bay outline, counter-clockwise in plan, as cuts of a block covering it. Local Z heads
    // from the middle of the bay to the centre of its tower (between the two where the bay runs
    // from one tower to the next), X = Z × up across the bay; the cuts along the beams give the
    // ribs resting on them.
    const outline = [a.middle, b.middle, ...innerEdge].map((q): Vec3 => [q[0], q[1], deckMid]);
    const origin = scale(add(outline[0], outline[1]), 0.5);
    const towers = [...new Set([towerOf(a.column), towerOf(b.column)])];
    const z = normalize(towers.reduce((sum, t) => add(sum, normalize(sub(towerCenter(t), origin))), [0, 0, 0] as Vec3));
    const x = cross(z, WORLD_Z);
    const xs = outline.map((q) => dot(sub(q, origin), x));
    const zs = outline.map((q) => dot(sub(q, origin), z));
    const corner = (u: number, v: number) => add(add(origin, scale(x, u)), scale(z, v));
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    // Ribs stand on the joints of the centred tile grid, every `ribStep` from its middle.
    blocks.push(glassSurface(deckName(i), {
      ...colors, ...walk.deck, ribsOnGrid: true, facing: WORLD_Z,
      base: corner(x0, z0), alongX: corner(x1, z0), alongZ: corner(x0, z1),
      cuts: outline.map((q, j) => ({ point: q, normal: normalize(cross(WORLD_Z, sub(outline[(j + 1) % outline.length], q))) })),
    }));
  });

  const shaftDetails = [...shafts.values()].map((q): SupportDetail => ({
    role: "shaft", supportedBy: [], carries: q.carries,
    element: { id: q.id, kind: "straight", start: q.at, end: add(q.at, [0, 0, q.top]), profile: p.ambulatory.arch, ...supportColor },
  }));

  const supports = [
    ...columnDetails, ...wallColumnDetails, ...shaftDetails, ...archDetails, ...wallArchDetails, ...beamDetails, ...groundDetails, ...floorDetails, ...walkArchDetails, ...stairArchDetails,
  ];

  return {
    name: "curitiba_v2", frame: WORLD_FRAME, blocks, supports, handrails, stairs,
    model: {
      elements: [
        ...assemble([...blocks, ...handrails, ...stairs, ...stairs.flatMap((q) => q.handrails)]).elements,
        ...supports.map((s) => s.element),
      ],
    },
  };
}
