/**
 * The orbit camera in the URL: `?cam=<alpha>,<beta>,<radius>,<x>,<y>,<z>` (angles in degrees,
 * lengths in scene units). Read once at start-up, rewritten in place while the camera moves, so a
 * reload (or Vite reloading after an edit) keeps the view.
 */
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { setUrlParam } from "./urlState";

const PARAM = "cam";
/** Quiet time after the last camera move before the URL is rewritten. */
const WRITE_DELAY_MS = 250;

const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Sets the camera from the URL, if it holds a valid view; true when it did. */
export function restoreCameraFromUrl(camera: ArcRotateCamera): boolean {
  const raw = new URLSearchParams(location.search).get(PARAM);
  const v = raw?.split(",").map(Number);
  if (!v || v.length !== 6 || v.some((n) => !Number.isFinite(n))) return false;
  const [alpha, beta, radius, x, y, z] = v;
  camera.target = new Vector3(x, y, z);
  camera.alpha = rad(alpha);
  camera.beta = rad(beta);
  camera.radius = radius;
  if (camera.upperRadiusLimit !== null && radius > camera.upperRadiusLimit) camera.upperRadiusLimit = radius;
  return true;
}

/** Keeps `?cam=` in step with the camera, without adding browser history entries. */
export function trackCameraInUrl(camera: ArcRotateCamera): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    const t = camera.target;
    const value = [deg(camera.alpha).toFixed(2), deg(camera.beta).toFixed(2), camera.radius.toFixed(1), t.x.toFixed(1), t.y.toFixed(1), t.z.toFixed(1)].join(",");
    setUrlParam(PARAM, value);
  };
  camera.onViewMatrixChangedObservable.add(() => {
    clearTimeout(timer);
    timer = setTimeout(write, WRITE_DELAY_MS);
  });
}
