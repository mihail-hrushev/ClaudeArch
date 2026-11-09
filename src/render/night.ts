import type { Scene } from "@babylonjs/core/scene";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import type { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import type { GridMaterial } from "@babylonjs/materials/grid/gridMaterial";
import type { ShadowOnlyMaterial } from "@babylonjs/materials/shadowOnly/shadowOnlyMaterial";
import type { Element, Model } from "../fem/types";

/**
 * Night mode: a dark starry sky with a low moon, warm interior spot lights with soft shadows
 * placed from the model geometry, unshadowed bulbs and column spots filling the interior, fake
 * floor-bounce lights (there is no GI), glowing light fixtures reflected by the glass, and
 * post-processing tuned for a dark scene. Everything is created lazily on the first `enable()`,
 * so the day scene is untouched until night mode is used.
 *
 * API (see createEnvironment, which wires it to `?mode=night` and the "N" key):
 *   const night = createNightMode(rig);
 *   night.addModel(meshes, model)   registers the model meshes and places the interior lights
 *                                   from the model elements (column lines, domes, wall columns)
 *   night.addShadowCasters(meshes)  meshes added later (decoration layers) cast and receive the
 *                                   night shadows; meshes created after addModel are picked up
 *                                   automatically through scene.onNewMeshAddedObservable
 *   night.enable() / night.disable() / night.enabled
 * Still-image quality is the priority: shadow maps are 2048², PCF high, the reflection probe
 * refreshes every third frame, MSAA 8 + FXAA. Frame rate is not a goal in night mode.
 */
export interface NightMode {
  readonly enabled: boolean;
  enable(): void;
  /** Restores every setting it changed; the caller re-applies its own day preset afterwards. */
  disable(): void;
  addModel(meshes: Mesh[], model?: Model): void;
  addShadowCasters(meshes: AbstractMesh[]): void;
}

/** Handles of the day environment that night mode overrides. */
export interface NightRig {
  scene: Scene;
  hemi: HemisphericLight;
  /** The day sun, reused as the moon. */
  sun: DirectionalLight;
  sunShadows: ShadowGenerator;
  skybox: Mesh;
  pipeline: DefaultRenderingPipeline;
  /** Ground slab under the grid and the shadow catcher on top. */
  base: Mesh;
  baseMat: StandardMaterial;
  grid: GridMaterial;
  catcherMat: ShadowOnlyMaterial;
}

const DEG = Math.PI / 180;

/** Night look. Colours are linear, before ACES tone mapping. */
const NIGHT = {
  moon: { elevation: 34, azimuth: 70, color: new Color3(0.6, 0.7, 0.98), intensity: 0.62 },
  /** Cool sky fill from above, warm bounce from the lit floors below (lights the deck undersides). */
  hemi: { sky: new Color3(0.26, 0.36, 0.6), ground: new Color3(0.16, 0.11, 0.07), intensity: 0.38 },
  sky: { zenith: new Color3(0.006, 0.009, 0.024), horizon: new Color3(0.045, 0.055, 0.095), glow: new Color3(0.14, 0.08, 0.04) },
  fog: new Color3(0.012, 0.015, 0.028),
  fogDensity: 0.00012,
  /** Ground albedo (only the light changes at night) and the grid drawn over it. */
  ground: new Color3(0.3, 0.3, 0.28),
  gridBack: new Color3(0.03, 0.03, 0.035),
  gridLine: new Color3(0.11, 0.12, 0.14),
  /** Warm interior light: ~2700 K. */
  warm: new Color3(1, 0.74, 0.46),
  exposure: 1.35,
  contrast: 1.12,
};

/** Spot light shadows: 2048² PCF high; bias tuned for the thin frame members (cm units). */
const SHADOW_MAP = 2048;
const SPOT_BIAS = 0.0012;
const SPOT_NORMAL_BIAS = 1.2;
/** Lamp heights, in scene units. */
const COLUMN_SPOT_HEIGHT = 550;
const DOME_LAMP_HEIGHT = 120;
const WASHER_HEIGHT = 25;
/** Upper bound on the shadowed spot lights, before the per-mesh shader budget below. */
const MAX_SPOTS = 15;
/** Unshadowed fill: bulbs under the walk-floor bays and in the ambulatory, spots on the tower columns. */
const DECK_BULB_HEIGHT = 250;
const UPPER_BULB_HEIGHT = 500;
const MAX_UPPER_BULBS = 6;
const TOWER_SPOT_HEIGHT = 380;
const MAX_TOWER_SPOTS = 10;
/** Fake bounce: dim, short-range points just above the lit floors. */
const BOUNCE_ABOVE_FLOOR = 18;
const MAX_DECK_BOUNCES = 10;
/** Night-only emissive tint of the walk-floor tiles (cream opaque plates), as a share of their colour. */
const FLOOR_EMISSIVE = 0.035;

/** One night light: a spot or a bulb, shadowed or not, with an optional glowing fixture. */
type Lamp = { light: SpotLight | PointLight; shadows: ShadowGenerator | null; fixture: Mesh | null; glassLit: boolean };

interface Placement {
  /** Tower columns carrying a walk-floor line: lamp at the column, aimed outwards along the beam. */
  columns: { at: Vector3; outward: Vector3 }[];
  /** Dome centres (plan position, apex height, dome base height). */
  domes: { centre: Vector3; apex: number; base: number }[];
  /** Ground-wall columns: plan position and the inward direction. */
  walls: { at: Vector3; inward: Vector3 }[];
  /** Walk-floor bays: centre of each deck surface (at the deck height). */
  decks: { at: Vector3 }[];
  /** Tower column feet with the direction away from their tower into the ambulatory, and the top height. */
  towerColumns: { at: Vector3; outward: Vector3; top: number }[];
}

const pointsOf = (el: Element): readonly (readonly number[])[] =>
  el.kind === "plate" ? el.corners : el.kind === "polyline" ? el.nodes : [el.start, el.end];
const v3 = (p: readonly number[]) => new Vector3(p[0], p[1], p[2]);

/** Reads lamp positions out of the model: column lines of the walk floor, domes and wall columns. */
function placeLamps(model: Model): Placement {
  const columns: Placement["columns"] = [];
  const walls: Placement["walls"] = [];
  const towerColumns: Placement["towerColumns"] = [];
  const domes = new Map<string, { min: Vector3; max: Vector3 }>();
  const decks = new Map<string, { min: Vector3; max: Vector3 }>();
  const grow = (box: { min: Vector3; max: Vector3 }, el: Element) => {
    for (const p of pointsOf(el)) {
      box.min.minimizeInPlaceFromFloats(p[0], p[1], p[2]);
      box.max.maximizeInPlaceFromFloats(p[0], p[1], p[2]);
    }
    return box;
  };
  const emptyBox = () => ({ min: new Vector3(1e9, 1e9, 1e9), max: new Vector3(-1e9, -1e9, -1e9) });
  let plan = Vector3.Zero();
  let count = 0;
  for (const el of model.elements) {
    const id = el.id.slice(el.id.lastIndexOf("/") + 1);
    const dome = /\/tower(\d+)_side\d+_dome\//.exec(el.id);
    const deck = /\/walk_deck(\d+)(\/|$)/.exec(el.id);
    if (dome) {
      domes.set(dome[1], grow(domes.get(dome[1]) ?? emptyBox(), el));
    } else if (deck) {
      decks.set(deck[1], grow(decks.get(deck[1]) ?? emptyBox(), el));
    } else if (el.kind === "straight" && /^column_-?\d+_-?\d+$/.test(id)) {
      const low = el.start[2] <= el.end[2] ? el.start : el.end;
      const high = low === el.start ? el.end : el.start;
      towerColumns.push({ at: v3(low), outward: Vector3.Zero(), top: high[2] });
    } else if (el.kind === "straight" && /^floor_beam_column_-?\d+_-?\d+$/.test(id)) {
      // From the tower column (start) out to the ground wall column (end).
      const a = v3(el.start);
      const b = v3(el.end);
      const outward = b.subtract(a);
      outward.z = 0;
      columns.push({ at: a, outward: outward.normalize() });
    } else if (el.kind === "straight" && /^wall_column_\d+(_\d+)?$/.test(id)) {
      const foot = v3(el.start[2] <= el.end[2] ? el.start : el.end);
      walls.push({ at: foot, inward: Vector3.Zero() });
    }
    for (const p of pointsOf(el)) {
      plan.addInPlaceFromFloats(p[0], p[1], 0);
      count++;
    }
  }
  plan = count ? plan.scale(1 / count) : plan;
  for (const w of walls) {
    const inward = plan.subtract(w.at);
    inward.z = 0;
    w.inward = inward.normalize();
  }
  const domeList = [...domes.values()].map((b) => ({
    centre: new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, 0),
    apex: b.max.z,
    base: b.min.z,
  }));
  // Columns shared by two towers (equidistant from both centres) have no clear outward side.
  const aimed: Placement["towerColumns"] = [];
  for (const c of towerColumns) {
    const foot = new Vector3(c.at.x, c.at.y, 0);
    const byDistance = [...domeList].sort((a, b) => Vector3.Distance(foot, a.centre) - Vector3.Distance(foot, b.centre));
    if (byDistance.length === 0) continue;
    if (byDistance.length > 1 && Vector3.Distance(foot, byDistance[1].centre) - Vector3.Distance(foot, byDistance[0].centre) < 50) continue;
    aimed.push({ ...c, outward: foot.subtract(byDistance[0].centre).normalize() });
  }
  return {
    columns,
    walls,
    domes: domeList,
    decks: [...decks.values()].map((b) => ({ at: new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z) })),
    towerColumns: aimed,
  };
}

