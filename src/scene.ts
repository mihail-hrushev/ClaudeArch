import "@babylonjs/core/Rendering/edgesRenderer";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { GridMaterial } from "@babylonjs/materials/grid/gridMaterial";
import { buildModel } from "./render/elementMesh";
import { createAxes } from "./render/axes";
import { testModel } from "./testModel";
import { gothicVault } from "./generators/gothicVault";
import { prismVault } from "./generators/prismVault";
import { circleProfile } from "./fem/profiles";
import { type Instance, WORLD_FRAME, assemble } from "./fem/placement";
import { ringLayout, fitRingBay } from "./generators/layouts";

/** Half ring (apse) of prism vaults, narrow ends looking at the world origin. */
function prismHalfRing(count = 5): Instance[] {
  const length = 300;
  const width2 = 200;
  const sweep = Math.PI;
  // Outer width1 is derived so neighbouring bays share their side walls.
  const { outerWidth: width1, radius } = fitRingBay(length, width2, sweep / count);
  const prism = prismVault({ length, width1, width2, height: 350, profile: circleProfile(4), segmentLength: 20 });
  return ringLayout(prism, { count, radius, sweep, name: "prism" });
}

/**
 * Pick the scene content via URL:
 *   ?model=test    axis test elements
 *   ?model=square  single square gothic vault
 *   default        half ring (apse) of 5 prism vaults
 */
function selectInstances(): Instance[] {
  const profile = circleProfile(4);
  switch (new URLSearchParams(location.search).get("model")) {
    case "test":
      return [{ name: "test", model: testModel, frame: WORLD_FRAME }];
    case "square":
      return [{ name: "square", model: gothicVault({ width: 400, depth: 400, height: 350, profile, segmentLength: 20 }), frame: WORLD_FRAME }];
    default:
      return prismHalfRing();
  }
}

/** World convention: right-handed, Z up (same coordinates as the FEM model). */
export function createScene(engine: Engine, canvas: HTMLCanvasElement): Scene {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.1, 0.11, 0.13, 1);

  const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3, 1600, new Vector3(0, 250, 150), scene);
  camera.upVector = new Vector3(0, 0, 1);
  camera.lowerRadiusLimit = 5;
  camera.upperRadiusLimit = 3000;
  camera.minZ = 0.5;
  camera.maxZ = 10000;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 20;
  camera.attachControl(canvas, true);

  const hemi = new HemisphericLight("hemi", new Vector3(0, 0, 1), scene);
  hemi.intensity = 0.6;
  hemi.groundColor = new Color3(0.3, 0.3, 0.35);
  const sun = new DirectionalLight("sun", new Vector3(-1, -2, -3), scene);
  sun.intensity = 0.7;

  // Ground grid in the XY plane (CreateGround builds XZ, rotate it to face +Z).
  const ground = MeshBuilder.CreateGround("ground", { width: 1000, height: 1000 }, scene);
  ground.rotation.x = Math.PI / 2;
  ground.isPickable = false;
  const grid = new GridMaterial("grid", scene);
  grid.mainColor = new Color3(0.12, 0.14, 0.16);
  grid.lineColor = new Color3(0.35, 0.4, 0.45);
  grid.gridRatio = 10;
  grid.majorUnitFrequency = 5;
  grid.opacity = 0.99;
  grid.backFaceCulling = false;
  ground.material = grid;

  createAxes(scene);
  const instances = selectInstances();
  for (const inst of instances) {
    if (inst.frame !== WORLD_FRAME) createAxes(scene, { frame: inst.frame, length: 50, thickness: 2, name: `${inst.name}/ucs` });
  }
  buildModel(assemble(instances), scene);

  return scene;
}
