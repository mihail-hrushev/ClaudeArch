import { Scene } from "@babylonjs/core/scene";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { FresnelParameters } from "@babylonjs/core/Materials/fresnelParameters";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import { setupDepthOfField } from "./depthOfField";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
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
  /** Cloud cover over the sun, 0..1: dims and spreads the sun disc and its glare. */
  cloudiness: number;
  /** HDRI shown instead of the procedural sky; `turn` aligns its sun with the preset's, in degrees. */
  hdri?: { url: string; turn: number };
}

const PRESETS: LightPreset[] = [
  {
    name: "day", elevation: 52, azimuth: 235,
    sunColor: new Color3(1, 0.97, 0.9), sunIntensity: 1.0,
    skyColor: new Color3(0.75, 0.85, 1), groundColor: new Color3(0.35, 0.33, 0.3), hemiIntensity: 0.85,
    fog: new Color3(0.72, 0.8, 0.9), turbidity: 6, luminance: 1, rayleigh: 1.6, exposure: 1.0, cloudiness: 0.55,
  },
  {
    name: "golden hour", elevation: 14, azimuth: 205,
    sunColor: new Color3(1, 0.72, 0.42), sunIntensity: 1.2,
    skyColor: new Color3(0.6, 0.65, 0.85), groundColor: new Color3(0.35, 0.25, 0.2), hemiIntensity: 0.75,
    fog: new Color3(0.85, 0.68, 0.55), turbidity: 10, luminance: 1, rayleigh: 2.5, exposure: 1.1, cloudiness: 0.5,
  },
  {
    name: "dusk", elevation: 3, azimuth: 190,
    sunColor: new Color3(1, 0.45, 0.25), sunIntensity: 0.9,
    skyColor: new Color3(0.35, 0.38, 0.6), groundColor: new Color3(0.18, 0.13, 0.15), hemiIntensity: 0.65,
    fog: new Color3(0.42, 0.36, 0.45), turbidity: 14, luminance: 1.05, rayleigh: 3.5, exposure: 1.25, cloudiness: 0.45,
  },
  {
    // Sun height and colours measured from the image (Poly Haven, CC0).
    name: "hdri", elevation: 48, azimuth: 235,
    sunColor: new Color3(1, 1, 0.93), sunIntensity: 1.0,
    skyColor: new Color3(0.78, 0.84, 1), groundColor: new Color3(0.4, 0.37, 0.33), hemiIntensity: 0.9,
    fog: new Color3(0.44, 0.47, 0.57), turbidity: 6, luminance: 1, rayleigh: 1.6, exposure: 1.3, cloudiness: 0.55,
    hdri: { url: "hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr", turn: 180 },
  },
];

const DEG = Math.PI / 180;
/** Ambient occlusion: how far contact shading reaches, in scene units, and how dark it gets. */
const AO_RADIUS = 60;
const AO_STRENGTH = 1.5;
/** Sky box and ground slab size: the fog reaches the horizon inside it, its corners stay inside the far plane. */
const SKY_SIZE = 22000;

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
 * Press "O" to toggle ambient occlusion; "?ao=off" leaves it out altogether.
 * Press "B" to toggle the depth of field; "?dof=off" starts with it off.
 * The default is the HDRI sky; glass reflects whichever sky is shown through the probe.
 */
