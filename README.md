# Greenhouse Generator

Procedural greenhouse geometry generator built with Babylon.js + Vite + TypeScript.

## Run

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # type-check + production build
npm run snapshot # geometry regression check against snapshots/
```

## Structure

- `index.html` – full-screen canvas
- `src/main.ts` – engine + render loop
- `src/scene.ts` – thin host: camera, environment, model registry (`?model=curitibaV2` default, `?model=test`), axes, spectator, stats
- `src/models/` – Babylon-free model definitions, each exporting a `build(): Model` function and its camera `view`
- `src/generators/` – parametric generators: `curitibaV2` (glass-surface greenhouse), `glassSurface`, `handrail`, `stair`
- `src/fem/` – element model: types, profiles, placement, discretize, dedupe, sweep, plate, vec
- `src/render/` – Babylon meshes, environment, cameras, axes, stats
- `scripts/snapshot.ts`, `snapshots/` – geometry regression: `npm run snapshot` compares, `npm run snapshot:update` rewrites
