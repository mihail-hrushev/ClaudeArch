import type { Model } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { type GlassParams, prismVault } from "./prismVault";

export interface GothicVaultParams {
  /** Span along X. */
  readonly width: number;
  /** Span along Y. */
  readonly depth: number;
  /** Rise of the wall arch apexes and the keystone above the springing level. */
  readonly height: number;
  readonly profile: Profile;
  /** Profile of the diagonal ribs (default: `profile`). */
  readonly diagonalProfile?: Profile;
  readonly segmentLength: number;
  /** Rib offset inside the bay outline, see PrismVaultParams.offset. */
  readonly offset?: number;
  /** Glass ceiling on the vault webs, see PrismVaultParams.glass. */
  readonly glass?: GlassParams;
}

/**
 * Quadripartite gothic rib vault over a rectangular (square) bay:
 * pointed wall arches on every side, elliptic diagonal ribs whose projection on the
 * XZ plane coincides with the wall arch. A prism vault with equal end widths.
 */
export function gothicVault(p: GothicVaultParams): Model {
  return prismVault({
    length: p.width,
    width1: p.depth,
    width2: p.depth,
    height: p.height,
    profile: p.profile,
    diagonalProfile: p.diagonalProfile,
    segmentLength: p.segmentLength,
    offset: p.offset,
    glass: p.glass,
  });
}
