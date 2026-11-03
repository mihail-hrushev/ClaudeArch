import type { Scene } from "@babylonjs/core/scene";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";

/**
 * Top-left overlay with render stats: FPS, frame time, draw calls, triangles and meshes.
 * Draw calls include shadow map, reflection probe and post-process passes.
 * Press "F" to toggle it.
 */
export function createStatsOverlay(scene: Scene, refreshMs = 500): HTMLDivElement {
  const engine = scene.getEngine();
  const instr = new SceneInstrumentation(scene);
  instr.captureFrameTime = true;

  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "6px 10px",
    font: "12px/1.45 ui-monospace, Consolas, monospace",
    color: "#e8eef2",
    background: "rgba(10, 12, 16, 0.55)",
    borderRadius: "4px",
    pointerEvents: "none",
    whiteSpace: "pre",
    zIndex: "10",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);

  const fmt = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");
  const update = () => {
    const tris = scene.getActiveIndices() / 3;
    el.textContent =
      `FPS        ${engine.getFps().toFixed(0)}\n` +
      `frame      ${instr.frameTimeCounter.lastSecAverage.toFixed(1)} ms\n` +
      `draw calls ${fmt(instr.drawCallsCounter.current)}\n` +
      `triangles  ${fmt(Math.round(tris))}\n` +
      `meshes     ${scene.getActiveMeshes().length} / ${scene.meshes.length}`;
  };
  update();
  const timer = setInterval(update, refreshMs);
  scene.onDisposeObservable.add(() => {
    clearInterval(timer);
    instr.dispose();
    el.remove();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") el.hidden = !el.hidden;
  });
  return el;
}
