import "@babylonjs/core/Rendering/edgesRenderer";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { buildModel } from "./render/elementMesh";
import { createAxes } from "./render/axes";
import { createEnvironment } from "./render/environment";
import { createStatsOverlay } from "./render/stats";
import { testModel } from "./testModel";
import { gothicVault } from "./generators/gothicVault";
import { prismVault } from "./generators/prismVault";
import { circleProfile, prismProfile, rectangleProfile } from "./fem/profiles";
import { type Instance, WORLD_FRAME, assemble } from "./fem/placement";
import { ringLayout, fitRingBay } from "./generators/layouts";
import { removeDuplicateMembers } from "./fem/dedupe";

/** Rib offset inside each bay outline (profile diameter is 8). */
const RIB_OFFSET = 3.5;
/** Wall ribs (yellow): round. Diagonal ribs (orange): prism, narrow side into the vault. */
const WALL_PROFILE = circleProfile(4);
const DIAGONAL_PROFILE = prismProfile(10, 4, 10);
/** Inner columns (grey) carrying the vault springing. */
const COLUMN_PROFILE = circleProfile(8);
const COLUMN_HEIGHT = 300;
/** Window tracery (sill, mullion, lancets, oculus). */
const TRACERY_PROFILE = circleProfile(3);
/** Window border (main arch, jambs, sill): 8 deep × 5 wide in the window face. */
const WINDOW_FRAME_PROFILE = rectangleProfile(8, 5);
/** Rose tracery: rectangular, 6 deep (through the wall) × 3 wide (in the window face). */
const ROSE_PROFILE = rectangleProfile(6, 3);

/** Half ring (apse) of prism vaults, narrow ends looking at the world origin. */
function prismHalfRing(count = 4): Instance[] {
  const length = 350;
  const width2 = 250;
  const sweep = Math.PI;
  // Outer width1 is derived so neighbouring bays share their side walls.
  const { outerWidth: width1, radius } = fitRingBay(length, width2, sweep / count);
  const prism = prismVault({
    length, width1, width2, height: 350,
    profile: WALL_PROFILE, diagonalProfile: DIAGONAL_PROFILE,
    segmentLength: 20, offset: RIB_OFFSET,
    ridgeRibs: true,
    springing: COLUMN_HEIGHT,
    columns: { profile: COLUMN_PROFILE, at: "all" },
    window: {
      profile: TRACERY_PROFILE,
      frameProfile: WINDOW_FRAME_PROFILE,
      lights: 7,
      lancetPointedness: 3,
      rose: { spokes: 16, profile: ROSE_PROFILE, pointedness: 2.5 },
      glass: {},
    },
    glass: {},
  });
  return ringLayout(prism, { count, radius, sweep, name: "prism" });
}

/**
 * Pick the scene content via URL:
 *   ?model=test    axis test elements
 *   ?model=square  single square gothic vault
 *   default        half ring (apse) of 5 prism vaults
 */
function selectInstances(): Instance[] {
  switch (new URLSearchParams(location.search).get("model")) {
    case "test":
      return [{ name: "test", model: testModel, frame: WORLD_FRAME }];
    case "square": {
      const vault = gothicVault({
        width: 400, depth: 400, height: 350,
        profile: WALL_PROFILE, diagonalProfile: DIAGONAL_PROFILE,
        segmentLength: 20, offset: RIB_OFFSET,
        glass: {},
      });
      return [{ name: "square", model: vault, frame: WORLD_FRAME }];
    }
    default:
      return prismHalfRing();
  }
}

/** World convention: right-handed, Z up (same coordinates as the FEM model). */
export function createScene(engine: Engine, canvas: HTMLCanvasElement): Scene {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  // No hover interaction yet: skip ray-picking all triangles on every mouse move.
  scene.skipPointerMovePicking = true;

  const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.8, 2000, new Vector3(0, 250, 300), scene);
  camera.upVector = new Vector3(0, 0, 1);
  camera.lowerRadiusLimit = 5;
  camera.upperRadiusLimit = 3000;
  camera.minZ = 0.5;
  camera.maxZ = 20000;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 20;
  camera.attachControl(canvas, true);

  // Sky, sun with soft shadows, fog, reflections and post-processing ("L" cycles the light).
  const environment = createEnvironment(scene, camera);

  createAxes(scene);
  const instances = selectInstances();
  for (const inst of instances) {
    if (inst.frame !== WORLD_FRAME) createAxes(scene, { frame: inst.frame, length: 50, thickness: 2, name: `${inst.name}/ucs` });
  }
  // Neighbouring bays share corner columns: drop the coincident copies.
  environment.addModel(buildModel(removeDuplicateMembers(assemble(instances)), scene));

  createStatsOverlay(scene);

  return scene;
}
