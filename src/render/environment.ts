import { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { FresnelParameters } from "@babylonjs/core/Materials/fresnelParameters";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial";
import { ShadowOnlyMaterial } from "@babylonjs/materials/shadowOnly/shadowOnlyMaterial";
import { GridMaterial } from "@babylonjs/materials/grid/gridMaterial";

/** A lighting mood: sun position plus colours tuned to match the procedural sky. */
interface LightPreset {
  name: string;
  /** Sun elevation above the horizon, degrees. */
  elevation: number;
  /** Sun azimuth from +X towards +Y, degrees. */
  azimuth: number;
  sunColor: Color3;
  sunIntensity: number;
  skyColor: Color3;
  groundColor: Color3;
  hemiIntensity: number;
  fog: Color3;
  turbidity: number;
  luminance: number;
  rayleigh: number;
  exposure: number;
}

const PRESETS: LightPreset[] = [
  {
    name: "day", elevation: 52, azimuth: 235,
    sunColor: new Color3(1, 0.97, 0.9), sunIntensity: 1.6,
    skyColor: new Color3(0.75, 0.85, 1), groundColor: new Color3(0.35, 0.33, 0.3), hemiIntensity: 0.55,
    fog: new Color3(0.72, 0.8, 0.9), turbidity: 6, luminance: 1, rayleigh: 1.6, exposure: 1.1,
  },
  {
    name: "golden hour", elevation: 14, azimuth: 205,
    sunColor: new Color3(1, 0.72, 0.42), sunIntensity: 1.9,
    skyColor: new Color3(0.6, 0.65, 0.85), groundColor: new Color3(0.35, 0.25, 0.2), hemiIntensity: 0.45,
    fog: new Color3(0.85, 0.68, 0.55), turbidity: 10, luminance: 1, rayleigh: 2.5, exposure: 1.2,
  },
  {
    name: "dusk", elevation: 3, azimuth: 190,
    sunColor: new Color3(1, 0.45, 0.25), sunIntensity: 1.3,
    skyColor: new Color3(0.35, 0.38, 0.6), groundColor: new Color3(0.18, 0.13, 0.15), hemiIntensity: 0.4,
    fog: new Color3(0.42, 0.36, 0.45), turbidity: 14, luminance: 1.05, rayleigh: 3.5, exposure: 1.35,
  },
];

const DEG = Math.PI / 180;

/** Unit vector pointing from the scene towards the sun (Z up). */
function sunVector(p: LightPreset): Vector3 {
  const el = p.elevation * DEG;
  const az = p.azimuth * DEG;
  return new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
}

export interface Environment {
  shadows: ShadowGenerator;
  /** Register model meshes: they cast shadows and glass picks up sky reflections. */
  addModel(meshes: Mesh[]): void;
  /** Switch to the next lighting preset. */
  cycle(): void;
}

/**
 * Sky, sun, shadows, fog and post-processing for a right-handed, Z-up scene.
 * Press "L" to cycle the lighting presets; "?light=dusk" etc. selects the initial one.
 */
export function createEnvironment(scene: Scene, camera: Camera): Environment {
  // --- Lights ---
  const hemi = new HemisphericLight("hemi", new Vector3(0, 0, 1), scene);
  const sun = new DirectionalLight("sun", new Vector3(0, 0, -1), scene);
  sun.autoCalcShadowZBounds = true;

  // --- Sky dome ---
  const sky = new SkyMaterial("sky", scene);
  sky.backFaceCulling = false;
  sky.up = new Vector3(0, 0, 1);
  sky.useSunPosition = true;
  sky.mieDirectionalG = 0.85;
  sky.mieCoefficient = 0.006;
  sky.dithering = true;
  sky.fogEnabled = false;
  const skybox = MeshBuilder.CreateBox("skybox", { size: 9000, sideOrientation: 1 }, scene);
  skybox.material = sky;
  skybox.infiniteDistance = true;
  skybox.isPickable = false;

  // --- Ground: a soft-coloured slab, the engineering grid and a shadow catcher on top ---
  const groundSize = 8000;
  const base = MeshBuilder.CreateGround("ground_base", { width: groundSize, height: groundSize }, scene);
  base.rotation.x = Math.PI / 2;
  base.position.z = -5; // well below the grid: avoids z-fighting at long camera distances
  base.isPickable = false;
  const baseMat = new StandardMaterial("ground_base", scene);
  baseMat.specularColor = Color3.Black();
  base.material = baseMat;
  base.receiveShadows = true;

  const ground = MeshBuilder.CreateGround("ground", { width: 1000, height: 1000 }, scene);
  ground.rotation.x = Math.PI / 2;
  ground.position.z = -1.5;
  ground.isPickable = false;
  const grid = new GridMaterial("grid", scene);
  grid.lineColor = new Color3(0.55, 0.58, 0.6);
  grid.gridRatio = 10;
  grid.majorUnitFrequency = 5;
  grid.minorUnitVisibility = 0.35;
  grid.opacity = 0.6; // < 1: only the lines are drawn over the base slab
  grid.backFaceCulling = false;
  ground.material = grid;

  const catcher = MeshBuilder.CreateGround("shadow_catcher", { width: groundSize, height: groundSize }, scene);
  catcher.rotation.x = Math.PI / 2;
  catcher.isPickable = false;
  const catcherMat = new ShadowOnlyMaterial("shadow_catcher", scene);
  catcherMat.activeLight = sun;
  catcherMat.alpha = 0.45;
  catcher.material = catcherMat;
  catcher.receiveShadows = true;

  // --- Shadows ---
  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.02;
  shadows.darkness = 0.15;
  shadows.transparencyShadow = true;

  // --- Sky reflections for glass ---
  const probe = new ReflectionProbe("sky_probe", 256, scene, true, true);
  probe.renderList!.push(skybox);
  probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

  // --- Fog fades the ground slab into the horizon ---
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.00022;

  // --- Post-processing: HDR, ACES tone mapping, bloom on sun glints, vignette ---
  const pipeline = new DefaultRenderingPipeline("pipeline", true, scene, [camera]);
  pipeline.samples = 4;
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.85;
  pipeline.bloomWeight = 0.35;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;
  const ip = pipeline.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.contrast = 1.15;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.6;
  ip.vignetteColor = new Color4(0.05, 0.04, 0.08, 0);
  ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;

  function apply(p: LightPreset) {
    const toSun = sunVector(p);
    sun.direction = toSun.negate();
    sun.position = toSun.scale(3000);
    sun.diffuse = p.sunColor;
    sun.specular = p.sunColor;
    sun.intensity = p.sunIntensity;

    hemi.diffuse = p.skyColor;
    hemi.groundColor = p.groundColor;
    hemi.intensity = p.hemiIntensity;

    sky.sunPosition = toSun.scale(500);
    sky.turbidity = p.turbidity;
    sky.luminance = p.luminance;
    sky.rayleigh = p.rayleigh;

    scene.fogColor = p.fog;
    scene.clearColor = new Color4(p.fog.r, p.fog.g, p.fog.b, 1);
    baseMat.diffuseColor = Color3.Lerp(new Color3(0.42, 0.42, 0.4), p.fog, 0.25);
    grid.mainColor = baseMat.diffuseColor;
    ip.exposure = p.exposure;

    probe.cubeTexture.resetRefreshCounter();
  }

  const requested = new URLSearchParams(location.search).get("light");
  let index = Math.max(0, PRESETS.findIndex((p) => p.name.replace(" ", "") === requested?.replace(/[\s-]/g, "")));
  if (requested === null) index = 1; // golden hour by default: long shadows, warm glass glints
  apply(PRESETS[index]);

  const cycle = () => {
    index = (index + 1) % PRESETS.length;
    apply(PRESETS[index]);
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "l" || e.key === "L") cycle();
  });

  return {
    shadows,
    cycle,
    addModel(meshes) {
      for (const mesh of meshes) {
        const mat = mesh.material;
        if (!(mat instanceof StandardMaterial)) continue;
        if (mat.alpha < 1) {
          // Glass: sky reflection that strengthens at grazing angles.
          mat.reflectionTexture = probe.cubeTexture;
          mat.reflectionFresnelParameters = new FresnelParameters({ bias: 0.08, power: 2.5, leftColor: Color3.White(), rightColor: Color3.Black() });
          mat.specularPower = 256;
          shadows.addShadowCaster(mesh); // faint tinted shadow (transparencyShadow)
        } else {
          shadows.addShadowCaster(mesh);
          mesh.receiveShadows = true;
        }
      }
    },
  };
}
