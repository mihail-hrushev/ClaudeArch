import { type ArchRef, type Element, type Model, isMember } from "../fem/types";
import { horizontalCourses, rectangularTiles } from "../fem/surfaces";
import { intersectPlanLines } from "../fem/discretize";
import type { Profile } from "../fem/profiles";
import { type Vec3, add, sub, scale, cross, normalize, WORLD_X, WORLD_Y, WORLD_Z } from "../fem/vec";

export interface PrismVaultParams {
  /** Bay length along X. */
  readonly length: number;
  /** Width (along Y) of the end at x = −length/2. */
  readonly width1: number;
  /** Width (along Y) of the end at x = +length/2. */
  readonly width2: number;
  /** Rise of the wall arch apexes and the keystone above the springing level. */
  readonly height: number;
  /** Springing level of the ribs (z, default 0) — e.g. the top of the columns. */
  readonly springing?: number;
  /** Vertical columns from z = 0 up to the springing level at the bay outline corners. */
  readonly columns?: ColumnParams;
  /** Glass ceiling on the vault webs (between wall ribs and diagonal ribs). */
  readonly glass?: GlassParams;
  /** Wall rib profile (and diagonal ribs unless `diagonalProfile` is given). */
  readonly profile: Profile;
  /** Profile of the diagonal ribs (default: `profile`). */
  readonly diagonalProfile?: Profile;
  readonly segmentLength: number;
  /**
   * Rib offset inside the bay outline (default 0 = all ribs spring from the corners).
   * Wall ribs move into planes `offset` inside their walls; at every corner the springing
   * points of the two wall ribs and the diagonal rib are `offset` apart.
   * Use ≥ profile size so ribs don't intersect at the springing.
   */
  readonly offset?: number;
}

export interface ColumnParams {
  readonly profile: Profile;
  /** "inner": narrow end corners (x = +length/2, towards a ring center); "all": every corner. */
  readonly at?: "inner" | "all";
}

export interface GlassParams {
  /** Target tile size: course spacing along the ribs and tile width (default: segmentLength). */
  readonly tileSize?: number;
  /** Joint between flat tiles (default 0.6). */
  readonly tileGap?: number;
  /** Glass pane thickness (default 1). */
  readonly thickness?: number;
  readonly color?: Vec3;
  readonly alpha?: number;
}

const GLASS: Vec3 = [0.6, 0.85, 0.8];
const WALL_RIB: Vec3 = [1, 0.85, 0.1];
const DIAGONAL_RIB: Vec3 = [0.95, 0.45, 0.15];
const COLUMN: Vec3 = [0.75, 0.75, 0.8];
/** Corner indices of the narrow (+X) end. */
const INNER_CORNERS = [1, 2];

/**
 * Gothic rib vault over a trapezoidal (prism) bay, in local coordinates: plan center at
 * the origin, symmetric about local X, ground at z = 0, ribs springing at `springing`.
 * Place it with a LocalFrame.
 *  - Wall ribs: on every side a pointed arch — two circular arcs springing vertically
 *    and meeting at mid-side at `height`.
 *  - Diagonal ribs: springing → keystone (plan center, at `height`), groin ribs: the
 *    intersection of the long-side vault (long wall arch extruded along Y) and the end
 *    vault (end wall arch extruded along X). Seen along Y a diagonal coincides with the
 *    long wall arch, seen along X with the end wall arch. Square bay → elliptic diagonals.
 *  - Glass: rectangular flat panes on the webs, cut only where they meet the ribs.
 * With width1 === width2 this is the rectangular / square vault.
 *
 * Plan at a corner C with offset d (C' = inset corner, d from both walls):
 *   wall rib along edge e:   springs at C' + d·e
 *   wall rib along edge f:   springs at C' + d·f
 *   diagonal rib:            springs where the two wall-rib planes' extrusions cross
 */
