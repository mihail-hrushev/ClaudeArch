# Structure documents

A structure document is a JSON file in this folder that describes a glass and steel building
without code: catalogues of details, a plan of named outlines and levels, and a list of build
operations that arrange the instruments (glass surfaces, columns, arches, beams, handrails,
stairs …) into one structure.

```bash
npm run structure -- structures/pavilion.json   # build it, report the element count or the first error
npm run structure -- --operators                # list the operators and their parameters
npm run dev                                     # then open http://localhost:5173/?model=pavilion
npm run snapshot                                # every document is a regression model "structure.<name>"
npm run glb -- pavilion                         # export it as refs/pavilion.glb without the browser, list the materials written
```

The document holds only **names, numbers and references**. There are no expressions: anything
that needs geometry or arithmetic is an operator, written once in TypeScript
(`src/json/operators/`). The JSON is the DOM, the instruments are the elements, the operators are
the layout engine, the surface types are the stylesheet.

## Values

- **Length**: a number in scene units (centimetres), a string with a unit (`"1200mm"`, `"4.2m"`,
  `"35cm"`), the name of a level (`"eaves"`), or plain arithmetic on those: `+ - * /` and
  parentheses, e.g. `"-half - bay / 2"` (a bare number is a plain factor). Levels are named lengths,
  so plan dimensions go there too (`"baseSize": "8m", "half": "baseSize / 2"`): write coordinates in
  terms of them and the whole building follows when one changes. Geometry (angles, circles) stays in
  operators and plan shapes, not in lengths.
- **Point**: `[x, y, z]`, `{ "corner": ["plan", i], "z": … }`, `{ "side": ["plan", i], "at": …,
  "inward": …, "z": … }` (on side i, `at` from its start, default the middle) or
  `{ "column": ["columnsResult", i], "z": … }`.
- **Cut** (a plane keeping the side its normal points to): `{ "point": …, "normal": [x, y, z] }`,
  `{ "plan": "name", "side": i, "end": 0|1 }` (the bisector at one end of side i),
  `{ "plan": "name", "side": i }` (the plane of side i, keeping the inside; either of these two with `"outside": true` keeps the other side), or `{ "plan": "name" }`
  (all sides). In `openings`, a plan name alone means a hole of that outline, and
  `{ "arch": { "side": ["plan", i], "at": …, "spring": …, "radius": …, "facets": 16 } }` a round-headed
  opening standing on side i (the end of a barrel vault running into a wall).
- **Height**: a length, or `{ "on": "roofResult", "offset": … }` to follow a roof.
- **Color**: `[r, g, b]` in 0 … 1.

## Sections

