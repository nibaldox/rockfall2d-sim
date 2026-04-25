# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

2D simulation of falling rocks web app. 100% vanilla JavaScript + HTML Canvas. Zero dependencies, no build tools, no bundler, no linter, no test framework.

## Running the App

```bash
cd rockfall2d-sim
python3 -m http.server 8080
# Open http://localhost:8080
```

Always hard-refresh with Ctrl+Shift+R to bypass JS cache during development.

## Architecture

```
rockfall2d-sim/
├── index.html          # Entry point; loads JS files in strict order via <script> tags
├── css/style.css       # Dark theme with CSS variables; light theme via [data-theme]
└── js/
    ├── terrain.js      # Terrain class — 2D polyline, coordinate transforms, segment properties
    ├── physics.js      # Rock + PhysicsEngine — polygonal collision, impulse, torque
    ├── simulation.js   # Simulation controller — main loop, rock lifecycle, frame recording
    ├── renderer.js     # Renderer — Canvas 2D drawing, histogram, timeline playback
    ├── stats.js        # Stats — statistics computation, CSV/text export
    ├── worker.js       # Web Worker — simulation in separate thread
    └── app.js          # App — wiring, UI controls, DOM event handlers
```

JS files are loaded in order by `<script>` tags in `index.html`. Each file defines one or more ES6 classes on the global `SimRocas` namespace. No `import`/`export`, no modules.

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

## Key Classes

- **Terrain** (`js/terrain.js`): Stores polyline points, per-segment material properties (Cn/Ct), world/canvas coordinate transforms, height lookup via interpolation.
- **Rock** (`js/physics.js`): Polygonal shape, mass, moment of inertia, collision handling (rigid-body impulse, lumped mass, nonsmooth dynamics), rolling friction models.
- **PhysicsEngine** (`js/physics.js`): Factory for Rock instances, time-stepping loop with sub-steps, parameter variation (Monte Carlo).
- **Simulation** (`js/simulation.js`): Manages rock array lifecycle, step loop, frame recording for timeline playback.
- **Renderer** (`js/renderer.js`): Canvas drawing — terrain, rocks, trajectories, bounce points, histogram. Timeline frame rendering.
- **Stats** (`js/stats.js`): Computes min/mean/max/std/P50/P83/P95 for energy, bounce height, runout, velocity. CSV and text report generation.
- **App** (`js/app.js`): Central orchestrator — DOM event wiring, tab management, canvas interaction (click/drag/zoom), export functions.

## Modifying the App

1. Edit `index.html` to add UI elements (Spanish labels)
2. Add logic to the appropriate JS class file
3. Wire DOM events in `app.js`
4. Test by refreshing the browser (Ctrl+Shift+R)

## Known Issues

- Profiles with >50 points cause slow simulation
- Release point near terrain may embed rocks
- >1,000 rocks saturates the canvas visually (trace limit needed)
