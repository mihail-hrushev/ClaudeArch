import type { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

export interface SpectatorOptions {
  /** Base speed in scene units per second (default 500). */
  readonly speed?: number;
  /** Mouse look sensitivity in radians per pixel (default 0.0025). */
  readonly sensitivity?: number;
}

export interface Spectator {
  readonly camera: FreeCamera;
  /** True while the first-person camera is active. */
  readonly active: () => boolean;
  /** Switch between the orbit camera and the first-person camera. */
  toggle(): void;
}

const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyQ", "Space", "ControlLeft", "ShiftLeft", "ShiftRight"];
const FOV_KEYS = ["KeyR", "KeyV"];
const FOV_STEP = 0.05; // radians per tick
const FOV_TICK_MS = 50; // 20 ticks per second
const FOV_MIN = 0.1;
const FOV_MAX = 2.8;

/**
 * First-person spectator (fly) camera for the Z-up scene, toggled with "C".
 *  - W / S: forward / back along the view direction, A / D: strafe
 *  - E or Space: up, Q or Ctrl: down (world Z)
 *  - Shift: 4× speed, [ / ]: lower / raise the base speed (starts at 500)
 *  - Mouse: click the canvas to capture the pointer and look around (Esc releases it);
 *    without capture, drag with the left button to look.
 * In both cameras, hold R / V to widen / narrow the field of view (shared between them).
 * Keys are matched by physical position (KeyboardEvent.code), so they work on any layout.
 * Entering starts at the orbit camera's view; leaving hands the current view back to it.
 */
export function createSpectator(
  scene: Scene,
  canvas: HTMLCanvasElement,
  orbit: ArcRotateCamera,
  opts: SpectatorOptions = {},
): Spectator {
  const camera = new FreeCamera("spectator", orbit.position.clone(), scene, false);
  camera.inputs.clear(); // input is handled below (Babylon's free camera inputs assume Y up)
  camera.upVector = new Vector3(0, 0, 1);
  camera.minZ = orbit.minZ;
  camera.maxZ = orbit.maxZ;
  camera.fov = orbit.fov;

  const sensitivity = opts.sensitivity ?? 0.0025;
  let speed = opts.speed ?? 500;
  let yaw = 0; // around Z, from +X towards +Y
  let pitch = 0; // above the horizon
  let active = false;
  let dragging = false;
  const down = new Set<string>();
  const fovDown = new Set<string>(); // separate from `down`: FOV keys also work in orbit mode
  let fovElapsed = FOV_TICK_MS; // a full tick, so a key press takes effect at once

  const forward = () =>
    new Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
  const aim = () => camera.setTarget(camera.position.add(forward()));

  const look = (dx: number, dy: number) => {
    yaw -= dx * sensitivity;
    pitch = Math.max(-1.55, Math.min(1.55, pitch - dy * sensitivity));
    aim();
  };

  // Hint overlay, shown while flying.
  const hint = document.createElement("div");
  Object.assign(hint.style, {
    position: "absolute",
    left: "8px",
    bottom: "8px",
    padding: "6px 10px",
    font: "12px/1.45 ui-monospace, Consolas, monospace",
    color: "#e8eef2",
    background: "rgba(10, 12, 16, 0.55)",
    borderRadius: "4px",
    pointerEvents: "none",
    whiteSpace: "pre",
    zIndex: "10",
  } satisfies Partial<CSSStyleDeclaration>);
  hint.hidden = true;
  document.body.appendChild(hint);
  const showHint = () => {
    hint.textContent =
      `fly  WASD move · E/Space up · Q/Ctrl down · Shift fast\n` +
      `     click: capture mouse (Esc frees) · [ ]: speed ${speed.toFixed(0)} · R/V: fov ${camera.fov.toFixed(2)} · C: orbit`;
  };

  function enter() {
    const dir = orbit.target.subtract(orbit.position).normalize();
    yaw = Math.atan2(dir.y, dir.x);
    pitch = Math.asin(Math.max(-1, Math.min(1, dir.z)));
    camera.position.copyFrom(orbit.position);
    aim();
    orbit.detachControl();
    scene.activeCamera = camera;
    active = true;
    showHint();
    hint.hidden = false;
  }

  function leave() {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    // Orbit around a point ahead of the current view.
    const pos = camera.position.clone();
    orbit.setTarget(pos.add(forward().scale(Math.max(orbit.lowerRadiusLimit ?? 5, 300))));
    orbit.setPosition(pos);
    scene.activeCamera = orbit;
    orbit.attachControl(canvas, true);
    active = false;
    down.clear();
    hint.hidden = true;
  }

  const toggle = () => (active ? leave() : enter());

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyC" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggle();
      return;
    }
    if (FOV_KEYS.includes(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey) fovDown.add(e.code);
    if (!active || e.metaKey || e.altKey) return;
    if ((e.code === "BracketLeft" || e.code === "BracketRight") && !e.ctrlKey) {
      speed = Math.max(10, Math.min(5000, speed * (e.code === "BracketRight" ? 1.2 : 1 / 1.2)));
      showHint();
      return;
    }
    if (MOVE_KEYS.includes(e.code)) {
      down.add(e.code);
      e.preventDefault(); // Space scrolling, Ctrl shortcuts
    }
  });
  window.addEventListener("keyup", (e) => {
    down.delete(e.code);
    fovDown.delete(e.code);
  });
  window.addEventListener("blur", () => {
    down.clear();
    fovDown.clear();
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (!active || e.button !== 0) return;
    if (document.pointerLockElement !== canvas) {
      dragging = true;
      canvas.requestPointerLock?.();
    }
  });
  window.addEventListener("pointerup", () => (dragging = false));
  window.addEventListener("pointermove", (e) => {
    if (!active) return;
    if (document.pointerLockElement === canvas || dragging) look(e.movementX, e.movementY);
  });
  scene.onBeforeRenderObservable.add(() => {
    const direction = (fovDown.has("KeyR") ? 1 : 0) - (fovDown.has("KeyV") ? 1 : 0);
    if (direction === 0) {
      fovElapsed = FOV_TICK_MS;
      return;
    }
    fovElapsed += scene.getEngine().getDeltaTime();
    const ticks = Math.floor(fovElapsed / FOV_TICK_MS);
    if (ticks === 0) return;
    fovElapsed -= ticks * FOV_TICK_MS;
    const fov = Math.max(FOV_MIN, Math.min(FOV_MAX, camera.fov + direction * ticks * FOV_STEP));
    camera.fov = fov;
    orbit.fov = fov;
    showHint();
  });

  scene.onBeforeRenderObservable.add(() => {
    if (!active || down.size === 0) return;
    const dt = Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
    const f = forward();
    const right = new Vector3(Math.sin(yaw), -Math.cos(yaw), 0);
    const axis = (pos: string, neg: string) => (down.has(pos) ? 1 : 0) - (down.has(neg) ? 1 : 0);
    const fwd = axis("KeyW", "KeyS");
    const side = axis("KeyD", "KeyA");
    const up = (down.has("KeyE") || down.has("Space") ? 1 : 0) - (down.has("KeyQ") || down.has("ControlLeft") ? 1 : 0);
    const move = f.scale(fwd).add(right.scale(side)).add(new Vector3(0, 0, up));
    if (move.lengthSquared() === 0) return;
    const fast = down.has("ShiftLeft") || down.has("ShiftRight") ? 4 : 1;
    camera.position.addInPlace(move.normalize().scale(speed * fast * dt));
    aim();
  });

  return { camera, active: () => active, toggle };
}