export function createEnvironment(scene: Scene, orbit: ArcRotateCamera, fly: Camera): Environment {
  const cameras = [orbit, fly];
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
  const skybox = MeshBuilder.CreateBox("skybox", { size: SKY_SIZE, sideOrientation: 1 }, scene);
  skybox.material = sky;
  skybox.infiniteDistance = true;
  skybox.isPickable = false;

  /** Sky material for an HDRI, loaded the first time it is needed. */
  const hdriSkies = new Map<string, StandardMaterial>();
  const hdriSky = ({ url, turn }: NonNullable<LightPreset["hdri"]>) => {
    const existing = hdriSkies.get(url);
    if (existing) return existing;
    const texture = new HDRCubeTexture(url, scene, 1024, true, false);
    texture.coordinatesMode = Texture.SKYBOX_MODE;
    // Cube textures are Y up, the scene Z up.
    texture.setReflectionTextureMatrix(Matrix.RotationX(-Math.PI / 2).multiply(Matrix.RotationY(turn * DEG)));
    texture.onLoadObservable.addOnce(() => probe.cubeTexture.resetRefreshCounter());
    const material = new StandardMaterial(`sky_${url}`, scene);
    material.backFaceCulling = false;
    material.disableLighting = true;
    material.fogEnabled = false;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.reflectionTexture = texture;
    hdriSkies.set(url, material);
    return material;
  };

  // --- Ground: a soft-coloured slab, the engineering grid and a shadow catcher on top ---
  const groundSize = 8000;
  const base = MeshBuilder.CreateGround("ground_base", { width: SKY_SIZE, height: SKY_SIZE }, scene);
  base.rotation.x = Math.PI / 2;
  base.position.z = -5; // well below the grid: avoids z-fighting at long camera distances
  base.isPickable = false;
  const baseMat = new StandardMaterial("ground_base", scene);
  baseMat.specularColor = Color3.Black();
  base.material = baseMat;
  // No receiveShadows: the shadow catcher above draws the shadows (saves a full-screen shadow lookup).

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
  catcherMat.alpha = 0.28;
  catcher.material = catcherMat;
  catcher.receiveShadows = true;

  // --- Shadows ---
  const shadows = new ShadowGenerator(2048, sun);
  // PCF (medium) gives soft edges at a fraction of the cost of contact-hardening (PCSS).
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.02;
  shadows.darkness = 0.45; // 0 = black, 1 = no shadow
  shadows.transparencyShadow = true;
  // The model is static: render the shadow map once, re-render only when the light or casters change.
  const shadowMap = shadows.getShadowMap()!;
  shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

  // --- Sky reflections for glass ---
  const probe = new ReflectionProbe("sky_probe", 256, scene, true, true);
  probe.renderList!.push(skybox);
  probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

  // --- Fog fades the ground slab into the horizon ---
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.00022;

  // --- Ambient occlusion: contact shading from the opaque geometry only. Glass stays out of the
  // depth pass, so the structure behind it keeps its shading. Set up before the pipeline below,
  // so that tone mapping comes after it. ---
  const gBuffer = new URLSearchParams(location.search).get("ao") === "off" ? null : scene.enableGeometryBufferRenderer();
  let ao: SSAO2RenderingPipeline | null = null;
  if (gBuffer) {
    gBuffer.renderTransparentMeshes = false;
    gBuffer.renderList = [base];
    ao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 1, blurRatio: 1 }, cameras, true);
    ao.radius = AO_RADIUS;
    ao.totalStrength = AO_STRENGTH;
    ao.samples = 24;
    ao.maxZ = 8000;
    ao.minZAspect = 0.2;
    // Thin frames at a distance speckle: full resolution, and a denoiser that smooths across them.
    ao.expensiveBlur = true;
    ao.bilateralSamples = 16;
    ao.bilateralSoften = 0.3;
    ao.bilateralTolerance = 0.6;
  }

  // --- Post-processing: HDR, ACES tone mapping, bloom on sun glints, vignette, depth of field ---
  const pipeline = new DefaultRenderingPipeline("pipeline", true, scene, cameras);
  pipeline.samples = 4;
  pipeline.fxaaEnabled = false; // MSAA already smooths edges
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.95;
  pipeline.bloomWeight = 0.2;
  pipeline.bloomKernel = 32;
  pipeline.bloomScale = 0.5;
  const ip = pipeline.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.contrast = 1.0;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.6;
  ip.vignetteColor = new Color4(0.05, 0.04, 0.08, 0);
  ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
  setupDepthOfField(scene, pipeline, orbit);

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

    skybox.material = p.hdri ? hdriSky(p.hdri) : sky;
    sky.sunPosition = toSun.scale(500);
    sky.turbidity = p.turbidity;
    sky.luminance = p.luminance;
    sky.rayleigh = p.rayleigh;
    sky.cloudiness = p.cloudiness;

    scene.fogColor = p.fog;
    scene.clearColor = new Color4(p.fog.r, p.fog.g, p.fog.b, 1);
    baseMat.diffuseColor = Color3.Lerp(new Color3(0.42, 0.42, 0.4), p.fog, 0.25);
    grid.mainColor = baseMat.diffuseColor;
    ip.exposure = p.exposure;

    probe.cubeTexture.resetRefreshCounter();
    shadowMap.resetRefreshCounter();
  }

  const requested = new URLSearchParams(location.search).get("light");
  let index = Math.max(0, PRESETS.findIndex((p) => p.name.replace(" ", "") === requested?.replace(/[\s-]/g, "")));
  if (requested === null) index = PRESETS.length - 1; // the HDRI sky by default
  apply(PRESETS[index]);

  const cycle = () => {
    index = (index + 1) % PRESETS.length;
    apply(PRESETS[index]);
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "l" || e.key === "L") cycle();
    if ((e.key === "o" || e.key === "O") && ao) ao.totalStrength = ao.totalStrength > 0 ? 0 : AO_STRENGTH;
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
          mat.reflectionFresnelParameters = new FresnelParameters({ bias: mesh.metadata?.reflection ?? 0.08, power: 2.5, leftColor: Color3.White(), rightColor: Color3.Black() });
          mat.specularPower = 256;
          shadows.addShadowCaster(mesh); // faint tinted shadow (transparencyShadow)
        } else {
          shadows.addShadowCaster(mesh);
          mesh.receiveShadows = true;
          gBuffer?.renderList?.push(mesh);
        }
      }
      shadowMap.resetRefreshCounter();
    },
  };
}
