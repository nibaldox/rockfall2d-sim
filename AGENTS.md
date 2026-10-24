# AGENTS.md — SimRocas 2D

## Project Overview

2D simulation of falling rocks web app. 100% vanilla JavaScript + HTML Canvas. Zero dependencies, no build tools, no bundler, no linter.

## Running the App

```bash
cd rockfall2d-sim
python3 -m http.server 8080
# Open http://localhost:8080
```

Always hard-refresh with Ctrl+Shift+R to bypass JS cache during development.

### Tests

```bash
node --test tests/
```

Headless tests with `node:test` (requires Node >= 20, zero dependencies). The helper `tests/helpers/load.js` loads the plain scripts into a Node `vm` context so the physics runs without a browser.

## Architecture

```
rockfall2d-sim/
├── index.html          # Entry point; loads JS files in strict order via <script> tags
├── css/style.css       # Dark theme, CSS variables for all colors
├── js/
│   ├── terrain.js      # Terrain class — 2D polyline, coordinate transforms, materials
│   ├── stl.js          # STL parser (ASCII/binary) and 2.5D slicing — plan view, cross-sections, contours
│   ├── physics.js      # Rock + PhysicsEngine — polygonal collision, impulse, torque, fragmentation
│   ├── simulation.js   # Simulation controller — main loop, rock lifecycle
│   ├── renderer.js     # Renderer — Canvas 2D drawing, histogram, probability map
│   ├── stats.js        # Stats — statistics, CSV/text export
│   ├── worker.js       # Web Worker — simulation in separate thread
│   ├── structural-failure.js  # Structural failure analysis — NOT loaded in index.html (unused; decision pending)
│   └── app.js          # App — wiring, UI controls, DOM event handlers
└── tests/              # Headless tests (node:test)
    ├── helpers/load.js # Script loader for the Node vm context
    └── physics.roughness.test.js
```

JS files are loaded in order by `<script>` tags in `index.html`. Each file defines one or more ES6 classes on the global `SimRocas` namespace, assigned at `globalThis.SimRocas` (migration in progress — some files still assign via `window.SimRocas`). No `import`/`export`, no modules. `index.html` uses manual cache-busting (`?v=N` query string per script): bump the version of every script you edit, or the browser serves stale code.

## Code Style

- **Indentation**: 4 spaces (no tabs)
- **Classes**: PascalCase, one primary class per file, no module exports
- **Variables / methods**: camelCase
- **Constants**: inline literals or `const` declarations
- **Quotes**: single quotes for strings, template literals for interpolation
- **Semicolons**: present
- **Arrow functions**: used for event handlers and callbacks
- **DOM access**: `document.getElementById()` directly; no framework
- **Error handling**: `try/catch` with `alert()` for user-facing errors
- **UI language**: Spanish (labels, messages, reports). Code identifiers in English.

## Physics Conventions

- Coordinate system: Y grows UP (topographic convention)
- Physics uses 3 sub-steps per time step for stability
- Rocks are convex random polygons (5-9 vertices), never concave
- Resting condition: velocity < 0.08 m/s, angular velocity < 0.5 rad/s, bounces > 2
- Boundary culling: rocks outside [-50, 500] X or below -100 Y are terminated
- Max steps per rock: 5,000

## CSS Variables

All colors use CSS custom properties on `:root`:
`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-card`,
`--text-primary`, `--text-secondary`, `--accent`, `--accent-hover`,
`--success`, `--warning`, `--border`, `--highlight`

## Modifying the App

1. Edit `index.html` to add UI elements (Spanish labels)
2. Add logic to the appropriate JS class file
3. Wire DOM events in `app.js`
4. Bump the `?v=N` cache-busting version of every edited script in `index.html`
5. Test by refreshing the browser

## Known Issues

- Worker physics is a self-contained copy in `js/worker.js` that diverges from `js/physics.js` (fragmentation differs: worker generation < 2 and diameter > 0.15 m, fractal model; main thread generation < 3 and diameter > 0.10 m, progressive model)
- Under investigation: rocks that never come to rest with lumped-mass and rigid-body
- `js/structural-failure.js` is not loaded in `index.html` (unused code; decision pending)
