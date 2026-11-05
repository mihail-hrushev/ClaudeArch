/**
 * Architectural annotation: sheet mapping, structural grid, dimension strings, level lines,
 * scale bar and title block. Paper coordinates in mm; model coordinates in cm.
 */
import { LINE, type P2, type Svg, textWidth } from "./svg";

/** Maps view coordinates (cm, v up) onto the sheet (mm, y down) at 1:`scale`. */
export class Page {
  readonly mmPerCm: number;
  constructor(readonly scale: number, readonly originX: number, readonly originY: number) {
    this.mmPerCm = 10 / scale;
  }
  x(u: number): number {
    return this.originX + u * this.mmPerCm;
  }
  y(v: number): number {
    return this.originY - v * this.mmPerCm;
  }
  point(p: P2): P2 {
    return [this.x(p[0]), this.y(p[1])];
  }
}

/** Formats a scene length (cm) as whole millimetres. */
export const mm = (cm: number) => `${Math.round(cm * 10)}`;

/** Formats a level in cm as "+4.500" (metres, three decimals). */
export const levelLabel = (cm: number) => {
  const m = Math.abs(cm) / 100;
  const sign = Math.abs(cm) < 0.05 ? "±" : cm > 0 ? "+" : "−";
  return `${sign}${m.toFixed(3)}`;
};

/** Groups sorted values closer than `tolerance` and returns the mean of each group. */
export function cluster(values: readonly number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g[g.length - 1] <= tolerance) g.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