/** Drops the most crowded entries until at most `budget` remain, keeping them spread out. */
function thin<T extends { at: Vector3 }>(items: T[], budget: number): T[] {
  const kept = [...items];
  while (kept.length > Math.max(0, budget)) {
    let worst = 0;
    let worstDistance = Infinity;
    for (let i = 0; i < kept.length; i++) {
      let nearest = Infinity;
      for (let j = 0; j < kept.length; j++) if (i !== j) nearest = Math.min(nearest, Vector3.Distance(kept[i].at, kept[j].at));
      if (nearest < worstDistance) {
        worstDistance = nearest;
        worst = i;
      }
    }
    kept.splice(worst, 1);
  }
  return kept;
}

/** Wall washers: the two end walls (±X) and the middle of the front wall (−Y). */
function pickWashers(walls: Placement["walls"]): Placement["walls"] {
  if (walls.length === 0) return [];
  const by = (score: (w: Placement["walls"][number]) => number) => walls.reduce((best, w) => (score(w) > score(best) ? w : best));
  const picks = [by((w) => w.at.x), by((w) => -w.at.x), by((w) => -w.at.y - Math.abs(w.at.x) * 0.5)];
  return picks.filter((w, i) => picks.indexOf(w) === i);
}

const nightSkyVertex = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const nightSkyFragment = `
precision highp float;
varying vec3 vDir;
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 glow;
uniform vec3 moonDir;
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.z;
  vec3 c = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.5));
  // Faint warm glow along the horizon, a little stronger towards the front (-Y).
  c += glow * exp(-max(h, 0.0) * 9.0) * (0.6 - 0.4 * d.y);
  // Below the horizon: fade into the ground fog.
  c = mix(c, horizon * 0.5, clamp(-h * 6.0, 0.0, 1.0));
  // Moon disc and halo.
  float m = dot(d, moonDir);
  c += vec3(0.95, 0.95, 0.9) * smoothstep(0.99975, 0.9999, m);
  c += vec3(0.25, 0.3, 0.42) * 0.5 * pow(max(m, 0.0), 300.0);
  // Stars: one hash per angular cell, only the brightest cells light up.
  float s = hash(floor(d * 420.0));
  c += vec3(0.55) * smoothstep(0.9965, 1.0, s) * clamp(h * 4.0, 0.0, 1.0);
  gl_FragColor = vec4(c, 1.0);
}`;

