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
import { installGlbExport } from "./render/exportGlb";
import { restoreCameraFromUrl, trackCameraInUrl } from "./render/cameraUrl";
import type { View } from "./models/view";
import { buildCuritibaV2, curitibaV2View } from "./models/curitibaV2";
import { buildCrystalPalace, crystalPalaceView } from "./models/crystalPalace";
import { buildTestModel, testView } from "./models/testModel";
import { loadStructure, structureKeys } from "./models/structures";

interface ModelEntry {
  /** Value of the `?model=` URL parameter. */
  readonly key: string;
  /** Final world-space model (assembled and de-duplicated). */
  readonly build: () => Model | Promise<Model>;
  readonly view: View;
}

/** Scene content, picked via `?model=<key>`; the first entry is the default. */
const MODELS: readonly ModelEntry[] = [
  { key: "curitibaV2", build: buildCuritibaV2, view: curitibaV2View },
  { key: "crystalPalace", build: buildCrystalPalace, view: crystalPalaceView },
  { key: "test", build: buildTestModel, view: testView },
];

/** The model named by `?model=`: a built-in one, or a structure document from structures/. */
async function selectModel(): Promise<ModelEntry> {
  const key = new URLSearchParams(location.search).get("model");
  const builtIn = MODELS.find((m) => m.key === key);
  if (builtIn) return builtIn;
  if (key && structureKeys.includes(key)) {
    const built = await loadStructure(key);
    return { key, build: () => built.model, view: built.view };
  }
  return MODELS[0];
}

/** World convention: right-handed, Z up (same coordinates as the FEM model). */
export async function createScene(engine: Engine, canvas: HTMLCanvasElement): Promise<Scene> {
  // Plain uniforms instead of uniform buffers: Babylon declares one buffer per light, and WebGL
  // on D3D11 allows ~12 blocks per shader, which would cap the night mode at ~9 lights per mesh.
  engine.disableUniformBuffers = true;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  // No hover interaction yet: skip ray-picking all triangles on every mouse move.
  scene.skipPointerMovePicking = true;

  const entry = await selectModel();
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
  // "?cam=" keeps the view across reloads.
  restoreCameraFromUrl(camera);
  trackCameraInUrl(camera);

  // First-person fly camera: "C" toggles, WASD moves, mouse looks.
  const spectator = createSpectator(scene, canvas, camera);

  // Sky, sun with soft shadows, fog, reflections and post-processing ("L" cycles the light,
  // "N" toggles night mode, also "?mode=night").
  const environment = createEnvironment(scene, camera, spectator.camera);

  createAxes(scene);
  const model = await entry.build();
  const meshes = buildModel(model, scene);
  environment.addModel(meshes, model);
  // "Save GLB" button and "G": download the structure as a binary glTF.
  installGlbExport(scene, meshes, entry.key);
  // Ivy decoration layer (src/render/ivyLayer.ts): "?ivy=1" grows it at start-up, "I" toggles it.
  installIvyToggle(scene, model, environment);

  createStatsOverlay(scene);

  return scene;
}
