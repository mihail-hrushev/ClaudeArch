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
import { squareProfile } from "./fem/profiles";

/** Pick the model via URL: ?model=test shows the axis test elements, default is the vault. */
function selectModel() {
  if (new URLSearchParams(location.search).get("model") === "test") return testModel;
  return gothicVault({ width: 400, depth: 200, height: 300, profile: squareProfile(8), segmentLength: 20 });
}

/** World convention: right-handed, Z up (same coordinates as the FEM model). */
export function createScene(engine: Engine, canvas: HTMLCanvasElement): Scene {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.1, 0.11, 0.13, 1);

  const camera = new ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 2.6, 750, new Vector3(0, 0, 150), scene);
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
  buildModel(selectModel(), scene);

  return scene;
}
