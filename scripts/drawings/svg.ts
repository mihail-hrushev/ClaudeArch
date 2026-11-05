/**
 * Minimal SVG writer for the drawings: paper coordinates in millimetres, 1 user unit = 1 mm.
 * Runs under Node with no DOM.
 */
export type P2 = readonly [number, number];

/** Line weight hierarchy of the drawings, in mm. */
export const LINE = { cut: 0.5, outline: 0.25, projection: 0.18, thin: 0.13 } as const;

export const FONT = "Helvetica, Arial, 'Liberation Sans', sans-serif";

const fmt = (v: number) => {
  const s = v.toFixed(2);
  return s.replace(/\.?0+$/, "") || "0";
};

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Stroke {
  readonly width?: number;
  readonly color?: string;
  readonly dash?: string;
}

export interface Style extends Stroke {
  readonly fill?: string;
  readonly fillOpacity?: number;
}

function styleAttrs(s: Style): string {
  const parts: string[] = [];
  parts.push(`fill="${s.fill ?? "none"}"`);
  if (s.fillOpacity !== undefined && s.fillOpacity < 1) parts.push(`fill-opacity="${s.fillOpacity}"`);
  if (s.width) {
    parts.push(`stroke="${s.color ?? "#000"}"`, `stroke-width="${fmt(s.width)}"`);
    if (s.dash) parts.push(`stroke-dasharray="${s.dash}"`);
  }
  return parts.join(" ");
}

export class Svg {
  private readonly body: string[] = [];
  private readonly defs: string[] = [];

  constructor(readonly width: number, readonly height: number) {}

  /** Raw SVG snippet in the defs block (patterns, markers). */
  def(snippet: string): void {
    this.defs.push(snippet);
  }

  raw(snippet: string): void {
    this.body.push(snippet);
  }

  /** Opens a group; everything until `close` goes inside it. */
  open(attrs = ""): void {
    this.body.push(`<g${attrs ? " " + attrs : ""}>`);
  }

  close(): void {
    this.body.push("</g>");
  }

  polygon(pts: readonly P2[], style: Style): void {
    if (pts.length < 2) return;
    this.body.push(`<polygon points="${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" ${styleAttrs(style)}/>`);
  }

  /** One path made of several closed loops (nonzero fill joins overlapping loops). */
  loops(loops: readonly (readonly P2[])[], style: Style): void {
    const d = loops
      .filter((l) => l.length >= 2)
      .map((l) => "M" + l.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L") + "Z")
      .join("");
    if (d) this.body.push(`<path d="${d}" ${styleAttrs(style)}/>`);
  }

  /** Several independent line segments as one path (keeps the file small). */
  segments(segs: readonly (readonly [P2, P2])[], stroke: Stroke): void {
    if (!segs.length) return;
    const d = segs.map(([a, b]) => `M${fmt(a[0])} ${fmt(a[1])}L${fmt(b[0])} ${fmt(b[1])}`).join("");
    this.body.push(`<path d="${d}" ${styleAttrs(stroke)} stroke-linecap="round"/>`);
  }

  line(a: P2, b: P2, stroke: Stroke): void {
    this.segments([[a, b]], stroke);
  }

  polyline(pts: readonly P2[], stroke: Stroke): void {
    if (pts.length < 2) return;
    this.body.push(`<polyline points="${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" ${styleAttrs(stroke)}/>`);
  }

  circle(c: P2, r: number, style: Style): void {
    this.body.push(`<circle cx="${fmt(c[0])}" cy="${fmt(c[1])}" r="${fmt(r)}" ${styleAttrs(style)}/>`);
  }

  rect(x: number, y: number, w: number, h: number, style: Style): void {
    this.body.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ${styleAttrs(style)}/>`);
  }

  /**
   * Text anchored at `p`; `anchor` horizontal, `baseline` vertical. `rotate` in degrees around `p`
   * (-90 reads bottom to top). Size in mm.
   */
  text(
    p: P2, s: string, size: number,
    opts: { anchor?: "start" | "middle" | "end"; baseline?: "auto" | "middle" | "hanging"; rotate?: number; weight?: "normal" | "bold"; color?: string } = {},
  ): void {
    const transform = opts.rotate ? ` transform="rotate(${opts.rotate} ${fmt(p[0])} ${fmt(p[1])})"` : "";
    this.body.push(
      `<text x="${fmt(p[0])}" y="${fmt(p[1])}" font-family="${FONT}" font-size="${fmt(size)}" ` +
      `text-anchor="${opts.anchor ?? "middle"}" dominant-baseline="${opts.baseline ?? "auto"}" ` +
      `font-weight="${opts.weight ?? "normal"}" fill="${opts.color ?? "#000"}"${transform}>${escapeXml(s)}</text>`,
    );
  }

  toString(): string {
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(this.width)}mm" height="${fmt(this.height)}mm" ` +
      `viewBox="0 0 ${fmt(this.width)} ${fmt(this.height)}">`,
      `<defs>${this.defs.join("")}</defs>`,
      `<rect width="${fmt(this.width)}" height="${fmt(this.height)}" fill="#fff"/>`,
      ...this.body,
      `</svg>`,
      "",
    ].join("\n");
  }
}

/** Approximate rendered width of a string, in mm, for layout decisions. */
export const textWidth = (s: string, size: number) => s.length * size * 0.58;
