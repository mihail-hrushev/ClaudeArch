import type { Model } from "../fem/types";
import type { Profile } from "../fem/profiles";
import { prismVault } from "./prismVault";

export interface GothicVaultParams {
  /** Span along X. */
  readonly width: number;
  /** Span along Y. */
  readonly depth: number;
  /** Apex height of the wall arches and the keystone. */
  readonly height: number;
  readonly profile: Profile;
  readonly segmentLength: number;
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
    segmentLength: p.segmentLength,
  });
}
