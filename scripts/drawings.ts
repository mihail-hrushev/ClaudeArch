/**
 * Architectural line drawings of the Curitiba V2 model as SVG, generated from the geometry:
 *   npm run drawings
 * writes drawings/front-elevation.svg, roof-plan.svg, ground-plan.svg and first-level-plan.svg.
 *
 * Views are orthographic with a painter's algorithm: every element is split into convex pieces,
 * drawn far to near as white (or glass-tinted) fills with silhouette and crease edges stroked,
 * so near elements occlude far ones. Plans are horizontal sections: geometry below the cut is
 * projected, the section through every solid is hatched with a heavy outline, and anything
 * entirely above the cut is left out. Sheets are A2 landscape at 1:100; scene units are cm,
 * dimensions are written in mm and levels in m. Babylon-free, deterministic, runs under tsx.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Element, Model } from "../src/fem/types";
import type { Vec3 } from "../src/fem/vec";
import { plateNormal } from "../src/fem/plate";
import type { MeshData } from "../src/fem/sweep";
import { buildCuritibaV2 } from "../src/models/curitibaV2";
import { LINE, type P2, Svg } from "./drawings/svg";
import {
  FRONT_VIEW, PLAN_VIEW, type Segment3, type View,
  clipBelow, convexHull, convexPieces, cutLoops, elementMesh, meshBounds, pieceOutline, project, visibleEdges,
} from "./drawings/geometry";
import {
  GRID_REACH, type GridLine, Page, cluster, drawDimString, drawGridLines, drawLevel, drawScaleBar, drawTitleBlock,
  hatchDef, letters, levelLabel,
} from "./drawings/annotate";

// ---------------------------------------------------------------------------------------------
// Drawing definitions
// ---------------------------------------------------------------------------------------------

/** Sheet: A2 landscape, drawing area above a strip for the title block and scale bar. */
const SHEET = { width: 594, height: 420, margin: 15, titleStrip: 55 };
const SCALE = 100;
const PROJECT = "Curitiba V2 Greenhouse";

/**
 * Storey levels of the model, in cm above ground (the parameters of src/models/curitibaV2.ts:
 * walkFloor.height, ground.wallHeight, tower.wallHeight; the apex is measured from the geometry).
 */
const LEVELS = { ground: 0, walkFloor: 360, eaves: 600, towerWallTop: 1100 };
/** Plans are cut 120 cm above their floor. */
const CUT_ABOVE_FLOOR = 120;

interface DrawingDef {
  readonly file: string;
  readonly title: string;
  readonly kind: "plan" | "elevation";
  readonly view: View;
  /** Height of the horizontal section, scene units; none for a projection. */
  readonly cutZ?: number;
  readonly notes?: readonly string[];
}

const DRAWINGS: readonly DrawingDef[] = [
  {
    file: "front-elevation.svg", title: "Front elevation", kind: "elevation", view: FRONT_VIEW,
    notes: ["Seen from the front (−Y), X to the right"],
  },
  {
    file: "roof-plan.svg", title: "Roof plan", kind: "plan", view: PLAN_VIEW,
    notes: ["Seen from above, front of the building at the bottom"],
  },
  {
    file: "ground-plan.svg", title: "Ground floor plan", kind: "plan", view: PLAN_VIEW,
    cutZ: LEVELS.ground + CUT_ABOVE_FLOOR,
    notes: [`Horizontal section at ${levelLabel(LEVELS.ground + CUT_ABOVE_FLOOR)}, front at the bottom`, "Cut members hatched; parts above the cut omitted"],
  },
  {
    file: "first-level-plan.svg", title: "First level plan (walk floor)", kind: "plan", view: PLAN_VIEW,
    cutZ: LEVELS.walkFloor + CUT_ABOVE_FLOOR,
    notes: [`Horizontal section at ${levelLabel(LEVELS.walkFloor + CUT_ABOVE_FLOOR)}, front at the bottom`, "Cut members hatched; parts above the cut omitted"],
  },
];

// ---------------------------------------------------------------------------------------------
// Model preparation
// ---------------------------------------------------------------------------------------------

interface Prepared {
  readonly el: Element;
  readonly mesh: MeshData;
  /** Triangle indices per convex piece (members only; plates use their faces). */
  readonly pieces: readonly (readonly number[])[];
  readonly minZ: number;
  readonly maxZ: number;
  readonly glass: boolean;
}

