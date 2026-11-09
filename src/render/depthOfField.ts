import type { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DepthOfFieldEffectBlurLevel } from "@babylonjs/core/PostProcesses/depthOfFieldEffect";
import type { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { circleOfConfusionPixelShader } from "@babylonjs/core/Shaders/circleOfConfusion.fragment";
import { setUrlParam } from "./urlState";

/** Blur at infinity, 0..1 of the blur kernel; it grows from zero at the focus distance. */
const MAX_BLUR = 0.5;
/** Nearest focus of the fly camera, in scene units (15 m): indoors, the room stays sharp. */
const MIN_FLY_FOCUS = 1500;
/** Lens focal length, in the effect's units (scene units / 1000). */
const FOCAL_LENGTH = 50;

// A real lens also blurs what is nearer than the focus: treat those pixels as in focus, so
// that only the distance goes soft. Babylon keeps a shader already in the store.
ShaderStore.ShadersStore[circleOfConfusionPixelShader.name] = circleOfConfusionPixelShader.shader.replace(
  "#define CUSTOM_COC_PIXELDISTANCE",
  "pixelDistance=max(pixelDistance,focusDistance);",
);

/**
 * Sharp up to the focus distance, increasingly soft beyond it. Both cameras focus on the orbit
 * target, so switching keeps the focus and flying up to the model brings it closer. Glass
 * writes no depth, so it takes the blur of whatever is behind it. Press "B" to toggle, kept in
 * the URL as "?dof=off" so a reload keeps it off.
 */
export function setupDepthOfField(scene: Scene, pipeline: DefaultRenderingPipeline, orbit: ArcRotateCamera) {
  pipeline.depthOfFieldBlurLevel = DepthOfFieldEffectBlurLevel.Medium;
  pipeline.depthOfFieldEnabled = new URLSearchParams(location.search).get("dof") !== "off";

  const lens = pipeline.depthOfField;
  lens.focalLength = FOCAL_LENGTH;

  scene.onBeforeRenderObservable.add(() => {
    const camera = scene.activeCamera!;
    const distance = Vector3.Distance(camera.position, orbit.target);
    const focus = 1000 * (camera === orbit ? distance : Math.max(distance, MIN_FLY_FOCUS));
    lens.focusDistance = focus;
    // Solved from the effect's blur at infinity, (lensSize / fStop) * f / (focus - f):
    // the blur stays the same at any zoom instead of fading as the focus moves away.
    lens.fStop = (lens.lensSize * FOCAL_LENGTH) / (MAX_BLUR * (focus - FOCAL_LENGTH));
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "b" && e.key !== "B") return;
    pipeline.depthOfFieldEnabled = !pipeline.depthOfFieldEnabled;
    setUrlParam("dof", pipeline.depthOfFieldEnabled ? null : "off");
  });
}