/** Unit vector pointing from the scene towards the moon (Z up). */
function moonVector(): Vector3 {
  const el = NIGHT.moon.elevation * DEG;
  const az = NIGHT.moon.azimuth * DEG;
  return new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
}

export function createNightMode(rig: NightRig): NightMode {
  const { scene, hemi, sun, sunShadows, skybox, pipeline, base, baseMat, grid, catcherMat } = rig;
  const ip = pipeline.imageProcessing;

  /**
   * Shader budget per mesh. Every shadowed light costs one texture unit and 1¼ varying vectors
   * (uniform buffers are disabled, see createScene, so uniform blocks are no limit). One unit is
   * kept for the moon; the glass keeps one for its reflection cube, so the washers leave it out.
   */
  const caps = scene.getEngine().getCaps();
  const shadowedBudget = Math.min(MAX_SPOTS + 1, caps.maxTexturesImageUnits - 1, Math.floor((caps.maxVaryingVectors - 8) * 0.8));
  const spotBudget = Math.max(1, shadowedBudget - 1);

  let enabled = false;
  let scaffolded = false;
  let model: Model | undefined;
  const glass = new Set<AbstractMesh>();
  /** Every mesh that casts and receives the night shadows (model + later layers). */
  const casters = new Set<AbstractMesh>();
  const own = new Set<AbstractMesh>();
  const receivedBefore = new Map<AbstractMesh, boolean>();
  const reflectionBefore = new Map<StandardMaterial | PBRMaterial, BaseTexture | null>();
  const lamps: Lamp[] = [];
  const spots = () => lamps.filter((l) => l.shadows);
  /** Opaque cream plates (walk-floor tiles): faintly emissive at night, as if lit from above. */
  const floorEmissiveBefore = new Map<StandardMaterial, Color3>();
  let sky: ShaderMaterial | null = null;
  let probe: ReflectionProbe | null = null;
  let glowLayer: GlowLayer | null = null;
  let fixtureMat: StandardMaterial | null = null;

  const generators = () => [sunShadows, ...lamps.flatMap((l) => (l.shadows ? [l.shadows] : []))];

  // --- Casters: the model, plus meshes other layers add later ---
  const pending: AbstractMesh[] = [];
  scene.onNewMeshAddedObservable.add((mesh) => {
    if (own.has(mesh) || mesh.name.startsWith("axes")) return;
    pending.push(mesh); // material is assigned after construction: register before the next frame
  });
  scene.onBeforeRenderObservable.add(() => {
    if (pending.length === 0) return;
    const added = pending.splice(0).filter((m) => m.material && !casters.has(m));
    if (added.length) register(added);
  });

  function register(meshes: AbstractMesh[]) {
    for (const mesh of meshes) {
      if (own.has(mesh)) continue;
      casters.add(mesh);
      if ((mesh.material instanceof StandardMaterial || mesh.material instanceof PBRMaterial) && mesh.material.alpha < 1) glass.add(mesh);
    }
    if (enabled && lamps.length) attachCasters(meshes);
  }

  /** Makes meshes cast and receive the night shadows and lets their material take all the lights. */
  function attachCasters(meshes: AbstractMesh[]) {
    const lights = lamps.length + 2; // + moon + hemispheric
    for (const mesh of meshes) {
      if (!casters.has(mesh)) continue;
      for (const gen of generators()) gen.addShadowCaster(mesh);
      if (!receivedBefore.has(mesh)) receivedBefore.set(mesh, mesh.receiveShadows);
      mesh.receiveShadows = true;
      const mat = mesh.material as (Material & { maxSimultaneousLights?: number }) | null;
      if (mat && typeof mat.maxSimultaneousLights === "number") mat.maxSimultaneousLights = Math.max(mat.maxSimultaneousLights, lights);
      if (glass.has(mesh)) {
        for (const l of lamps) if (!l.glassLit && !l.light.excludedMeshes.includes(mesh)) l.light.excludedMeshes.push(mesh);
      } else {
        if (mat instanceof StandardMaterial && mesh.name.includes(":plate|") && mat.diffuseColor.r > 0.8 && !floorEmissiveBefore.has(mat)) {
          floorEmissiveBefore.set(mat, mat.emissiveColor.clone());
          mat.emissiveColor = mat.diffuseColor.scale(FLOOR_EMISSIVE);
        }
        if (!probe!.renderList!.includes(mesh)) probe!.renderList!.push(mesh); // opaque only: the glass samples the probe itself
      }
    }
    for (const gen of generators()) gen.getShadowMap()?.resetRefreshCounter();
  }

  function detachCasters() {
    for (const mesh of casters) {
      for (const l of lamps) l.shadows?.removeShadowCaster(mesh);
      const before = receivedBefore.get(mesh);
      if (before !== undefined) mesh.receiveShadows = before;
    }
    receivedBefore.clear();
    for (const l of lamps) l.light.excludedMeshes.length = 0;
    for (const [mat, color] of floorEmissiveBefore) mat.emissiveColor = color;
    floorEmissiveBefore.clear();
  }

  // --- Lights, fixtures, probe, glow: built once, from the model ---
  /** Small emissive body, picked up by the glow layer and the reflection probe. */
  function fixture(name: string, position: Vector3, shape: "sphere" | "disc", size: number): Mesh {
    const mesh = shape === "disc"
      ? MeshBuilder.CreateCylinder(`${name}_fixture`, { diameter: size, height: size * 0.55, tessellation: 24 }, scene)
      : MeshBuilder.CreateSphere(`${name}_fixture`, { diameter: size, segments: 12 }, scene);
    own.add(mesh);
    if (shape === "disc") mesh.rotation.x = Math.PI / 2; // cylinder axis along Z
    mesh.position = position;
    mesh.material = fixtureMat;
    mesh.isPickable = false;
    glowLayer?.addIncludedOnlyMesh(mesh);
    return mesh;
  }

  /** Unshadowed warm bulb (costs no texture unit); `size` 0 = no visible fixture (fake bounce). */
  function bulb(name: string, position: Vector3, intensity: number, range: number, size: number, glassLit: boolean): Lamp {
    const light = new PointLight(name, position, scene);
    light.diffuse = NIGHT.warm;
    light.specular = NIGHT.warm.scale(0.15);
    light.intensity = intensity;
    light.range = range;
    return { light, shadows: null, fixture: size > 0 ? fixture(name, position, "sphere", size) : null, glassLit };
  }

  function spot(name: string, position: Vector3, direction: Vector3, angle: number, exponent: number, intensity: number, range: number, glassLit: boolean, shadowed = true): Lamp {
    const light = new SpotLight(name, position, direction.normalize(), angle, exponent, scene);
    light.diffuse = NIGHT.warm;
    light.specular = NIGHT.warm.scale(0.25); // glass panes saturate quickly
    light.intensity = intensity;
    light.range = range;
    light.shadowMinZ = 15;
    light.shadowMaxZ = range;
    // Fixture: a small emissive body just behind the light.
    const body = fixture(name, position.subtract(direction.normalize().scale(8)), angle > 1.6 ? "disc" : "sphere", angle > 1.6 ? 18 : 14);
    if (!shadowed) return { light, shadows: null, fixture: body, glassLit };
    const shadows = new ShadowGenerator(SHADOW_MAP, light);
    shadows.usePercentageCloserFiltering = true;
    shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    shadows.bias = SPOT_BIAS;
    shadows.normalBias = SPOT_NORMAL_BIAS;
    shadows.darkness = 0.12;
    shadows.transparencyShadow = true; // glass casts a faint tinted shadow, as in daylight
    shadows.getShadowMap()!.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

    return { light, shadows, fixture: body, glassLit };
  }

  function scaffold() {
    scaffolded = true;
    fixtureMat = new StandardMaterial("night_fixture", scene);
    fixtureMat.disableLighting = true;
    fixtureMat.emissiveColor = new Color3(1, 0.86, 0.66);
    fixtureMat.diffuseColor = Color3.Black();
    fixtureMat.specularColor = Color3.Black();

    glowLayer = new GlowLayer("night_glow", scene, { mainTextureSamples: 4, blurKernelSize: 32, mainTextureRatio: 0.5 });
    glowLayer.intensity = 0.6;

    sky = new ShaderMaterial("night_sky", scene, { vertexSource: nightSkyVertex, fragmentSource: nightSkyFragment }, {
      attributes: ["position"],
      uniforms: ["worldViewProjection", "zenith", "horizon", "glow", "moonDir"],
    });
    sky.backFaceCulling = false;
    sky.fogEnabled = false;
    sky.setColor3("zenith", NIGHT.sky.zenith);
    sky.setColor3("horizon", NIGHT.sky.horizon);
    sky.setColor3("glow", NIGHT.sky.glow);
    sky.setVector3("moonDir", moonVector());

    // Glass reflections: the probe sits inside the building and sees the lit interior.
    probe = new ReflectionProbe("night_probe", 512, scene, true, true);
    probe.position = new Vector3(0, 0, 600);
    probe.refreshRate = 3; // six faces with every light: every third frame keeps it interactive
    probe.renderList!.push(skybox);
  }

  /** Places the interior lights from the model; needs the model, so it may run after enable(). */
  function buildLights() {
    const placement = placeLamps(model!);
    // Priority: the three domes, then the column lines (at least 9), then the wall washers.
    const domes = placement.domes;
    const washers = pickWashers(placement.walls).slice(0, Math.max(0, Math.min(3, spotBudget - domes.length - 9)));
    const columns = thin(placement.columns, spotBudget - domes.length - washers.length);

    for (const [i, d] of domes.entries()) {
      // Up-light at the tower centre, aimed at the apex: the dome ribs and glass glow from inside.
      const at = new Vector3(d.centre.x, d.centre.y, DOME_LAMP_HEIGHT);
      const halfWidth = Math.max(d.apex - d.base, 300);
      const angle = 2 * Math.atan(halfWidth / (d.base - DOME_LAMP_HEIGHT));
      lamps.push(spot(`night_dome_${i}`, at, new Vector3(0, 0, 1), Math.min(angle, 1.5), 1.5, 2.6, (d.apex - DOME_LAMP_HEIGHT) * 1.6, true));
    }
    for (const [i, c] of columns.entries()) {
      // Down-light at the column near the eaves, a little out along the floor beam, tilted outwards:
      // lights the walk floor and the ground of the ambulatory below.
      const at = c.at.add(c.outward.scale(45));
      at.z = COLUMN_SPOT_HEIGHT;
      const dir = new Vector3(0, 0, -1).add(c.outward.scale(0.2));
      lamps.push(spot(`night_column_${i}`, at, dir, 2.2, 2, 3.8, 1900, true));
    }
    for (const [i, w] of washers.entries()) {
      // Low washer just inside a wall column, grazing up the glass wall and the eaves beam.
      const at = w.at.add(w.inward.scale(95));
      at.z = WASHER_HEIGHT;
      const dir = new Vector3(0, 0, 1).subtract(w.inward.scale(0.35));
      lamps.push(spot(`night_washer_${i}`, at, dir, 1.6, 2, 1.8, 1100, false));
    }

    // --- Unshadowed fill (no texture units: only uniforms) ---
    // A bulb under every walk-floor bay lights the ground level of the ambulatory.
    for (const [i, d] of placement.decks.entries()) {
      lamps.push(bulb(`night_deck_bulb_${i}`, new Vector3(d.at.x, d.at.y, DECK_BULB_HEIGHT), 0.45, 520, 9, false));
    }
    // A few bulbs above the walk floor and one in each tower under the dome.
    const upper = thin(placement.decks, MAX_UPPER_BULBS);
    for (const [i, d] of upper.entries()) {
      lamps.push(bulb(`night_upper_bulb_${i}`, new Vector3(d.at.x, d.at.y, UPPER_BULB_HEIGHT), 0.4, 650, 10, false));
    }
    for (const [i, d] of domes.entries()) {
      lamps.push(bulb(`night_tower_bulb_${i}`, new Vector3(d.centre.x, d.centre.y, UPPER_BULB_HEIGHT), 0.5, 950, 12, true));
    }
    // Spots on the tower columns at walk-floor level, aimed out into the ambulatory, wide cone.
    const towerSpots = thin(placement.towerColumns, MAX_TOWER_SPOTS);
    for (const [i, c] of towerSpots.entries()) {
      const at = c.at.add(c.outward.scale(14));
      at.z = Math.min(TOWER_SPOT_HEIGHT, c.top - 50);
      const dir = c.outward.add(new Vector3(0, 0, -0.35));
      lamps.push(spot(`night_tower_spot_${i}`, at, dir, 2.4, 1.5, 0.9, 1300, false, false));
    }

    // --- Fake bounce: dim, short-range, no fixture, just above the lit floors ---
    for (const [i, d] of thin(placement.decks, MAX_DECK_BOUNCES).entries()) {
      lamps.push(bulb(`night_bounce_deck_${i}`, new Vector3(d.at.x, d.at.y, d.at.z + BOUNCE_ABOVE_FLOOR), 0.28, 380, 0, false));
    }
    for (const [i, d] of domes.entries()) {
      lamps.push(bulb(`night_bounce_ground_${i}`, new Vector3(d.centre.x, d.centre.y, BOUNCE_ABOVE_FLOOR), 0.3, 520, 0, false));
    }

    for (const l of lamps) if (l.fixture) probe!.renderList!.push(l.fixture);
    const bulbs = lamps.filter((l) => l.light instanceof PointLight && l.fixture).length;
    const bounces = lamps.filter((l) => l.light instanceof PointLight && !l.fixture).length;
    console.info(
      `night mode: ${lamps.length} lights: ${spots().length} shadowed spots (${domes.length} dome, ${columns.length} column, ${washers.length} washer, budget ${spotBudget}), ` +
        `${towerSpots.length} tower-column spots, ${bulbs} bulbs, ${bounces} bounce lights`,
    );
  }

  /** Switches the glass reflections to the night probe. */
  function reflectInterior() {
    for (const mesh of glass) {
      const mat = mesh.material as StandardMaterial | PBRMaterial;
      if (!reflectionBefore.has(mat)) reflectionBefore.set(mat, mat.reflectionTexture);
      mat.reflectionTexture = probe!.cubeTexture;
    }
  }

  // --- Mode switch ---
  const saved = {
    samples: 0, fxaa: false, bloom: false, bloomThreshold: 0, bloomWeight: 0, bloomKernel: 0, bloomScale: 0, contrast: 0, vignetteOn: false, vignette: 0,
    skyMaterial: null as Material | null, shadowDarkness: 0, shadowQuality: 0, shadowBias: 0, shadowNormalBias: 0,
    baseReceives: false, catcherLight: catcherMat.activeLight, catcherAlpha: 0, fogDensity: 0, gridLine: grid.lineColor,
  };

  function enable() {
    if (enabled) return;
    enabled = true;
    if (!scaffolded) scaffold();
    if (!lamps.length && model) buildLights();

    Object.assign(saved, {
      samples: pipeline.samples, fxaa: pipeline.fxaaEnabled, bloom: pipeline.bloomEnabled, bloomThreshold: pipeline.bloomThreshold, bloomWeight: pipeline.bloomWeight,
      bloomKernel: pipeline.bloomKernel, bloomScale: pipeline.bloomScale, contrast: ip.contrast, vignetteOn: ip.vignetteEnabled, vignette: ip.vignetteWeight,
      skyMaterial: skybox.material, shadowDarkness: sunShadows.darkness, shadowQuality: sunShadows.filteringQuality,
      shadowBias: sunShadows.bias, shadowNormalBias: sunShadows.normalBias, baseReceives: base.receiveShadows,
      catcherLight: catcherMat.activeLight, catcherAlpha: catcherMat.alpha, fogDensity: scene.fogDensity, gridLine: grid.lineColor,
    });

    // Moon: weak, cool, low, soft-shadowed.
    const toMoon = moonVector();
    sun.direction = toMoon.negate();
    sun.position = toMoon.scale(3000);
    sun.diffuse = NIGHT.moon.color;
    sun.specular = NIGHT.moon.color;
    sun.intensity = NIGHT.moon.intensity;
    sunShadows.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    sunShadows.darkness = 0.55;
    sunShadows.getShadowMap()?.resetRefreshCounter();

    hemi.diffuse = NIGHT.hemi.sky;
    hemi.groundColor = NIGHT.hemi.ground;
    hemi.intensity = NIGHT.hemi.intensity;

    skybox.material = sky;
    scene.fogColor = NIGHT.fog;
    scene.fogDensity = NIGHT.fogDensity;
    scene.clearColor = new Color4(NIGHT.fog.r, NIGHT.fog.g, NIGHT.fog.b, 1);
    baseMat.diffuseColor = NIGHT.ground;
    grid.mainColor = NIGHT.gridBack;
    grid.lineColor = NIGHT.gridLine;
    base.receiveShadows = true; // pools of light under the lamps get the shadows of the structure
    catcherMat.activeLight = sun;
    catcherMat.alpha = 0.2;

    // Post-processing for a dark scene: bloom on fixtures and highlights, MSAA 8 + FXAA, more contrast.
    pipeline.samples = 8;
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.55;
    pipeline.bloomWeight = 0.4;
    pipeline.bloomKernel = 64;
    pipeline.bloomScale = 0.5;
    ip.exposure = NIGHT.exposure;
    ip.contrast = NIGHT.contrast;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 2.4;

    for (const l of lamps) {
      l.light.setEnabled(true);
      l.fixture?.setEnabled(true);
    }
    if (glowLayer) glowLayer.isEnabled = true;
    reflectInterior();
    if (lamps.length) attachCasters([...casters]);
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    detachCasters();
    for (const l of lamps) {
      l.light.setEnabled(false);
      l.fixture?.setEnabled(false);
    }
    if (glowLayer) glowLayer.isEnabled = false;
    if (probe?.renderList) probe.renderList.length = 0;
    probe?.renderList?.push(skybox);
    for (const [mat, texture] of reflectionBefore) mat.reflectionTexture = texture;
    reflectionBefore.clear();

    skybox.material = saved.skyMaterial;
    pipeline.samples = saved.samples;
    pipeline.fxaaEnabled = saved.fxaa;
    pipeline.bloomEnabled = saved.bloom;
    pipeline.bloomThreshold = saved.bloomThreshold;
    pipeline.bloomWeight = saved.bloomWeight;
    pipeline.bloomKernel = saved.bloomKernel;
    pipeline.bloomScale = saved.bloomScale;
    ip.contrast = saved.contrast;
    ip.vignetteEnabled = saved.vignetteOn;
    ip.vignetteWeight = saved.vignette;
    sunShadows.darkness = saved.shadowDarkness;
    sunShadows.filteringQuality = saved.shadowQuality;
    sunShadows.bias = saved.shadowBias;
    sunShadows.normalBias = saved.shadowNormalBias;
    base.receiveShadows = saved.baseReceives;
    catcherMat.activeLight = saved.catcherLight;
    catcherMat.alpha = saved.catcherAlpha;
    scene.fogDensity = saved.fogDensity;
    grid.lineColor = saved.gridLine;
    // Sun, sky, fog colour, ground colour and exposure: the caller re-applies its day preset.
  }

  return {
    get enabled() {
      return enabled;
    },
    enable,
    disable,
    addModel(meshes, m) {
      model = m ?? model;
      register(meshes);
      if (enabled && !lamps.length && model) {
        // Enabled before the model arrived (?mode=night): place the lights now.
        buildLights();
        reflectInterior();
        attachCasters([...casters]);
      }
    },
    addShadowCasters(meshes) {
      register(meshes);
    },
  };
}