function prepare(model: Model): Prepared[] {
  return model.elements.map((el) => {
    const mesh = elementMesh(el);
    const b = meshBounds(mesh);
    return {
      el, mesh, pieces: el.kind === "plate" ? [] : convexPieces(el, mesh),
      minZ: b.min[2], maxZ: b.max[2], glass: el.kind === "plate" && (el.alpha ?? 1) < 1,
    };
  });
}

/** Faces of a plate solid as 3D polygons: top, bottom and the sides. */
function plateFaces(el: Element & { kind: "plate" }): Vec3[][] {
  const n = plateNormal(el.corners);
  const h = el.thickness / 2;
  const top = el.corners.map((p): Vec3 => [p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h]);
  const bot = el.corners.map((p): Vec3 => [p[0] - n[0] * h, p[1] - n[1] * h, p[2] - n[2] * h]);
  const sides = el.corners.map((_, i) => {
    const j = (i + 1) % el.corners.length;
    return [bot[i], bot[j], top[j], top[i]];
  });
  return [top, bot, ...sides];
}

/** Sutherland–Hodgman clip of a 3D polygon to z <= maxZ. */
function clipPolygonBelow(poly: readonly Vec3[], maxZ: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const aIn = a[2] <= maxZ;
    const bIn = b[2] <= maxZ;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (maxZ - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, maxZ]);
    }
  }
  return out;
}

/** Counter-clockwise orientation so nonzero filling unions overlapping polygons. */
function ccw(poly: P2[]): P2[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area < 0 ? poly.reverse() : poly;
}

// ---------------------------------------------------------------------------------------------
// Rendering one drawing
// ---------------------------------------------------------------------------------------------

/** What one element contributes to a sheet, in view coordinates (cm). */
interface Drawn {
  readonly near: number;
  readonly glass: boolean;
  readonly fills: P2[][];
  readonly edges: [P2, P2][];
}

function drawnElement(p: Prepared, view: View, cutZ: number | undefined): Drawn | null {
  const { el, mesh } = p;
  if (cutZ !== undefined && p.minZ > cutZ) return null;
  const clip = cutZ !== undefined && p.maxZ > cutZ ? cutZ : undefined;
  const fills: P2[][] = [];
  const edges: [P2, P2][] = [];
  let near = -Infinity;

  if (el.kind === "plate") {
    for (const face of plateFaces(el)) {
      const poly = clip === undefined ? face : clipPolygonBelow(face, clip);
      if (poly.length < 3) continue;
      for (const q of poly) near = Math.max(near, view.near(q));
      fills.push(ccw(poly.map((q) => project(view, q))));
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (a[2] === clip && b[2] === clip) continue; // the cut line itself belongs to the section
        edges.push([project(view, a), project(view, b)]);
      }
    }
  } else {
    for (const piece of p.pieces) {
      const { hull, near: n } = pieceOutline(view, mesh, piece, clip);
      if (hull.length >= 3) {
        fills.push(hull);
        near = Math.max(near, n);
      }
    }
    for (const e of visibleEdges(mesh, view)) {
      const s: Segment3 | null = clip === undefined ? e : clipBelow(e, clip);
      if (s) edges.push([project(view, s[0]), project(view, s[1])]);
    }
  }
  if (!fills.length && !edges.length) return null;
  return { near, glass: p.glass, fills, edges };
}

/** Section polygons of the elements crossing the cut, in view coordinates; raw segments where chaining failed. */
function sections(prepared: readonly Prepared[], view: View, cutZ: number): { loops: P2[][]; open: [P2, P2][] } {
  const loops: P2[][] = [];
  const open: [P2, P2][] = [];
  for (const p of prepared) {
    if (p.minZ >= cutZ || p.maxZ <= cutZ) continue;
    const cut = cutLoops(p.mesh, cutZ);
    for (const loop of cut.loops) loops.push(loop.map((q) => project(view, q)));
    for (const s of cut.open) open.push([project(view, s[0]), project(view, s[1])]);
  }
  return { loops, open };
}

interface Grid {
  readonly x: GridLine[];
  readonly y: GridLine[];
}

/** Structural grid from the column positions: x lines numbered, y lines lettered from the front. */
function structuralGrid(model: Model): Grid {
  const columns = model.elements.filter(
    (el): el is Element & { kind: "straight" } => el.kind === "straight" && /\/(column|wall_column)_[^/]*$/.test(el.id),
  );
  const xs = cluster(columns.map((c) => c.start[0]), 5);
  const ys = cluster(columns.map((c) => c.start[1]), 5);
  return {
    x: xs.map((at, i) => ({ at, label: `${i + 1}` })),
    y: ys.map((at, i) => ({ at, label: letters(i) })),
  };
}