export function prismVault(p: PrismVaultParams): Model {
  const d = p.offset ?? 0;
  const zs = p.springing ?? 0;
  const apexZ = zs + p.height;
  const hl = p.length / 2;
  const a = p.width1 / 2;
  const b = p.width2 / 2;
  // Counter-clockwise: long side at −Y (edge 0), narrow end, long side at +Y (edge 2), wide end.
  const corners: Vec3[] = [
    [-hl, -a, zs],
    [hl, -b, zs],
    [hl, b, zs],
    [-hl, a, zs],
  ];
  const n = corners.length;
  const edgeDir = corners.map((c, i) => normalize(sub(corners[(i + 1) % n], c)));
  const inward = edgeDir.map((e) => cross(WORLD_Z, e)); // CCW polygon: left of the edge is inside
  // Inset corner i = intersection of the offset lines of edges i−1 and i.
  const inset = corners.map((c, i) => {
    const prev = (i + n - 1) % n;
    return intersectLines(add(c, scale(inward[prev], d)), edgeDir[prev], add(c, scale(inward[i], d)), edgeDir[i]);
  });

  // Springing points of the wall rib halves of edge i (at its start / end corner).
  const wallStart = (i: number) => add(inset[i], scale(edgeDir[i], d));
  const wallEnd = (i: number) => sub(inset[(i + 1) % n], scale(edgeDir[i], d));
  const apex = (i: number): Vec3 => {
    const m = scale(add(inset[i], inset[(i + 1) % n]), 0.5);
    return [m[0], m[1], apexZ];
  };
  const keystone: Vec3 = [0, 0, apexZ];

  const elements: Element[] = [];
  const common = { profile: p.profile, segmentLength: p.segmentLength, startTangent: WORLD_Z };

  for (let i = 0; i < n; i++) {
    const top = apex(i);
    elements.push(
      { id: `wall${i}_a`, kind: "arc", start: wallStart(i), end: top, color: WALL_RIB, ...common },
      { id: `wall${i}_b`, kind: "arc", start: wallEnd(i), end: top, color: WALL_RIB, ...common },
    );
  }

  // Diagonal ribs (groin ribs): corner i is shared by a long side (edge 0 / 2) and an end
  // (edge 1 / 3). The rib is the intersection of the long-side vault surface (its wall arch
  // extruded along Y) and the end vault surface (its wall arch extruded along X).
  const wallHalfAt = (edge: number, corner: number): ArchRef => ({
    start: corner === edge ? wallStart(edge) : wallEnd(edge),
    end: apex(edge),
    startTangent: WORLD_Z,
  });
  const longEdgeOf = [0, 0, 2, 2];
  const endEdgeOf = [3, 1, 1, 3];
  for (let i = 0; i < n; i++) {
    const archA = wallHalfAt(longEdgeOf[i], i);
    const archB = wallHalfAt(endEdgeOf[i], i);
    const s = intersectPlanLines(archA.start, WORLD_Y, archB.start, WORLD_X);
    elements.push({
      id: `diag${i}`,
      kind: "groinArc",
      start: [s[0], s[1], zs],
      end: keystone,
      archA,
      dirA: WORLD_Y,
      archB,
      dirB: WORLD_X,
      color: DIAGONAL_RIB,
      profile: p.diagonalProfile ?? p.profile,
      segmentLength: p.segmentLength,
    });
  }

  // Glass webs: each side i has two half-webs, wall rib half ↔ diagonal rib of the same corner,
  // coursed horizontally from the springing up to the ridge (wall apex → keystone).
  // With groin ribs all courses of a web are parallel, so every strip is planar and is cut
  // into rectangular panes (aligned from the keystone); only panes at the ribs are cut.
  // Every pane is a flat plate element.
  if (p.glass) {
    const g = p.glass;
    const tileSize = g.tileSize ?? p.segmentLength;
    const members = new Map(elements.filter(isMember).map((e) => [e.id, e]));
    for (let i = 0; i < n; i++) {
      const halves: [string, string][] = [
        [`wall${i}_a`, `diag${i}`],
        [`wall${i}_b`, `diag${(i + 1) % n}`],
      ];
      halves.forEach(([wall, diag], h) => {
        const courses = horizontalCourses(members.get(wall)!, members.get(diag)!, tileSize);
        for (const t of rectangularTiles(courses, tileSize, g.tileGap ?? 0.6, keystone)) {
          elements.push({
            id: `glass${i}${h === 0 ? "a" : "b"}_${t.row}_${t.col}`,
            kind: "plate",
            corners: t.corners,
            thickness: g.thickness ?? 1,
            color: g.color ?? GLASS,
            alpha: g.alpha ?? 0.3,
          });
        }
      });
    }
  }

  // Columns: ground → springing at the outline corners.
  if (p.columns && zs > 0) {
    const at = p.columns.at === "all" ? [0, 1, 2, 3] : INNER_CORNERS;
    for (const i of at) {
      const c = corners[i];
      elements.push({
        id: `column${i}`,
        kind: "straight",
        start: [c[0], c[1], 0],
        end: c,
        profile: p.columns.profile,
        color: COLUMN,
      });
    }
  }

  return { elements };
}

/** Intersection of two plan lines p + t·u and q + s·v (z ignored, both at the same height). */
function intersectLines(p: Vec3, u: Vec3, q: Vec3, v: Vec3): Vec3 {
  const denom = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(denom) < 1e-12) return p; // parallel edges (degenerate polygon)
  const w = sub(q, p);
  const t = (w[0] * v[1] - w[1] * v[0]) / denom;
  return add(p, scale(u, t));
}
