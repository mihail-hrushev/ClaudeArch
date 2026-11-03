import type { Element, Model } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type Vec3, add, scale, WORLD_Z } from "../fem/vec";

export interface PrismVaultParams {
  /** Bay length along X. */
  readonly length: number;
  /** Width (along Y) of the end at x = −length/2. */
  readonly width1: number;
  /** Width (along Y) of the end at x = +length/2. */
  readonly width2: number;
  /** Apex height of the wall arches and the keystone. */
  readonly height: number;
  readonly profile: Profile;
  readonly segmentLength: number;
}

const WALL_RIB: Vec3 = [1, 0.85, 0.1];
const DIAGONAL_RIB: Vec3 = [0.95, 0.45, 0.15];

/**
 * Gothic rib vault over a trapezoidal (prism) bay, in local coordinates: plan center at
 * the origin, symmetric about local X, springing at z = 0. Place it with a LocalFrame.
 *  - Wall ribs: on every side a pointed arch — two circular arcs springing vertically
 *    from the corners and meeting at mid-side at `height`.
 *  - Diagonal ribs: corner → keystone (plan center, at `height`), elliptic. Each is the
 *    adjacent long-side wall arch stretched along Y, so seen along Y it coincides with it.
 * With width1 === width2 this is the rectangular / square vault.
 */
export function prismVault(p: PrismVaultParams): Model {
  const hl = p.length / 2;
  const a = p.width1 / 2;
  const b = p.width2 / 2;
  // Counter-clockwise: long side at −Y (edge 0), narrow end, long side at +Y (edge 2), wide end.
  const corners: Vec3[] = [
    [-hl, -a, 0],
    [hl, -b, 0],
    [hl, b, 0],
    [-hl, a, 0],
  ];
  const apex = (i: number): Vec3 => {
    const m = scale(add(corners[i], corners[(i + 1) % 4]), 0.5);
    return [m[0], m[1], m[2] + p.height];
  };
  const keystone: Vec3 = [0, 0, p.height];
  // Diagonal rib of each corner follows the wall arch of its long side (edge 0 or 2).
  const longSideOf = [0, 0, 2, 2];

  const elements: Element[] = [];
  const common = { profile: p.profile, segmentLength: p.segmentLength, startTangent: WORLD_Z };

  corners.forEach((c, i) => {
    const next = corners[(i + 1) % 4];
    const top = apex(i);
    elements.push(
      { id: `wall${i}_a`, kind: "arc", start: c, end: top, color: WALL_RIB, ...common },
      { id: `wall${i}_b`, kind: "arc", start: next, end: top, color: WALL_RIB, ...common },
      {
        id: `diag${i}`,
        kind: "ellipticArc",
        start: c,
        end: keystone,
        baseEnd: apex(longSideOf[i]),
        color: DIAGONAL_RIB,
        ...common,
      },
    );
  });

  return { elements };
}
