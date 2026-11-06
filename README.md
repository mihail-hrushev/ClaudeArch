# Greenhouse Generator

Procedural greenhouse geometry generator built with Babylon.js + Vite + TypeScript.

## Run

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # type-check + production build
npm run snapshot # geometry regression check against snapshots/
npm run structure -- structures/pavilion.json   # build a JSON structure document, report elements or the first error
npm run structure -- --operators                # list the build operators
```

## Structure

- `index.html` – full-screen canvas
- `src/main.ts` – engine + render loop
- `src/scene.ts` – thin host: camera, environment, model registry (`?model=curitibaV2` default, `?model=crystalPalace`, `?model=test`), axes, spectator, stats
- `src/models/` – Babylon-free model definitions, each exporting a `build(): Model` function and its camera `view`
- `src/generators/` – parametric generators: `curitibaV2` (glass-surface greenhouse), `crystalPalace` (Palacio de Cristal, Madrid; its dimensions, marked published or estimate, are in `src/models/crystalPalace.ts`), `glassSurface`, `handrail`, `stair`
- `src/json/` – JSON structure documents: `document.ts` (zod schema), `context.ts` (resolution of lengths, profiles, types, plans, points, results), `operators/` (the build operators), `build.ts` (document → model); see `structures/README.md`
- `structures/` – structure documents, each a scene model (`?model=<file name>`) and a snapshot `structure.<name>`
- `src/fem/` – element model: types, profiles, placement, discretize, dedupe, sweep, plate, vec, plan (outline sides, regular polygons, hull, offset)
- `src/render/` – Babylon meshes, environment, cameras, axes, stats
- `scripts/snapshot.ts`, `snapshots/` – geometry regression: `npm run snapshot` compares, `npm run snapshot:update` rewrites
