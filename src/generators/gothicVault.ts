import type { Element, Model } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type Vec3, add, WORLD_Y, WORLD_Z } from "../fem/vec";

export interface GothicVaultParams {
  /** Span along X. */
  readonly width: number;
  /** Span along Y. */
  readonly depth: number;
  /** Apex height of the wall arches and the keystone. */
  readonly height: number;
  readonly profile: Profile;
  readonly segmentLength: number;
  /** Plan center of the bay (z is the springing level). */
  readonly origin?: Vec3;
}

const WALL_RIB: Vec3 = [1, 0.85, 0.1];
const DIAGONAL_RIB: Vec3 = [0.95, 0.45, 0.15];

/**
 * Quadripartite gothic rib vault over a rectangular bay.
 *  - Wall ribs: on every side a pointed arch — two circular arcs springing vertically
 *    from the corners and meeting at mid-edge at `height`.
 *  - Diagonal ribs: corner → keystone, elliptic. Each is the X-wall arch stretched along Y,
 *    so its projection on the XZ plane coincides with the wall arch.
 */
export function gothicVault(p: GothicVaultParams): Model {
  const o = p.origin ?? [0, 0, 0];
  const hx = p.width / 2;
  const hy = p.depth / 2;
  const corners: Vec3[] = (
    [
      [-hx, -hy, 0],
      [hx, -hy, 0],
      [hx, hy, 0],
      [-hx, hy, 0],
    ] as const
  ).map((c) => add(o, c));
  const apex = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2] + p.height];
  const keystone = add(o, [0, 0, p.height]);

  const elements: Element[] = [];
  const common = { profile: p.profile, segmentLength: p.segmentLength, startTangent: WORLD_Z };

  corners.forEach((a, i) => {
    const b = corners[(i + 1) % 4];
    const top = apex(a, b);
    elements.push(
      { id: `wall${i}_a`, kind: "arc", start: a, end: top, color: WALL_RIB, ...common },
      { id: `wall${i}_b`, kind: "arc", start: b, end: top, color: WALL_RIB, ...common },
    );
    elements.push({
      id: `diag${i}`,
      kind: "ellipticArc",
      start: a,
      end: keystone,
      projectionAxis: WORLD_Y,
      color: DIAGONAL_RIB,
      ...common,
    });
  });

  return { elements };
}
