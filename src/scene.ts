import "@babylonjs/core/Rendering/edgesRenderer";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { GridMaterial } from "@babylonjs/materials/grid/gridMaterial";

export function createScene(engine: Engine, canvas: HTMLCanvasElement): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.11, 0.13, 1);

  const camera = new ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, 15, new Vector3(0, 1.5, 0), scene);
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 100;
  camera.wheelDeltaPercentage = 0.01;
  camera.attachControl(canvas, true);

  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.6;
  const sun = new DirectionalLight("sun", new Vector3(-1, -2, -1), scene);
  sun.intensity = 0.8;

  // Ground grid
  const ground = MeshBuilder.CreateGround("ground", { width: 50, height: 50 }, scene);
  const grid = new GridMaterial("grid", scene);
  grid.mainColor = new Color3(0.12, 0.14, 0.16);
  grid.lineColor = new Color3(0.35, 0.4, 0.45);
  grid.gridRatio = 1;
  grid.majorUnitFrequency = 5;
  grid.opacity = 0.99;
  ground.material = grid;

  // Placeholder: will be replaced by the greenhouse generator
  const box = MeshBuilder.CreateBox("placeholder", { width: 4, height: 2.5, depth: 6 }, scene);
  box.position.y = 1.25;
  const glass = new StandardMaterial("glass", scene);
  glass.diffuseColor = new Color3(0.6, 0.9, 0.7);
  glass.alpha = 0.35;
  glass.backFaceCulling = false;
  box.material = glass;
  box.enableEdgesRendering();
  box.edgesWidth = 2;
  box.edgesColor = new Color4(0.85, 0.95, 0.9, 1);

  return scene;
}
