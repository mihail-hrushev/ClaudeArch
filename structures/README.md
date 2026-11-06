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
```

The document holds only **names, numbers and references**. There are no expressions: anything
that needs geometry or arithmetic is an operator, written once in TypeScript
(`src/json/operators/`). The JSON is the DOM, the instruments are the elements, the operators are
the layout engine, the surface types are the stylesheet.

## Values

- **Length**: a number in scene units (centimetres), a string with a unit (`"1200mm"`, `"4.2m"`,
  `"35cm"`) or the name of a level (`"eaves"`).
- **Point**: `[x, y, z]`, `{ "corner": ["plan", i], "z": … }`, `{ "side": ["plan", i], "at": …,
  "inward": …, "z": … }` (on side i, `at` from its start, default the middle) or
  `{ "column": ["columnsResult", i], "z": … }`.
- **Cut** (a plane keeping the side its normal points to): `{ "point": …, "normal": [x, y, z] }`,
  `{ "plan": "name", "side": i, "end": 0|1 }` (the bisector at one end of side i),
  `{ "plan": "name", "side": i }` (the plane of side i, keeping the inside), or `{ "plan": "name" }`
  (all sides). In `openings`, a plan name alone means a hole of that outline, and
  `{ "arch": { "side": ["plan", i], "at": …, "spring": …, "radius": …, "facets": 16 } }` a round-headed
  opening standing on side i (the end of a barrel vault running into a wall).
- **Height**: a length, or `{ "on": "roofResult", "offset": … }` to follow a roof.
- **Color**: `[r, g, b]` in 0 … 1.

## Sections

```jsonc
{
  "name": "pavilion",
  "color": [0.97, 0.97, 0.95],                       // default colour of ribs, frames, supports
  "view": { "target": [0, 0, 500], "radius": 3200, "alpha": 125, "beta": 70 },   // degrees
  "profiles": { "rib": { "rect": ["50mm", "140mm"] }, "column": { "circle": "150mm" }, "post": { "square": "60mm" } },
  "glass":    { "clear": { "width": "500mm", "length": "1000mm", "thickness": "12mm", "gap": "15mm", "alpha": 0.5, "reflection": 0.5 } },
  "surfaces": {
    "wall": { "ribStep": "1750mm", "tile": { "preset": "clear", "align": "top-center" },
              "profiles": { "mainRib": "rib", "cutRib": "cutRib", "horizontalFrame": "frame", "verticalFrame": "mullion" } },
    "dome": { "extends": "wall", "tile": { "align": "middle-center" } }        // inherits, overrides fields
  },
  "handrails": { "gallery": { "height": "1100mm", "middleHeight": "600mm", "kickHeight": "150mm", "postStep": "1500mm",
                              "profiles": { "post": "post", "topRail": "topRail", "middleRail": "middleRail", "kickRail": "kickRail", "railBeam": "beam" } } },
  "stairs":    { "main": { "width": "1200mm", "riser": "200mm", "tread": "220mm", "treadThickness": "40mm",
                           "platform": { "width": "1200mm", "length": "1600mm" }, "profiles": { "stringer": "stringer", "post": "column" }, "handrail": "gallery" } },
  "levels": { "hallEaves": "6m", "towerTop": "11m" },
  "plan": {                                           // in order: one may refer to those before it
    "tower": { "regular": 8, "apothem": "4.2m" },     // or "radius"; "center", "rotation" (degrees)
    "hall":  { "hull": ["tower"], "margin": "3m" },   // convex hull around outlines, moved out
    "edge":  { "offset": "tower", "by": "1.5m" },     // moved out (in when negative), sides parallel
    "box":   { "rect": ["20m", "8m"], "center": [0, "4m"] },
    "any":   { "polygon": [[0, 0], ["10m", 0], ["10m", "6m"]] },
    "cross": { "cross": { "right": "20m", "rear": "14m", "left": "20m" }, "width": "14m", "apseSides": 3, "crossing": "8m" },
                                                      // arms along ±X / ±Y to the centre of their apse, each ending in
                                                      // `apseSides` flat facets (0: square); a missing arm closes straight,
                                                      // divided at the corners of a crossing `crossing` wide
    "lake":  { "ellipse": ["90m", "40m"], "sides": 48, "center": [0, "-37m"] }
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

Glazing operators (`surface`, `walls`, `roof`, `dome`, `floor`) share these fields: `type` (a
surface type name or an inline one), and per use `ribStep`, `ribStations`, `bays` (the name of a
`bays` result: ribs on its bay lines), `evenBays` (default true: the rib step is rounded so whole
bays divide the width), `ribsOnGrid`, `align`, `padding`, `cuts`, `openings`.

| op | what it does | main fields |
|---|---|---|
| `surface` | one glass surface placed explicitly | `base`, `alongX`, `alongZ`, `tangent?`, `facing?` |
| `walls` | upright walls along the sides of a plan (square at reflex corners) | `plan`, `sides?`, `foot?` (height), `top` (height), `overlap?`, `inset?` |
| `roof` | a face rising from every side, run on to the valley past a reflex corner; leaves a height field | `plan`, `eaves`, `rise?`, `run?`, `slope?` (degrees at the eaves, or `"level"`: the arc levels off at the top of its run), `valleys?` (false: faces stop square at reflex corners) |
| `dome` | a faceted dome over a plan; leaves a height field | `plan`, `base`, `rise`, `apex?`, `springing?` (90 = vertical, `"flat"`, or degrees), `opening?` (width of the flat opening left at the top) |
| `floor` | a tiled floor over a plan, structure below | `plan`, `level`, `along?`, `ceiling?` |
| `bays` | whole bays of about `step` on every side of a plan; leaves a bays result that glazing (`bays`) and columns (`at.bays`) on the same sides of any layer take their stations from | `plan`, `step`, `measure?` (`{plan, sides?}`: count on the matching side of another outline), `even?` (sides kept as equal shares rather than lines carried across), `margin?` |
| `columns` | columns at corners, along sides or at points, with a base and a capital if asked; leaves a columns result | `at` (`{plan, corners?, inset?}` / `{plan, sides?, spacing or bays (a count, or a bays result), inset?, includeCorners?}` / `{points}`), `profile`, `foot?`, `top` (height), `tops?` (`[{corners?, sides?, top}]`), `base?` / `capital?` (`{profile, height}`), `orient?`, `up?` |
| `arches` | arches between consecutive columns, a ring unless `open` | `between`, `profile`, `spring` or `crown` (level of the crowns), `rise?` (segmental), `inward?` |
| `beams` | beams between consecutive columns at a level or following a roof | `between`, `profile`, `level` (height), `open?`, `inward?` |
| `member` | one straight / arc / polyline member | `profile`, `start`, `end`, `startTangent?` (arc), `nodes?` (polyline), `up?` |
| `plate` | one flat convex plate | `corners`, `thickness`, `color?`, `alpha?`, `reflection?`, `bevel?` |
| `slab` | a plate covering a plan outline | `plan`, `level`, `thickness`, `color?` |
| `pyramid` | solid plates from the sides of a plan up to an apex over its centre: a lantern roof, a spire | `plan`, `base` (height), `apex`, `thickness`, `color?` |
| `box` | an axis-aligned solid block | `x`, `y`, `z` ranges, `color?` |
| `band` | a mitred band along the sides of a plan: plinth, frieze, cornice | `plan`, `thickness`, `z`, `inset?`, `color?` |
| `outline` | a new plan outline from columns, points or a cut outline | `columns?` / `points?` / `plan?` + `cuts?` |
| `handrail` | handrail sections along plan sides or between two points | `type`, `along` (`{plan, sides?, level, inward?}` / `{from, to}`), `padding?`, `railBeamDrop?` |
| `stair` | a stair along a centre line | `type`, `path`, `floor?`, `height`, `arrival?` |

`npm run structure -- --operators` prints the current list from the code, which is the authority.

## Adding an operator

An operator is a relationship between instruments that the JSON cannot express with names and
numbers: "walls stand on that roof", "columns at these corners, clear of the ribs". Put it in a
module of its concern under `src/json/operators/` (`glazing.ts`, `supports.ts`,
`circulation.ts`, or a new one), with a zod schema for its fields and a one-sentence
description, and add it to the list in `src/json/operators/index.ts`. Keep operators generic: a
building-specific rule belongs in the document as a parameter, not in the code.
