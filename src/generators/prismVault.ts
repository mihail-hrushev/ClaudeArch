import { type ArchRef, type Element, type Model, isMember } from "../fem/types";
import { horizontalCourses, rectangularTiles } from "../fem/surfaces";
import { intersectPlanLines } from "../fem/discretize";
import type { Profile } from "../fem/profiles";
import {
  type P2, type Poly2, area2, arcPoints, ccw, circlePoints, clipConvex, insetConvex, simplify, subtractConvex,
} from "../fem/polygon2";
import { type Vec3, add, sub, scale, cross, normalize, len, WORLD_X, WORLD_Y, WORLD_Z } from "../fem/vec";

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
  /** Gothic tracery window under the external (wide end, x = −length/2) wall rib. */
  readonly window?: WindowParams;
  /** Wall rib profile (and diagonal ribs unless `diagonalProfile` is given). */
  readonly profile: Profile;
  /** Profile of the diagonal ribs (default: `profile`). */
  readonly diagonalProfile?: Profile;
  /**
   * Ridge ribs: horizontal straight ribs at the apex level from every wall arch apex to the
   * keystone (vault center). `true` uses the wall rib profile.
   */
  readonly ridgeRibs?: boolean | { readonly profile?: Profile; readonly color?: Vec3 };
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
  /**
   * "inner": narrow end corners (x = +length/2, towards a ring center);
   * "outer": wide end corners (x = −length/2, the external side); "all": every corner.
   */
  readonly at?: "inner" | "outer" | "all";
  /**
   * Rib shafts (default true): every rib springing at a column corner continues straight
   * down to the column base as a separate vertical element with the rib's profile.
   */
  readonly shafts?: boolean;
}

/**
 * Gothic window in the plane of the external wall rib, which is its main arch:
 * sill, mullions, `lights` pointed lancets side by side (springing at the rib springing
 * level, rise set by `lancetPointedness`) and an oculus circle on the axis whose surface
 * just touches the main arch rib and rests on the lancet arcade (no member overlap).
 * The window has its own border (main arch, jambs, sill) set inside the vault frame:
 * `recess` behind the wall rib (into the bay, under the end web) and `inset` inside its
 * outline (border arch concentric with the wall rib arch, radius smaller by `inset`).
 */
export interface WindowParams {
  /** Tracery profile (lancets, mullions, oculus). */
  readonly profile: Profile;
  /**
   * Border profile: main arch, jambs and sill (default: `profile`). Local y is normal to the
   * window (depth through the wall), local z lies in the window plane.
   */
  readonly frameProfile?: Profile;
  /** Window plane offset from the wall rib into the bay (default: rib + border radius). */
  readonly recess?: number;
  /** Border arch / jambs offset inside the wall rib outline (default: rib + border radius). */
  readonly inset?: number;
  /** Sill level (z, default springing / 3). */
  readonly sill?: number;
  /** Number of lancets (lights) side by side (default 2). */
  readonly lights?: number;
  /**
   * Lancet rise / lancet half width (default: the main arch ratio rise / half span).
   * Larger = more pointed lancets.
   */
  readonly lancetPointedness?: number;
  /**
   * Glass panes in every opening of the window, cut along the tracery axes. Each lancet has
   * its own grid of `lancetGlassColumns` columns with square rows from the sill; the rest of
   * the window a shared grid of `glass.tileSize`.
   */
  readonly glass?: GlassParams;
  /** Glass pane columns per lancet (default 2). */
  readonly lancetGlassColumns?: number;
  /** Rose tracery inside the oculus (omit for a plain circle). */
  readonly rose?: RoseParams;
  readonly color?: Vec3;
}

/**
 * Rose inside the oculus: a hub circle, radial spokes from the hub, and between every two
 * neighbouring spokes a pointed arch springing from the spoke ends (tangent to the spokes)
 * whose tip touches the oculus (member surfaces touch, no overlap).
 */
