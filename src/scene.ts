import "@babylonjs/core/Rendering/edgesRenderer";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Model } from "./fem/types";
import { buildModel } from "./render/elementMesh";
import { createAxes } from "./render/axes";
import { createEnvironment } from "./render/environment";
import { createSpectator } from "./render/spectator";
import { createStatsOverlay } from "./render/stats";
import { installIvyToggle } from "./render/ivyLayer";
import type { View } from "./models/view";
import { buildCuritibaV2, curitibaV2View } from "./models/curitibaV2";
import { buildTestModel, testView } from "./models/testModel";

interface ModelEntry {
  /** Value of the `?model=` URL parameter. */
  readonly key: string;
  /** Final world-space model (assembled and de-duplicated). */
  readonly build: () => Model;
  readonly view: View;
}

/** Scene content, picked via `?model=<key>`; the first entry is the default. */
const MODELS: readonly ModelEntry[] = [
  { key: "curitibaV2", build: buildCuritibaV2, view: curitibaV2View },
  { key: "test", build: buildTestModel, view: testView },
];

function selectModel(): ModelEntry {
  const key = new URLSearchParams(location.search).get("model");
  return MODELS.find((m) => m.key === key) ?? MODELS[0];
}

/** World convention: right-handed, Z up (same coordinates as the FEM model). */
export function createScene(engine: Engine, canvas: HTMLCanvasElement): Scene {
  // Plain uniforms instead of uniform buffers: Babylon declares one buffer per light, and WebGL
  // on D3D11 allows ~12 blocks per shader, which would cap the night mode at ~9 lights per mesh.
  engine.disableUniformBuffers = true;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  // No hover interaction yet: skip ray-picking all triangles on every mouse move.
  scene.skipPointerMovePicking = true;

  const entry = selectModel();
  const { view } = entry;
  const camera = new ArcRotateCamera("camera", view.alpha, view.beta, view.radius, new Vector3(...view.target), scene);
  camera.upVector = new Vector3(0, 0, 1);
  camera.lowerRadiusLimit = 5;
  camera.upperRadiusLimit = Math.max(3000, view.radius * 2);
  camera.minZ = 0.5;
  camera.maxZ = 20000;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 20;
  camera.attachControl(canvas, true);

  // First-person fly camera: "C" toggles, WASD moves, mouse looks.
  const spectator = createSpectator(scene, canvas, camera);

  // Sky, sun with soft shadows, fog, reflections and post-processing ("L" cycles the light,
  // "N" toggles night mode, also "?mode=night").
  const environment = createEnvironment(scene, camera, spectator.camera);

  createAxes(scene);
  const model = entry.build();
  environment.addModel(buildModel(model, scene), model);
  // Ivy decoration layer (src/render/ivyLayer.ts): "?ivy=1" grows it at start-up, "I" toggles it.
  installIvyToggle(scene, model, environment);

  createStatsOverlay(scene);

  return scene;
}