```jsonc
{
  "name": "pavilion",
  "material": "steel",                                // the framing (ribs, frames, supports) from "materials" below; "color", "metallic",
                                                      // "roughness" here would override its fields (older documents give just "color")
  "view": { "target": [0, 0, 500], "radius": 3200, "alpha": 125, "beta": 70 },   // degrees
  "profiles": { "rib": { "rect": ["50mm", "140mm"] }, "column": { "circle": "150mm" }, "post": { "square": "60mm" } },   // also { "regular": 6, "radius": … }: flat sides
  "materials": {                                      // looks by name: color, alpha (0 invisible … 1 opaque),
    "steel":       { "color": [0, 0, 0], "metallic": 0.95, "roughness": 0.05 },        // a glTF metal (see below): black ironwork
    "masonry":     { "color": [0.34, 0.34, 0.33], "metallic": 0, "roughness": 0.9 },   // matte, for bands
    "blueGlass":   { "color": [0.62, 0.85, 0.82], "alpha": 0.5, "reflection": 0.5 },   // reflection (share of the sky, 0 … 1),
    "orangeGlass": { "color": [0.14, 0.2, 0.54], "alpha": 0.4, "metallic": 0.95, "roughness": 0.01, "emissive": [1, 0.5, 0] }  // emissive (glow);
  },                                                  // this one is a glTF material (see below): it exports to a .glb unchanged
  "glass":    { "clear": { "width": "500mm", "length": "1000mm", "thickness": "12mm", "gap": "15mm", "material": "blueGlass" } },
                                                      // a preset's or tile's own color/alpha/reflection/emissive override its material
                                                      // with "metallic" and "roughness" (0 … 1) a material is physically based
                                                      // exactly as in glTF: color/emissive linear (glTF baseColorFactor and
                                                      // emissiveFactor), single-sided, lit by the HDRI sky; "reflection" unused
  "surfaces": {
    "wall": { "ribStep": "1750mm", "tile": { "preset": "clear", "align": "top-center" },
              "profiles": { "mainRib": "rib", "cutRib": "cutRib", "horizontalFrame": "frame", "verticalFrame": "mullion" } },
    "dome": { "extends": "wall", "tile": { "align": "middle-center" } },       // inherits, overrides fields
    "comb": { "extends": "wall", "honeycomb": { "cell": "1m", "orientation": "pointy", "offset": 0 } }
                                                      // every glazing operator using this type (walls, roof, dome …)
                                                      // tiles with flat hexagons instead (as honeycombSurface: ribs on
                                                      // the shared edges, `cutRib` along edges and cuts, `openingRib`
                                                      // around openings); ribStep and tile alignment do not apply
  },
  "handrails": { "gallery": { "height": "1100mm", "middleHeight": "600mm", "kickHeight": "150mm", "postStep": "1500mm",
                              "profiles": { "post": "post", "topRail": "topRail", "middleRail": "middleRail", "kickRail": "kickRail", "railBeam": "beam" } } },
  "stairs":    { "main": { "width": "1200mm", "riser": "200mm", "tread": "220mm", "treadThickness": "40mm",
                           "platform": { "width": "1200mm", "length": "1600mm" }, "profiles": { "stringer": "stringer", "post": "column" }, "handrail": "gallery" } },
  "levels": { "hallEaves": "6m", "towerTop": "11m" },
  "tangents": { "vault": [0.7, 1] },                  // section tangents [inward, up]: [0, 1] vertical, [1, 1] 45 degrees
  "plan": {                                           // in order: one may refer to those before it
    "tower": { "regular": 8, "apothem": "4.2m" },     // or "radius"; "center", "rotation" (degrees)
    "hall":  { "hull": ["tower"], "margin": "3m" },   // convex hull around outlines, moved out
    "edge":  { "offset": "tower", "by": "1.5m" },     // moved out (in when negative), sides parallel
    "annex": { "beside": "tower", "direction": 0 },   // a copy moved along a direction (degrees) until it touches
    "core":  { "union": ["tower", "annex"] },         // outline around outlines that touch or overlap
    "box":   { "rect": ["20m", "8m"], "center": [0, "4m"] },
    "any":   { "polygon": [[0, 0], ["10m", 0], ["10m", "6m"]] },
    "cross": { "cross": { "right": "20m", "rear": "14m", "left": "20m" }, "width": "14m", "apseSides": 3, "crossing": "8m" },
                                                      // arms along ±X / ±Y to the centre of their apse, each ending in
                                                      // `apseSides` flat facets (0: square); a missing arm closes straight,
                                                      // divided at the corners of a crossing `crossing` wide
    "lake":  { "ellipse": ["90m", "40m"], "sides": 48, "center": [0, "-37m"] },
    "end":   { "apse": ["box", 0], "segments": 3 }   // a half polygon on the outside of side 0 of "box", that side
                                                      // its diameter: corner 0 is the side's start, the last side
                                                      // the diameter back to it
  },
  "groups": {                                        // reusable assemblies, see Groups below
    "porch": { "plan": { "porch": { "rect": ["10m", "4m"], "center": [0, "-7m"] } }, "build": [ … ] }
  },
  "build": [ … ]                                      // operations, in order
}
```

Outlines are counter-clockwise; side i runs from corner i to corner i+1, its `inward` is the
horizontal normal into the plan, and its two `corners` are the bisector planes with the
neighbouring sides, so surfaces on neighbouring sides meet exactly.

## Operations

Every operation has an `op` and a `name`. The name is the prefix of the element ids it makes
and, for most operators, the name of the **result** later operations refer to: a `surfaces`
result (glass blocks), a `columns` result (`between` of arches and beams, `{ "column": … }`
points), a `height` result (a roof: `{ "on": … }` heights) or a `members` result.

Glazing operators (`surface`, `surface2`, `walls`, `roof`, `dome`, `floor`, `deck`) share these fields: `type` (a
surface type name or an inline one), and per use `ribStep`, `ribStations`, `bays` (the name of a
`bays` result: ribs on its bay lines), `evenBays` (default true: the rib step is rounded so whole
bays divide the width), `ribsOnGrid` (true: main ribs on the tile joints nearest each step; `"symmetric"`: a centred grid puts a joint and a rib on the centre line, and no rib is added near an edge), `align`, `padding`, `cuts`, `openings`.