export interface RoseParams {
  /** Number of spokes = number of arches (default 16). */
  readonly spokes?: number;
  /** Hub circle radius as a fraction of the oculus radius (default 0.2). */
  readonly hub?: number;
  /** Arch rise / half span at the spoke ends (default 1.5; larger = more pointed). */
  readonly pointedness?: number;
  /**
   * Rose member profile (default: the window profile). Local y is normal to the window
   * (depth through the wall), local z lies in the window plane (face width).
   */
  readonly profile?: Profile;
  /** Segment length of the rose arcs (default: vault segmentLength / 3). */
  readonly segmentLength?: number;
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
const RIDGE_RIB: Vec3 = [0.9, 0.3, 0.3];
const COLUMN: Vec3 = [0.75, 0.75, 0.8];
const TRACERY: Vec3 = [0.85, 0.8, 0.7];
/** Corner indices of the narrow (+X) and wide (−X, external) ends. */
const INNER_CORNERS = [1, 2];
const OUTER_CORNERS = [3, 0];
/** External wall: edge 3 (corner 3 → corner 0), the wide end. */
const OUTER_EDGE = 3;

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
      // Both halves end on the arch's mirror plane, so they close at the apex.
      { id: `wall${i}_a`, kind: "arc", start: wallStart(i), end: top, endCut: edgeDir[i], color: WALL_RIB, ...common },
      { id: `wall${i}_b`, kind: "arc", start: wallEnd(i), end: top, endCut: edgeDir[i], color: WALL_RIB, ...common },
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
  const diagSpringing: Vec3[] = [];
  const longEdgeOf = [0, 0, 2, 2];
  const endEdgeOf = [3, 1, 1, 3];
  for (let i = 0; i < n; i++) {
    const archA = wallHalfAt(longEdgeOf[i], i);
    const archB = wallHalfAt(endEdgeOf[i], i);
    const s = intersectPlanLines(archA.start, WORLD_Y, archB.start, WORLD_X);
    diagSpringing.push([s[0], s[1], zs]);
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

  // Ridge ribs: horizontal, wall arch apex → keystone (both at apexZ), along the web ridges.
  if (p.ridgeRibs) {
    const r = p.ridgeRibs === true ? {} : p.ridgeRibs;
    for (let i = 0; i < n; i++) {
      elements.push({
        id: `ridge${i}`,
        kind: "straight",
        start: apex(i),
        end: keystone,
        up: WORLD_Z,
        profile: r.profile ?? p.profile,
        color: r.color ?? RIDGE_RIB,
        segmentLength: p.segmentLength,
      });
    }
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
  const columnCorners =
    !p.columns || zs <= 0 ? [] : p.columns.at === "all" ? [0, 1, 2, 3] : p.columns.at === "outer" ? OUTER_CORNERS : INNER_CORNERS;
  if (p.columns) {
    for (const i of columnCorners) {
      const c = corners[i];
      elements.push({
        id: `column${i}`,
        kind: "straight",
        start: [c[0], c[1], 0],
        end: c,
        profile: p.columns.profile,
        color: COLUMN,
      });

      // Rib shafts: the wall ribs and the diagonal rib springing at this corner continue
      // straight down to the ground. Profile "up" = the rib's start "up" (horizontal, towards
      // the rib end in plan), so each shaft's section matches its rib at the springing.
      if (p.columns.shafts ?? true) {
        const prev = (i + n - 1) % n;
        const diagProfile = p.diagonalProfile ?? p.profile;
        const shafts: [string, Vec3, Vec3, Profile, Vec3][] = [
          [`wall${i}_a`, wallStart(i), edgeDir[i], p.profile, WALL_RIB],
          [`wall${prev}_b`, wallEnd(prev), scale(edgeDir[prev], -1), p.profile, WALL_RIB],
          [`diag${i}`, diagSpringing[i], normalize([-diagSpringing[i][0], -diagSpringing[i][1], 0]), diagProfile, DIAGONAL_RIB],
        ];
        for (const [rib, top, up, profile, color] of shafts) {
          elements.push({
            id: `shaft_${rib}`,
            kind: "straight",
            start: [top[0], top[1], 0],
            end: top,
            up,
            profile,
            color,
          });
        }
      }
    }
  }

  if (p.window && zs > 0) {
    const w = p.window;
    const e = edgeDir[OUTER_EDGE];
    const p0 = wallStart(OUTER_EDGE);
    const p1 = wallEnd(OUTER_EDGE);
    const frameProfile = w.frameProfile ?? w.profile;
    const clear = profileRadius(p.profile) + profileRadius(frameProfile);
    const recess = w.recess ?? clear;
    const inset = w.inset ?? clear;
    const ribA = len(sub(p1, p0)) / 2; // wall rib half span
    const ribR = (ribA * ribA + p.height * p.height) / (2 * ribA); // wall rib arc radius
    // Border arch: concentric with the wall rib arcs, radius smaller by `inset`.
    const a = ribA - inset; // window half span
    const R = ribR - inset;
    const h = Math.sqrt(R * R - (ribR - ribA) ** 2); // window rise
    if (a <= 0 || !(h > 0)) throw new Error("prismVault: window inset too large");
    const mid = add(scale(add(p0, p1), 0.5), scale(inward[OUTER_EDGE], recess));
    // Window plane point: u along the wall (−a … a), z absolute.
    const at = (u: number, z: number): Vec3 => [mid[0] + e[0] * u, mid[1] + e[1] * u, z];
    const sill = w.sill ?? zs / 3;
    const lights = Math.max(1, Math.round(w.lights ?? 2));
    // Lancets: pointed arches springing vertically, half width al, rise hl, arc radius Rl.
    const span = (2 * a) / lights;
    const al = span / 2;
    const hl = al * Math.max(1, w.lancetPointedness ?? h / a);
    const Rl = (al * al + hl * hl) / (2 * al);
    const oculus = fitOculus(a, R, span, Rl, hl, {
      main: profileRadius(frameProfile) + profileRadius(w.profile),
      lancet: 2 * profileRadius(w.profile),
    });
    const el = { profile: w.profile, color: w.color ?? TRACERY };
    const arc = (id: string, start: Vec3, end: Vec3, startTangent: Vec3, endCut?: Vec3): Element => ({
      id: `window_${id}`, kind: "arc", start, end, startTangent, endCut, segmentLength: p.segmentLength, ...el,
    });
    // Border: sill, jambs (local z towards the window center, like the arch springing) and arch.
    const fel = { profile: frameProfile, color: el.color };
    elements.push(
      { id: "window_sill", kind: "straight", start: at(-a, sill), end: at(a, sill), ...fel },
      { id: "window_jamb_a", kind: "straight", start: at(-a, sill), end: at(-a, zs), up: e, ...fel },
      { id: "window_jamb_b", kind: "straight", start: at(a, sill), end: at(a, zs), up: scale(e, -1), ...fel },
      { id: "window_arch_a", kind: "arc", start: at(-a, zs), end: at(0, zs + h), startTangent: WORLD_Z, endCut: e, segmentLength: p.segmentLength, ...fel },
      { id: "window_arch_b", kind: "arc", start: at(a, zs), end: at(0, zs + h), startTangent: WORLD_Z, endCut: e, segmentLength: p.segmentLength, ...fel },
    );
    for (let k = 0; k < lights; k++) {
      const u0 = -a + k * span;
      const u1 = u0 + span;
      const apex = at((u0 + u1) / 2, zs + hl);
      if (k > 0) elements.push({ id: `window_mullion${k}`, kind: "straight", start: at(u0, sill), end: at(u0, zs), ...el });
      // Each lancet: two arcs springing vertically, meeting at its apex.
      elements.push(arc(`lancet${k + 1}_a`, at(u0, zs), apex, WORLD_Z, e), arc(`lancet${k + 1}_b`, at(u1, zs), apex, WORLD_Z, e));
    }
    // Glass regions in window coordinates (u, z − springing), filled below.
    const sillZ = sill - zs;
    const lancetRegions: Poly2[] = [];
    for (let k = 0; k < lights; k++) lancetRegions.push(pointedRegion(-a + k * span, -a + (k + 1) * span, hl, sillZ));
    let oculusRegion: Poly2 | null = null;
    let hubRegion: Poly2 | null = null;
    const sectorRegions: Poly2[] = [];
    if (oculus) {
      const { r, zc } = oculus;
      oculusRegion = ccw(circlePoints([0, zc], r, 64));
      // Two half circles, bottom → top.
      elements.push(
        arc("oculus_a", at(0, zs + zc - r), at(0, zs + zc + r), e),
        arc("oculus_b", at(0, zs + zc - r), at(0, zs + zc + r), scale(e, -1)),
      );
      if (w.rose) {
        const ro = w.rose;
        const n = Math.max(3, Math.round(ro.spokes ?? 16));
        // Window plane, polar around the oculus center: θ from +u (along the wall) towards +z.
        const polar = (rad: number, th: number) => at(rad * Math.cos(th), zs + zc + rad * Math.sin(th));
        const radial = (th: number): Vec3 => add(scale(e, Math.cos(th)), scale(WORLD_Z, Math.sin(th)));
        const half = Math.PI / n; // half the sector angle
        const roseProfile = ro.profile ?? w.profile;
        const roseSeg = ro.segmentLength ?? p.segmentLength / 3;
        // Arch tip surface touches the oculus surface (in-plane half thicknesses).
        const tipR = r - inPlaneHalf(roseProfile) - inPlaneHalf(w.profile);
        const rel = { profile: roseProfile, color: el.color };
        const roseArc = (id: string, start: Vec3, end: Vec3, startTangent: Vec3, endCut?: Vec3): Element => ({
          id: `window_${id}`, kind: "arc", start, end, startTangent, endCut, segmentLength: roseSeg, ...rel,
        });
        // Spoke end radius rs: arch rise (tipR − rs·cos half) = pointedness · half span (rs·sin half).
        const k = ro.pointedness ?? 1.5;
        const rs = tipR / (Math.cos(half) + k * Math.sin(half));
        const hubR = r * (ro.hub ?? 0.2);
        if (hubR < rs) {
          // Glass: hub disk, and per sector the convex region between two spokes (from the
          // hub's tangent chord) closed by the sector's pointed arch.
          const p2 = (rad: number, th: number): P2 => [rad * Math.cos(th), zc + rad * Math.sin(th)];
          const r2 = (th: number): P2 => [Math.cos(th), Math.sin(th)];
          hubRegion = ccw(circlePoints([0, zc], hubR, 32));
          const rIn = hubR / Math.cos(half);
          for (let i = 0; i < n; i++) {
            const th = Math.PI / 2 + 2 * half * i;
            const th2 = th + 2 * half;
            const tip2 = p2(tipR, th + half);
            const sideA = arcPoints(p2(rs, th), r2(th), tip2, 12);
            const sideB = arcPoints(p2(rs, th2), r2(th2), tip2, 12).reverse();
            sectorRegions.push(ccw(simplify([p2(rIn, th), ...sideA, ...sideB, p2(rIn, th2)])));
          }
          elements.push(
            roseArc("rose_hub_a", polar(hubR, -Math.PI / 2), polar(hubR, Math.PI / 2), e),
            roseArc("rose_hub_b", polar(hubR, -Math.PI / 2), polar(hubR, Math.PI / 2), scale(e, -1)),
          );
          for (let i = 0; i < n; i++) {
            const th = Math.PI / 2 + 2 * half * i; // spoke 0 vertical, up
            // up = in-plane normal of the spoke, so local y is the window normal as on the arcs.
            elements.push({
              id: `window_rose_spoke${i}`, kind: "straight", start: polar(hubR, th), end: polar(rs, th),
              up: radial(th + Math.PI / 2), segmentLength: roseSeg, ...rel,
            });
            const tip = polar(tipR, th + half);
            elements.push(
              // Mirror plane of the sector arch: through the tip, normal ⟂ to the tip radius.
              roseArc(`rose_arch${i}_a`, polar(rs, th), tip, radial(th), radial(th + half + Math.PI / 2)),
              roseArc(`rose_arch${i}_b`, polar(rs, th + 2 * half), tip, radial(th + 2 * half), radial(th + half + Math.PI / 2)),
            );
          }
        }
      }
    }

    if (w.glass) {
      const g = w.glass;
      const tile = g.tileSize ?? p.segmentLength;
      const gap = (g.tileGap ?? 0.6) / 2;
      const outline = pointedRegion(-a, a, h, sillZ);
      const pane = { thickness: g.thickness ?? 1, color: g.color ?? GLASS, alpha: g.alpha ?? 0.3 };
      let count = 0;
      const emit = (poly: Poly2) => {
        const q = simplify(insetConvex(poly, gap));
        if (q.length < 3 || Math.abs(area2(q)) < 0.5) return;
        elements.push({ id: `window_glass_${count++}`, kind: "plate", corners: q.map(([u, z]) => at(u, zs + z)), ...pane });
      };
      const minus = (pieces: Poly2[], hole: Poly2) => pieces.flatMap((pc) => subtractConvex(pc, hole));
      // Lancets: each its own grid, `cols` equal columns across the light, square rows.
      const cols = Math.max(1, Math.round(w.lancetGlassColumns ?? 2));
      const colW = span / cols;
      lancetRegions.forEach((L, k) => {
        const u0 = -a + k * span;
        for (let c = 0; c < cols; c++) {
          const ua = u0 + c * colW;
          for (let z = sillZ; z < hl; z += colW) {
            emit(clipConvex([[ua, z], [ua + colW, z], [ua + colW, z + colW], [ua, z + colW]], L));
          }
        }
      });
      // Rest of the window: square grid (aligned at the axis and the sill) cut into the openings.
      for (let u = -Math.ceil(a / tile) * tile; u < a; u += tile) {
        for (let z = sillZ; z < h; z += tile) {
          const cell = clipConvex([[u, z], [u + tile, z], [u + tile, z + tile], [u, z + tile]], outline);
          if (!cell.length) continue;
          let upper: Poly2[] = [cell];
          for (const L of lancetRegions) upper = minus(upper, L);
          if (!oculusRegion) {
            upper.forEach(emit);
            continue;
          }
          minus(upper, oculusRegion).forEach(emit);
          for (const pc of upper) {
            const d = clipConvex(pc, oculusRegion);
            if (!d.length) continue;
            let rest: Poly2[] = [d];
            for (const reg of hubRegion ? [hubRegion, ...sectorRegions] : []) {
              emit(clipConvex(d, reg));
              rest = minus(rest, reg);
            }
            rest.forEach(emit);
          }
        }
      }
    }
  }

  return { elements };
}

/** Largest distance of the profile outline from the member axis. */
function profileRadius(profile: Profile): number {
  return Math.max(...profile.outline.map(([y, z]) => Math.hypot(y, z)));
}

/**
 * Oculus in window coordinates (u along the wall, z above the springing), center (0, zc).
 * Main arch: half span a, radius R, left arc center (R − a, 0). Lancets of width `span`
 * side by side from u = −a, arcs of radius Rl rising to hl.
 * Clearances are between member axes, so the tube surfaces just touch:
 *   main arch (inside):   |center − (R−a, 0)| = R − r − gap.main
 *   lancet arcs (outside): min distance to every arc ≥ r + gap.lancet
 * zc follows r from the main arch condition; r is the largest radius clearing the lancets.
 */
function fitOculus(
  a: number, R: number, span: number, Rl: number, hl: number,
  gap: { main: number; lancet: number },
): { r: number; zc: number } | null {
  const zcOf = (r: number) => Math.sqrt(Math.max(0, (R - r - gap.main) ** 2 - (R - a) ** 2));
  // Dense samples of all lancet arcs.
  const pts: [number, number][] = [];
  const phiMax = Math.atan2(hl, Rl - span / 2);
  const lights = Math.round((2 * a) / span);
  for (let k = 0; k < lights; k++) {
    const u0 = -a + k * span;
    const u1 = u0 + span;
    for (let j = 0; j <= 128; j++) {
      const phi = (phiMax * j) / 128;
      const du = Rl * (1 - Math.cos(phi));
      const z = Rl * Math.sin(phi);
      pts.push([u0 + du, z], [u1 - du, z]);
    }
  }
  const clearance = (r: number) => {
    const zc = zcOf(r);
    return Math.min(...pts.map(([u, z]) => Math.hypot(u, z - zc))) - r - gap.lancet;
  };
  let lo = 0;
  let hi = a - gap.main;
  if (hi <= 0 || clearance(lo) <= 0) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (clearance(mid) > 0) lo = mid;
    else hi = mid;
  }
  return lo > 0 ? { r: lo, zc: zcOf(lo) } : null;
}

/**
 * Pointed opening in window coordinates: vertical sides from `base` up to the springing
 * (z = 0) at u0 / u1, closed by two arcs springing vertically and meeting at (mid, rise).
 */
function pointedRegion(u0: number, u1: number, rise: number, base: number): Poly2 {
  const apex: P2 = [(u0 + u1) / 2, rise];
  const right = arcPoints([u1, 0], [0, 1], apex, 24);
  const left = arcPoints([u0, 0], [0, 1], apex, 24).reverse();
  return ccw(simplify([[u0, base], [u1, base], ...right, ...left]));
}

/** Half thickness of the profile along local z (in the plane of a curved member's bend). */
function inPlaneHalf(profile: Profile): number {
  return Math.max(...profile.outline.map(([, z]) => Math.abs(z)));
}

/** Intersection of two plan lines p + t·u and q + s·v (z ignored, both at the same height). */
function intersectLines(p: Vec3, u: Vec3, q: Vec3, v: Vec3): Vec3 {
  const denom = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(denom) < 1e-12) return p; // parallel edges (degenerate polygon)
  const w = sub(q, p);
  const t = (w[0] * v[1] - w[1] * v[0]) / denom;
  return add(p, scale(u, t));
}
