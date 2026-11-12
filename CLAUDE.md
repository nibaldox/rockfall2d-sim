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
- Resting condition (`Rock._checkResting`): at least 3 accumulated checks (the counter is not reset on collisions), speed below 0.08 m/s scaled by the local slope as `max(0.1, 1 - 2 * |slope|)`, `|ω| < 0.5 rad/s`, and more than 2 detected contacts or sustained contact. Sustained contact exists only in Lumped Mass, with `|vn| < 0.5 m/s`; `ignoreResting` skips the check
- `bounces` is an internal contact counter ("Contactos detectados"), not an impact count; the impact figure is `impactCount` (events with `|vn| >= 0.5 m/s`). With dt > 0.02 s in rigid-body or nonsmooth the resting state may go undetected (non-blocking `dtGrueso` warning)
- Boundary culling: rocks outside [-50, 500] X or below -100 Y are terminated
- Max steps per rock: 5,000

## Impact Instrumentation (P0.2-β)

- **Real impact (C1)**: logged per surface (terrain or barrier) when the existing approach guard passes, `|vn| >= 0.5 m/s`, and no episode is open on that surface. One episode per surface, opened on the first sub-step with detected contact and closed on the first without it. Captured read-only, before the impulse; `impactEvents` keeps the first 200 events and `droppedImpactEvents` the rest. In nonsmooth with polygons the impact count includes vertex strikes while the rock topples, and `vn` is the normal velocity of the contact point (it includes `ω × r`), not of the centre
- **Flight height (C3)**: starts after a C1 event and ends at the next sub-step with contact on any surface; the sample is the rock centre over the terrain, `y - getHeightAt(x)`, only inside the profile. The initial fall does not count and the value is null when no valid sample exists. Not a bounce height, not a collector height, not a RocFall figure
- **Materials per segment (U4)**: rigid-body and nonsmooth use the segment's own `cn`, `ct` and roughness. The Cn/Ct variability multiplies each segment's values (`clamp01(seg.cn × fCn)`, same draws and correlation as before); the global Cn/Ct inputs are disabled and only act on profiles with fewer than 2 points. An impact beyond the ends of the profile (its horizontal extension) uses the Cn and Ct of the nearest end segment (no roughness beyond the profile), and Stats emits the `fueraDelPerfil` warning. The warning looks at the x of the rock centre in the C1 events: a contact beyond the profile that produces no event does not trigger it. In Lumped Mass an event beyond the profile also carries the `index` of the nearest end segment, but the physics keeps using the global `Kn`/`Kt` and the warning text says so. A segment without `type` still gets the variability and is listed as «sin tipo». In Lumped Mass the variability acts on `Kn`/`Kt`; barriers keep their own coefficients
- **Impact export**: CSV with one row per event, 200 events per rock and 100 000 rows overall, warning when events are dropped while maxima and counts keep every event. Blocked (button disabled) with fragmentation or after a cancelled run
- **Instrumentation invariant**: no extra `Math.random` draws, no change to draw order or count, no change to floating-point operations of the physical state; extra `getHeightAt` calls may only touch `_lastSegIdx`. Variabilities at 0 give trajectories bit-identical to P0.3 in runs without impacts beyond the profile ends; Lumped Mass is bit-identical with any variability

## CSS Variables

All colors use CSS custom properties on `:root`:
`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-card`,
`--text-primary`, `--text-secondary`, `--accent`, `--accent-hover`,
`--success`, `--warning`, `--border`, `--highlight`

## Key Classes

- **Terrain** (`js/terrain.js`): Stores polyline points, per-segment material properties (Cn/Ct/roughness per segment, which govern impacts in rigid-body and nonsmooth), world/canvas coordinate transforms, height lookup via interpolation.
- **Rock** (`js/physics.js`): Polygonal shape, mass, moment of inertia, collision handling (rigid-body impulse, lumped mass, nonsmooth dynamics), rolling friction models.
- **PhysicsEngine** (`js/physics.js`): Factory for Rock instances, time-stepping loop with sub-steps, parameter variation (Monte Carlo).
- **Simulation** (`js/simulation.js`): Manages rock array lifecycle, step loop, frame recording for timeline playback.
- **Renderer** (`js/renderer.js`): Canvas drawing — terrain, rocks, trajectories, bounce points, histogram. Timeline frame rendering.
- **Stats** (`js/stats.js`): Computes min/mean/max/std/P50/P83/P95 for energy, flight height, impact normal speed, impact energy, runout, velocity. CSV (including the per-event impact CSV) and text report generation.
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