export const letters = (i: number) => {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

export interface GridLine {
  readonly label: string;
  /** Position along the axis the line crosses, in cm (view coordinate). */
  readonly at: number;
}

const DASH_DOT = "6 1.5 1 1.5";
const BUBBLE_R = 4;

/**
 * Grid lines across the sheet: `axis` "x" draws vertical lines at `line.at` (u) between v0 and
 * v1 (mm, paper y), "y" draws horizontal lines. Bubbles sit at both ends; `bubbles` can limit them.
 */
export function drawGridLines(
  svg: Svg, page: Page, axis: "x" | "y", lines: readonly GridLine[], from: number, to: number,
  bubbles: { start?: boolean; end?: boolean } = { start: true, end: true },
): void {
  let previousC = -Infinity;
  let previousStagger = 0;
  for (const line of lines) {
    const c = axis === "x" ? page.x(line.at) : page.y(line.at);
    // Bubbles of two lines closer than a bubble are staggered: every other one moves out a row.
    const stagger = Math.abs(c - previousC) < 2 * BUBBLE_R + 0.5 && !previousStagger ? 2 * BUBBLE_R + 1 : 0;
    previousC = c;
    previousStagger = stagger;
    const a: P2 = axis === "x" ? [c, from - stagger] : [from - stagger, c];
    const b: P2 = axis === "x" ? [c, to + stagger] : [to + stagger, c];
    svg.line(a, b, { width: LINE.thin, dash: DASH_DOT, color: "#333" });
    const ends: [P2, boolean | undefined][] = [[a, bubbles.start], [b, bubbles.end]];
    for (const [end, on] of ends) {
      if (!on) continue;
      const dir = end === a ? -1 : 1;
      const center: P2 = axis === "x" ? [end[0], end[1] + dir * BUBBLE_R] : [end[0] + dir * BUBBLE_R, end[1]];
      svg.circle(center, BUBBLE_R, { fill: "#fff", width: LINE.outline });
      svg.text([center[0], center[1] + 1.25], line.label, 3.5, { anchor: "middle" });
    }
  }
}

/** Extent of a grid line beyond the building, bubble included, in mm. */
export const GRID_REACH = 8 + 2 * BUBBLE_R;

export interface DimOptions {
  /** Paper coordinate of the dimension line (y for a horizontal string, x for a vertical one). */
  readonly line: number;
  /** Where the extension lines start (paper coordinate across the string). */
  readonly from: number;
  /** Text labels per bay; by default the bay length in mm. */
  readonly labels?: readonly string[];
  /** Text on the far side of the line, for a vertical string on the left of the drawing. */
  readonly textSide?: 1 | -1;
}

/**
 * Dimension string through the given stations (view cm), horizontal or vertical. Extension lines
 * from `from` to just beyond the line, 45° ticks at every station, the bay length (mm) centred
 * on each bay; a label too long for its bay is lifted one row.
 */
export function drawDimString(svg: Svg, page: Page, axis: "x" | "y", stations: readonly number[], opts: DimOptions): void {
  if (stations.length < 2) return;
  const horizontal = axis === "x";
  const pos = stations.map((s) => (horizontal ? page.x(s) : page.y(s)));
  const toward = Math.sign(opts.line - opts.from) || 1;
  const size = 3;
  const tick = 1.2;
  const overshoot = 2;
  const first = pos[0];
  const last = pos[pos.length - 1];
  const dimLine = opts.line;
  // Extension lines.
  for (const p of pos) {
    const a: P2 = horizontal ? [p, opts.from] : [opts.from, p];
    const b: P2 = horizontal ? [p, dimLine + toward * overshoot] : [dimLine + toward * overshoot, p];
    svg.line(a, b, { width: LINE.thin, color: "#333" });
  }
  // Dimension line with overshoot.
  svg.line(
    horizontal ? [first - overshoot, dimLine] : [dimLine, first - overshoot],
    horizontal ? [last + overshoot, dimLine] : [dimLine, last + overshoot],
    { width: LINE.thin, color: "#000" },
  );
  for (const p of pos) {
    const a: P2 = horizontal ? [p - tick, dimLine + tick] : [dimLine - tick, p + tick];
    const b: P2 = horizontal ? [p + tick, dimLine - tick] : [dimLine + tick, p - tick];
    svg.line(a, b, { width: LINE.outline, color: "#000" });
  }
  // Labels.
  const side = opts.textSide ?? (horizontal ? -1 : -1);
  let previousLift = 0;
  for (let i = 0; i < stations.length - 1; i++) {
    const label = opts.labels?.[i] ?? mm(Math.abs(stations[i + 1] - stations[i]));
    const bay = Math.abs(pos[i + 1] - pos[i]);
    const mid = (pos[i] + pos[i + 1]) / 2;
    const fits = textWidth(label, size) <= bay - 1;
    // A label wider than its bay is lifted a row; two narrow bays in a row alternate rows.
    const lift = fits ? 0 : previousLift ? 0 : size + 0.5;
    previousLift = lift;
    const offset = 0.8 + lift;
    if (horizontal) {
      svg.text([mid, dimLine + side * offset], label, size, { anchor: "middle" });
    } else {
      svg.text([dimLine + side * offset, mid], label, size, { anchor: "middle", rotate: -90 });
    }
  }
}

/** Horizontal level line across the elevation with its label at the right end. */
export function drawLevel(svg: Svg, page: Page, z: number, x0: number, x1: number, name: string): void {
  const y = page.y(z);
  svg.line([x0, y], [x1, y], { width: LINE.thin, dash: "4 1.5", color: "#333" });
  // Level marker: small open triangle on the line, then the value and the name.
  const tx = x1 + 1;
  svg.polyline([[tx, y], [tx + 2.5, y - 2.5], [tx + 5, y]], { width: LINE.thin, color: "#000" });
  svg.line([tx, y], [tx + 5, y], { width: LINE.thin, color: "#000" });
  svg.text([tx + 6, y - 0.8], levelLabel(z), 3, { anchor: "start" });
  svg.text([tx + 6, y + 3.2], name, 2.5, { anchor: "start", color: "#333" });
}

/** Scale bar from 0 to `metres` with 1 m blocks, origin at the top-left corner (mm). */
export function drawScaleBar(svg: Svg, page: Page, x: number, y: number, metres: number): void {
  const unit = 100 * page.mmPerCm;
  const h = 2.5;
  for (let i = 0; i < metres; i++) {
    svg.rect(x + i * unit, y, unit, h, { fill: i % 2 ? "#fff" : "#000", width: LINE.thin });
  }
  for (const i of [0, Math.floor(metres / 2), metres]) {
    svg.text([x + i * unit, y - 1.2], `${i}`, 2.5, { anchor: "middle" });
  }
  svg.text([x + metres * unit + 3, y + h - 0.3], "m", 2.5, { anchor: "start" });
  svg.text([x, y + h + 3.5], `Scale 1:${page.scale}`, 2.5, { anchor: "start" });
}

export interface TitleBlock {
  readonly project: string;
  readonly drawing: string;
  readonly sheet: string;
  readonly notes?: readonly string[];
}

/** Title block in the bottom-right corner of the sheet. */
export function drawTitleBlock(svg: Svg, page: Page, title: TitleBlock, width = 150, height = 40): void {
  const x = svg.width - 10 - width;
  const y = svg.height - 10 - height;
  svg.rect(x, y, width, height, { fill: "#fff", width: LINE.cut });
  svg.line([x, y + 12], [x + width, y + 12], { width: LINE.outline });
  svg.line([x + 90, y + 12], [x + 90, y + height], { width: LINE.outline });
  svg.text([x + 3, y + 8], title.project, 5, { anchor: "start", weight: "bold" });
  svg.text([x + 3, y + 20], title.drawing, 4, { anchor: "start", weight: "bold" });
  const notes = [`Scale 1:${page.scale}`, "Dimensions in mm, levels in m", ...(title.notes ?? [])];
  notes.forEach((n, i) => svg.text([x + 3, y + 26 + i * 4], n, 2.5, { anchor: "start" }));
  svg.text([x + 93, y + 20], "Sheet", 2.5, { anchor: "start", color: "#333" });
  svg.text([x + 93, y + 26], title.sheet, 3, { anchor: "start" });
  svg.text([x + 93, y + 33], "Generated from the model geometry", 2.2, { anchor: "start", color: "#333" });
  svg.text([x + 93, y + 37], "scripts/drawings.ts", 2.2, { anchor: "start", color: "#333" });
}

/** Hatch pattern for cut sections: 45° lines, `step` mm apart. */
export function hatchDef(id: string, step = 1, width = 0.15, color = "#000"): string {
  return (
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${step}" height="${step}" patternTransform="rotate(45)">` +
    `<line x1="0" y1="0" x2="0" y2="${step}" stroke="${color}" stroke-width="${width}"/></pattern>`
  );
}