| op | what it does | main fields |
|---|---|---|
| `surface` | one glass surface placed explicitly | `base`, `alongX`, `alongZ`, `extend?` (continue the section past `alongZ` on the same arc, this much further inwards), `tangent?` (the section's direction at the base: `[inward, up]` towards `alongZ`, a name from `tangents`, or the older `[0, inward, up]`), `facing?` |
| `surface2` | one glass surface curved in two directions: `surface` with a second tangent bending its base line (see `structures/double_curvature_test.json`) | as `surface`, and `tangentX?` (the base line's direction at the base, local `[x, y]`, or a name from `tangents`: `[1, 0]` straight to `alongX` as `surface` is, `[0, 1]` a semicircle bulging towards the structure, `[0, -1]` one bulging towards the glass side), `sweep?` (`"slide"`, the default: the section moves along the base line without turning, any two tangents work, tiles are parallelograms of the tile's width and length, skewed where the base line runs the way the section leans; `"revolve"`: the section turns about the axis of the base line and stays square to it, as in a dome or an apse, tiles are trapezoids narrowing towards the axis, and the section may not run past the axis), `tilt?` (`[at the base, at alongX]` in degrees, default `[0, 0]`: the section leans by an angle changing evenly along the base line, positive tops towards the structure; a changing lean twists the surface, so each tile is made flat through the middles of its edges and frames run one piece per tile column), `through?` (further points the base line runs on through as arcs joining smoothly: a polyarch). `ribStep`, `ribStations` and the tile width are measured along the base line |
| `honeycombSurface` | one glass surface placed like `surface2` but tiled with flat hexagons instead of rectangles (see `structures/honeycomb_test.json`): one straight rib on every edge two cells share, so neighbouring tiles sit on the same rib, three meeting at each node; an edge rib (the type's `cutRib`) along each side; cells running past an edge are cut off there. The nodes are moved along the surface normal until the cells are as flat as they can be, then each tile is made exactly flat (on a saddle the tile edges stand a little off the ribs); where the surface repeats itself (revolved, or along a straight base line or section) whole cells it carries onto each other are identical tiles, one type per height on a revolved surface. Takes `type`, `base`, `alongX`, `alongZ`, `tangent?`, `tangentX?`, `sweep?`, `facing?`, not the other glazing fields | `cell?` (width across the flats, default the tile's width), `orientation?` (`"pointy"`, the default: corners up and down the section; `"flat"`: corners along the base line), `offset?` (glass of every tile moved along its own normal, forward away from the structure when positive, back when negative; the ribs stay), `offsets?` (`[{ cells: [[col, row], …], offset }]`: single cells, from `[0, 0]` at the bottom left) |
| `walls` | upright walls along the sides of a plan (square at reflex corners) | `plan`, `sides?`, `foot?` (height), `top` (height), `overlap?`, `inset?`, `bays?` (`{columns, clear?, within?}`: one surface per bay between the columns standing in the wall line) |
| `roof` | a face rising from every side, run on to the valley past a reflex corner; leaves a height field | `plan`, `eaves`, `rise?`, `run?`, `slope?` (degrees at the eaves, or `"level"`: the arc levels off at the top of its run), `valleys?` (false: faces stop square at reflex corners), `bays?` (as for walls) |
| `dome` | a faceted dome over a plan; leaves a height field | `plan`, `base`, `rise`, `apex?`, `springing?` (90 = vertical, `"flat"`, or degrees), `opening?` (width of the flat opening left at the top) |
| `floor` | a tiled floor over a plan, structure below | `plan`, `level`, `along?`, `ceiling?` |
| `deck` | tiled deck bays between two outlines, e.g. a walkway between beam lines: one bay per side of the outer outline, closed along the inner one | `outer`, `inner`, `level` (walking surface) |
| `bays` | whole bays of about `step` on every side of a plan; leaves a bays result that glazing (`bays`) and columns (`at.bays`) on the same sides of any layer take their stations from | `plan`, `step`, `measure?` (`{plan, sides?}`: count on the matching side of another outline), `even?` (sides kept as equal shares rather than lines carried across), `margin?` |
| `columns` | columns at corners, along sides, opposite other columns, or at points, with a base and a capital if asked; leaves a columns result | `at` (`{plan, corners?, inset?}` / `{plan, sides?, spacing or bays (a count, or a bays result), inset?, includeCorners?}` / `{plan, sides?, opposite, inset?, includeCorners?}`: at the corners and opposite the columns of a result or the convex corners of an outline, each projected onto its nearest side / `{points}`), `profile`, `foot?`, `top` (height), `tops?` (`[{corners?, sides?, top}]`), `base?` / `capital?` (`{profile, height}`, or a list of such tiers from the bottom up), `orient?`, `up?` |
| `arches` | arches between consecutive columns (a ring unless `open`), or from each column to the nearest of another result | `between`, `to?`, `profile`, one of `spring`, `crown` (level of the crowns) or `under` (a height, or `{columns: offset}`: the line between the column tops; the arch is raised until its back just touches it), or both `spring` and `under` (half ellipses from that level, as tall as just touches), `rise?` (segmental), `inward?`, `shafts?` (true: the arches stop short of the columns and a slender shaft of the arch profile stands at each end, from the column's foot to the highest springing there; shared by all arches ending at that spot) |
| `beams` | beams between consecutive columns, or to the nearest of another result, at a level or following a roof | `between`, `to?`, `profile`, `level` (height), `open?`, `inward?` |
| `member` | one straight / arc / polyline member | `profile`, `start`, `end`, `startTangent?` (arc: a direction, or `{ "after": <member> }` to run on from where that member arrives at its end), `nodes?` (polyline), `up?` |
| `branches` | smaller arches branching off members every `step` along them, on both sides (see `structures/twelve_segments.json`) | `from` (members results in order along the line, e.g. the pieces of a long arch), `profile`, `step`, `reach` (out to the side, square to the members), `drop?` (down against the members' normal at that point, so the branches turn with them; 0 gives straight members), `sides?` (`"both"`, `"left"`, `"right"`), `ties?` (`{ step, profile }`: straight ribs joining each two neighbouring branches on a side, every `step` along them and at their ends) |
| `polyarch` | a reference line of circular arcs in one plane, each running on smoothly from the one before; not built unless given a `profile` (see `structures/twelve_segments.json`) | `start`, `tangent` (direction leaving `start`), `through` (the arc ends, in order), `profile?`, `color?` |
| `polyarchSurface` | a glass surface swept along a polyarch on both sides of it: one `glassSurface2` block per side, its base line running through all the arcs, ribs every `ribStep` along it without a break at the joints, glass on top | `type`, `along` (a polyarch), `reach` (out to the side), `drop` (down against the polyarch's normal), `slope?` (degrees below level the section leaves the polyarch at: 0 arches smoothly over it, more makes a ridge), `sides?`, `ribStep?`, `align?`, `cuts?`, `openings?`, `tips?` (`{ profile }`: from where each cut leaves a side's outer edge, a further upright cut runs straight to the polyarch's end, a pointed tip, its rib with this profile), `columns?` (`{ profile, foot?, color? }`: a column under the outer end of every cut's rib, from `foot` up to the rib, its profile facing out from the polyarch's start), `jointColumns?` (`{ profile, foot?, color? }`: a column under each cut's rib where every point at which the polyarch's arcs meet projects square onto the cut plane, up to that rib, framed the same way) |
| `plate` | one flat convex plate | `corners`, `thickness`, `color?`, `alpha?`, `reflection?`, `bevel?` |
| `slab` | a plate covering a plan outline | `plan`, `level`, `thickness`, `color?` |
| `pyramid` | solid plates from the sides of a plan up to an apex over its centre: a lantern roof, a spire | `plan`, `base` (height), `apex`, `thickness`, `color?` |
| `box` | an axis-aligned solid block | `x`, `y`, `z` ranges, `color?` |
| `band` | a mitred band along the sides of a plan: plinth, frieze, cornice | `plan`, `thickness`, `z`, `inset?`, `material?` (from `materials`, e.g. masonry in a document of steel), `color?`, `metallic?`, `roughness?` (override it) |
| `outline` | a new plan outline from columns, points or a cut outline | `columns?` / `points?` / `plan?` + `cuts?`, `towards?` + `share?` (corners moved a share of the way to the nearest column of a result, e.g. the centre line between two column rings) |
| `handrail` | handrail sections along plan sides or between two points | `type`, `along` (`{plan, sides?, level, inward?}` / `{from, to}`), `padding?`, `railBeamDrop?`, `gaps?` (points results, e.g. stairs, marking stretches left open) |
| `stair` | a stair along a centre line; leaves a points result marking where it arrives | `type`, `path`, `floor?`, `height`, `landing?` (`"bend"`: the middle platform centred on the first bend), `arrival?` (`{length?, exit?: {side, length?, reach, column, arch?}}`: a way off the arrival beside a column, the column's quarter arches carrying it) |
| `group` | places a group from `groups`, built in its local coordinates, turned about the vertical and moved; ids and results get the prefix `<name>/` | `use`, `rotate?` (degrees), `about?`, `move?` |
| `window` | a framed window in the line of a plan side: middle post, a rib in each half, an outer elliptical arch on the frame sides and an inner one on the ribs, both springing at `spring`, a horizontal rib on each side joining their feet and a diagonal one at 45 degrees (parametric: the projection of a round arch); glass inside the outer arch, solid spandrels outside it | `side` (`["plan", i]`), `at?`, `inward?`, `foot`, `width`, or `part` instead of `at` and `width` (`[i, n]`: part i of n equal parts of the side), `sidesOnEdges?` (the frame sides centred on the window edges, on a rib line and shared with the next window; `width` then runs between their centre lines), `height` or `top` (a level), `spring?` (a level, like `foot`; default half-way up), `innerRise?` (share of the outer rise, default 0.5), `arcSegments?` (rounded up to a multiple of 4), `profiles` (`{frame, frameVertical?, frameHorizontal?, post?, rib?}`: `frame` for the outer arch and the default of the frame's vertical sides and its top and bottom, which can be set apart, e.g. heavier sides carrying the load from above), `glass?` (`{thickness?, material?, color?, alpha?, reflection?, emissive?}`: a material from `materials`, fields override it), `solid?` |
| `archSurface` | an upright glazed screen between two points: a frame from `foot` to `top`, vertical ribs every `ribStep` (rounded to equal bays), each bay crowned by a semicircular arch whose crown touches the frame top; glass below and inside the arches, solid spandrels above them | `from`, `to` (points; plan position only), `inset?` (shortens both ends), `foot`, `top`, `ribStep?` (default 400 mm), `arcSegments?`, `floor?` (arcs `{from, to, tangent?}` written like a surface section, e.g. a roof meeting the screen: everything below them is cut away, the bottom frame follows them and the ribs stand on them), `profiles` (`{frame, rib?, arch?}`), `glass?` (`{thickness?, material?, color?, alpha?, reflection?, emissive?}`: a material from `materials`, fields override it), `solid?` |
| `archWindow` | a large round-headed window between two points: jambs from `foot` to the springing, an outer and an inner semicircular arch; the band between them split into equal sectors by radial ribs, the inner half disc into equal vertical strips whose ribs run on down to the sill; glass throughout | `from`, `to` (points; plan position only, centred between them), `foot`, `outerRadius?` (default half the span), `innerRadius`, `ringSegments?` (default 15), `ribs?` (default 12), `spring?` or `ceiling?` (arcs `{from, to, tangent?}` like `floor` above: the window rises until the outer arch's back just touches them; the gap above is filled solid unless `spandrels: false`), `arcSegments?` (pieces per sector, default 4), `profiles` (`{frame, arch?, rib?}`), `glass?` (`{thickness?, material?, color?, alpha?, reflection?, emissive?}`: a material from `materials`, fields override it), `solid?` |

`npm run structure -- --operators` prints the current list from the code, which is the authority.

## Groups

A group is an assembly written once and placed many times, e.g. a porch on every side of a
square hall. Its `plan` and `build` are written in the group's **local coordinates**: as if it
stood at the origin unrotated, so the porch of the front side. Everything outside the group
(the document's outlines, levels, profiles, columns and other results) is read in those same
coordinates, so a group may refer to `["cornerColumns", 0]` as the front-left column.

```jsonc
{ "op": "group", "name": "right", "use": "porch", "rotate": 90 }   // also "about": [x, y], "move": [x, y, z]
```

A `group` step builds the group's steps in a context of their own (outlines and results made
inside stay inside), then turns the finished elements `rotate` degrees counter-clockwise about
the vertical through `about` and moves them by `move`. Element ids get the prefix `<name>/`
(`right/porchLeft/rib1`), and the columns, points and members results made inside become
`<name>/<result>`, placed. Groups may place other groups.



An operator is a relationship between instruments that the JSON cannot express with names and
numbers: "walls stand on that roof", "columns at these corners, clear of the ribs". Put it in a
module of its concern under `src/json/operators/` (`glazing.ts`, `supports.ts`,
`circulation.ts`, or a new one), with a zod schema for its fields and a one-sentence
description, and add it to the list in `src/json/operators/index.ts`. Keep operators generic: a
building-specific rule belongs in the document as a parameter, not in the code.