interface Bounds {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

/** Places the view on the sheet: the drawing with its annotation reach centred in the drawing area. */
function layout(bounds: Bounds, reach: { left: number; right: number; top: number; bottom: number }): Page {
  const mmPerCm = 10 / SCALE;
  const width = (bounds.uMax - bounds.uMin) * mmPerCm + reach.left + reach.right;
  const height = (bounds.vMax - bounds.vMin) * mmPerCm + reach.top + reach.bottom;
  const areaWidth = SHEET.width - 2 * SHEET.margin;
  const areaHeight = SHEET.height - 2 * SHEET.margin - SHEET.titleStrip;
  if (width > areaWidth || height > areaHeight) {
    console.warn(`  drawing needs ${width.toFixed(0)} x ${height.toFixed(0)} mm, sheet area is ${areaWidth} x ${areaHeight} mm`);
  }
  const left = SHEET.margin + (areaWidth - width) / 2 + reach.left;
  const top = SHEET.margin + (areaHeight - height) / 2 + reach.top;
  return new Page(SCALE, left - bounds.uMin * mmPerCm, top + bounds.vMax * mmPerCm);
}

function render(def: DrawingDef, prepared: readonly Prepared[], grid: Grid, modelBounds: { min: number[]; max: number[] }): Svg {
  const { view, cutZ } = def;
  const svg = new Svg(SHEET.width, SHEET.height);
  svg.def(hatchDef("hatch"));

  // Extents of the whole model in this view (every plan shares one layout).
  const corners: Vec3[] = [];
  for (const x of [modelBounds.min[0], modelBounds.max[0]]) {
    for (const y of [modelBounds.min[1], modelBounds.max[1]]) {
      for (const z of [modelBounds.min[2], modelBounds.max[2]]) corners.push([x, y, z]);
    }
  }
  const us = corners.map(view.u);
  const vs = corners.map(view.v);
  const bounds: Bounds = { uMin: Math.min(...us), uMax: Math.max(...us), vMin: Math.min(...vs), vMax: Math.max(...vs) };
  const dimRows = 3;
  const reach = def.kind === "plan"
    ? { left: GRID_REACH + 10 * dimRows + 14, right: GRID_REACH + 4, top: GRID_REACH + 4, bottom: GRID_REACH + 10 * dimRows + 14 }
    : { left: 40, right: 40, top: 8, bottom: GRID_REACH + 10 * 2 + 14 };
  const page = layout(bounds, reach);

  // Geometry, far to near.
  const drawn = prepared.map((p) => drawnElement(p, view, cutZ)).filter((d): d is Drawn => d !== null);
  drawn.sort((a, b) => a.near - b.near);
  const projectionWeight = cutZ === undefined ? LINE.outline : LINE.projection;
  svg.open('stroke-linejoin="round"');
  for (const d of drawn) {
    const fills = d.fills.map((poly) => poly.map((q) => page.point(q)));
    if (d.glass) {
      svg.loops(fills, { fill: "#dbe9f0", fillOpacity: 0.6 });
      svg.segments(d.edges.map(([a, b]) => [page.point(a), page.point(b)]), { width: LINE.projection, color: "#3a5566" });
    } else {
      svg.loops(fills, { fill: "#fff" });
      svg.segments(d.edges.map(([a, b]) => [page.point(a), page.point(b)]), { width: projectionWeight, color: "#000" });
    }
  }
  svg.close();

  // Section through the cut plane, on top of everything below it.
  if (cutZ !== undefined) {
    const cut = sections(prepared, view, cutZ);
    svg.open('stroke-linejoin="round"');
    svg.loops(cut.loops.map((l) => l.map((q) => page.point(q))), { fill: "url(#hatch)", width: LINE.cut, color: "#000" });
    svg.segments(cut.open.map(([a, b]) => [page.point(a), page.point(b)]), { width: LINE.cut, color: "#000" });
    svg.close();
    console.log(`  section: ${cut.loops.length} closed loops, ${cut.open.length} open segments`);
  }

  // Annotation.
  const left = page.x(bounds.uMin);
  const right = page.x(bounds.uMax);
  const top = page.y(bounds.vMax);
  const bottom = page.y(bounds.vMin);
  const gridXAt = grid.x.map((g) => g.at);
  if (def.kind === "plan") {
    const gridYAt = grid.y.map((g) => g.at);
    drawGridLines(svg, page, "x", grid.x, top - 8, bottom + 8);
    drawGridLines(svg, page, "y", grid.y, left - 8, right + 8);
    // Bottom: grid bays, grid overall, building overall.
    drawDimString(svg, page, "x", gridXAt, { from: bottom + GRID_REACH + 12, line: bottom + GRID_REACH + 18 });
    drawDimString(svg, page, "x", [gridXAt[0], gridXAt[gridXAt.length - 1]], { from: bottom + GRID_REACH + 12, line: bottom + GRID_REACH + 28 });
    drawDimString(svg, page, "x", [bounds.uMin, bounds.uMax], { from: bottom + 2, line: bottom + GRID_REACH + 38 });
    // Left: the same for the y lines.
    drawDimString(svg, page, "y", gridYAt, { from: left - GRID_REACH - 12, line: left - GRID_REACH - 18 });
    drawDimString(svg, page, "y", [gridYAt[0], gridYAt[gridYAt.length - 1]], { from: left - GRID_REACH - 12, line: left - GRID_REACH - 28 });
    drawDimString(svg, page, "y", [bounds.vMin, bounds.vMax], { from: left - 2, line: left - GRID_REACH - 38 });
  } else {
    const apex = modelBounds.max[2];
    const groundY = page.y(0);
    drawGridLines(svg, page, "x", grid.x, top - 8, groundY + 8, { start: false, end: true });
    svg.line([left - 20, groundY], [right + 20, groundY], { width: LINE.cut, color: "#000" });
    drawDimString(svg, page, "x", gridXAt, { from: groundY + GRID_REACH + 12, line: groundY + GRID_REACH + 18 });
    drawDimString(svg, page, "x", [gridXAt[0], gridXAt[gridXAt.length - 1]], { from: groundY + GRID_REACH + 12, line: groundY + GRID_REACH + 28 });
    drawDimString(svg, page, "x", [bounds.uMin, bounds.uMax], { from: bottom + 2, line: groundY + GRID_REACH + 38 });
    // Levels with labels on the right, heights on the left.
    const levels: [number, string][] = [
      [LEVELS.ground, "ground"], [LEVELS.walkFloor, "walk floor"], [LEVELS.eaves, "eaves"],
      [LEVELS.towerWallTop, "top of tower walls"], [apex, "apex"],
    ];
    for (const [z, name] of levels) drawLevel(svg, page, z, left - 8, right + 8, name);
    for (const d of DRAWINGS) {
      if (d.cutZ === undefined) continue;
      const y = page.y(d.cutZ);
      svg.line([left - 8, y], [right + 8, y], { width: LINE.thin, dash: "6 1.5 1 1.5", color: "#555" });
      svg.text([right + 9, y + 1], `${levelLabel(d.cutZ)} section — ${d.title.toLowerCase()}`, 2.2, { anchor: "start", color: "#555" });
    }
    const stations = levels.map(([z]) => z);
    drawDimString(svg, page, "y", stations, { from: left - 2, line: left - 20 });
    drawDimString(svg, page, "y", [0, apex], { from: left - 2, line: left - 30 });
  }

  drawScaleBar(svg, page, SHEET.margin, SHEET.height - SHEET.margin - 20, 10);
  drawTitleBlock(svg, page, {
    project: PROJECT, drawing: def.title, sheet: `A2 landscape, ${SHEET.width} × ${SHEET.height} mm`, notes: def.notes,
  });
  return svg;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drawings");

function main() {
  const model = buildCuritibaV2();
  console.log(`model: ${model.elements.length} elements`);
  const prepared = prepare(model);
  const bounds = prepared.reduce((b, p) => meshBounds(p.mesh, b), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const grid = structuralGrid(model);
  console.log(`grid: ${grid.x.length} numbered lines (x), ${grid.y.length} lettered lines (y)`);
  console.log(`  x: ${grid.x.map((g) => `${g.label}=${g.at.toFixed(1)}`).join(" ")}`);
  console.log(`  y: ${grid.y.map((g) => `${g.label}=${g.at.toFixed(1)}`).join(" ")}`);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const def of DRAWINGS) {
    console.log(`${def.title}:`);
    const svg = render(def, prepared, grid, bounds);
    const file = join(OUT_DIR, def.file);
    const text = svg.toString();
    writeFileSync(file, text);
    console.log(`  wrote ${file} (${(text.length / 1024 / 1024).toFixed(1)} MB)`);
  }
}

main();
