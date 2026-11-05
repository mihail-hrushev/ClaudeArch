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

  // Sky, sun with soft shadows, fog, reflections and post-processing ("L" cycles the light).
  const environment = createEnvironment(scene, camera, spectator.camera);

  createAxes(scene);
  environment.addModel(buildModel(entry.build(), scene));

  createStatsOverlay(scene);

  return scene;
}
