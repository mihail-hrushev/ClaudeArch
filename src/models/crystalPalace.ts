import type { Model } from "../fem/types";
import type { Vec3 } from "../fem/vec";
import { circleProfile, rectangleProfile, squareProfile } from "../fem/profiles";
import { assemble } from "../fem/placement";
import { removeDuplicateMembers } from "../fem/dedupe";
import { type ColumnType, type SurfaceType, crystalPalace } from "../generators/crystalPalace";
import type { View } from "./view";

/** Scene units are centimetres: lets a size be given in metres. */
const m = (v: number) => v * 100;

/**
 * Main dimensions of the Palacio de Cristal, Retiro Park, Madrid (1887). Replace a value here when
 * a measured one arrives: everything else follows from these.
 *
 * PUBLISHED values come from written sources. No measured plan or section has been found yet, so
 * ESTIMATE values are chosen to fit the published ones and the descriptions of the building.
 */
export const DIMENSIONS = {
  length: m(54), //         PUBLISHED
  depth: m(28), //          PUBLISHED; assumed to leave out the portico
  armWidth: m(14), //       ESTIMATE: makes the rear arm as long as it is wide, as in a Greek cross
  aisleWidth: m(3), //      ESTIMATE
  apseSides: 3, //          ESTIMATE: sources say apse and trefoil, not how it is built
  bayStep: m(2.8), //       ESTIMATE
  floor: m(1.2), //         ESTIMATE
  eaves: m(6.4), //         ESTIMATE
  aisleRoof: m(8), //       ESTIMATE
  naveCrown: m(14.61), //   PUBLISHED: height of the side naves
  drumTop: m(18), //        ESTIMATE
  domeApex: m(22.6), //     PUBLISHED: height of the dome
  lanternTop: m(24), //     PUBLISHED as the dome height by the Reina Sofia Museum and the city of
  //                        Madrid; assumed here to include the zinc pyramid on top
  lanternWidth: m(1.6), //  ESTIMATE
  porticoWidth: m(12), //   ESTIMATE
  porticoDepth: m(3.6), //  ESTIMATE
  porticoColumns: 4, //     PUBLISHED: tetrastyle
};

const GLASS = { thickness: 1.2, gap: 1.5, alpha: 0.5, reflection: 0.5 };
const IRON: Vec3 = [0.93, 0.92, 0.88];
const STONE: Vec3 = [0.86, 0.83, 0.76];
const GRANITE: Vec3 = [0.63, 0.62, 0.61];
const BRICK: Vec3 = [0.66, 0.36, 0.27];
const CERAMIC: Vec3 = [0.2, 0.42, 0.52];
const ZINC: Vec3 = [0.55, 0.58, 0.6];

const glazed = (align: SurfaceType["tile"]["align"]): SurfaceType => ({
  tile: { width: 50, length: 100, ...GLASS, align },
  profiles: {
    mainRib: rectangleProfile(5, 14), cutRib: rectangleProfile(8, 20),
    horizontalFrame: rectangleProfile(3, 8), verticalFrame: rectangleProfile(3, 6),
  },
});

/** Ionic column: a base and a capital reaching out from the shaft of the given radius. */
const ionic = (radius: number): ColumnType => ({
  shaft: circleProfile(radius), base: squareProfile(radius * 2.8), baseHeight: radius * 1.2,
  capital: rectangleProfile(radius * 3.4, radius * 2.2), capitalHeight: radius * 1.4,
});

/**
 * Palacio de Cristal, the 1887 iron and glass pavilion in Retiro Park, Madrid, by Ricardo Velázquez
 * Bosco with the engineer Alberto de Palacio.
 */
export function buildCrystalPalace(d: typeof DIMENSIONS = DIMENSIONS): Model {
  const instance = crystalPalace({
    plan: { length: d.length, depth: d.depth, armWidth: d.armWidth, aisleWidth: d.aisleWidth, apseSides: d.apseSides, bayStep: d.bayStep },
    levels: {
      floor: d.floor, eaves: d.eaves, aisleRoof: d.aisleRoof, naveCrown: d.naveCrown,
      drumTop: d.drumTop, domeApex: d.domeApex, lanternTop: d.lanternTop,
    },
    lantern: { width: d.lanternWidth, color: ZINC },
    surfaces: {
      wall: glazed("top-center"), aisleRoof: glazed("bottom-center"), clerestory: glazed("top-center"),
      vault: glazed("bottom-center"), drum: glazed("top-center"), dome: glazed("bottom-center"),
    },
    structure: { wallColumn: ionic(9), naveColumn: ionic(12), arch: circleProfile(5), beam: rectangleProfile(12, 24) },
    plinth: {
      thickness: 50, color: BRICK,
      slab: { thickness: 10, color: STONE },
      frieze: { height: 30, thickness: 34, color: CERAMIC },
      cornice: { height: 18, thickness: 30, color: CERAMIC },
    },
    portico: {
      width: d.porticoWidth, depth: d.porticoDepth, columns: d.porticoColumns, column: ionic(30),
      columnHeight: 400, entablature: 60, overhang: 20, cornice: 18, color: STONE,
    },
    terrace: {
      width: m(20), depth: m(4), color: STONE,
      balustrade: {
        height: 100, middleHeight: 55, kickHeight: 10, postStep: 120,
        profiles: {
          post: squareProfile(16), topRail: rectangleProfile(24, 12),
          middleRail: circleProfile(3), kickRail: rectangleProfile(20, 14),
        },
      },
    },
    stair: { width: m(10), riser: 15, tread: 35, color: GRANITE },
    lake: { width: m(90), depth: m(40), level: 0.5, color: [0.3, 0.46, 0.5], alpha: 0.75, reflection: 0.8 },
    color: IRON,
  });
  // Neighbouring surfaces share their edge ribs: drop the coincident copies.
  return removeDuplicateMembers(assemble([instance]));
}

export const crystalPalaceView: View = { target: [0, -300, 700], radius: 4600, alpha: Math.PI / 2 + 0.6, beta: Math.PI / 2.25 };
