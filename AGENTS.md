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
- Resting condition (`Rock._checkResting`): at least 3 accumulated checks (the counter is not reset on collisions), speed below 0.08 m/s scaled by the local slope as `max(0.1, 1 - 2 * |slope|)`, `|ω| < 0.5 rad/s`, and more than 2 detected contacts or sustained contact. Sustained contact exists only in Lumped Mass, with `|vn| < 0.5 m/s`; `ignoreResting` skips the check
- `bounces` is an internal contact counter: it increases on every detected penetration in rigid-body and nonsmooth, and also on barriers and Lumped Mass impacts. It is not an impact count; the UI and exports label it "Contactos detectados". The impact figure is `impactCount` (see below); do not swap the two labels
- Coarse time step: with dt > 0.02 s in rigid-body or nonsmooth, resting may go undetected. From P0.3 a non-blocking `dtGrueso` warning is shown in the status, report and CSV; it does not replace a time-step convergence study
- Finite zeros: from P0.3, valid finite zeros of the parameters (e.g. Cn, Ct, rolling and variabilities) are preserved; non-finite or out-of-domain values fall back to the default
- Boundary culling: rocks outside [-50, 500] X or below -100 Y are terminated
- Max steps per rock: 5,000

## Impact Instrumentation (P0.2-β)

- **Real impact (C1)**: an event is logged on a surface (terrain or barrier `i`) only when the existing approach guard passes, the normal approach speed satisfies `|vn| >= 0.5 m/s`, and no episode is open on that surface. The episode opens on the first sub-step with detected contact and closes on the first sub-step without it, so a single bounce is not counted once per sub-step. Capture is read-only and happens **before** the impulse. In nonsmooth with polygons the impact count includes vertex strikes while the rock topples, and `vn` is the normal velocity of the contact point (it includes `ω × r`), not of the centre
- **Per-rock fields**: `impactCount`, `maxImpactNormalSpeed`, `maxImpactSpeed`, `maxImpactContactSpeed`, `maxImpactEnergy` (J), `maxFlightHeight` and `droppedImpactEvents`, plus `impactEvents` (first 200 events in time order, keys `t`, `x`, `y`, `surface`, `index`, `vn`, `speed`, `contactSpeed`, `energy`, `cnEff`, `ctEff`, `flightHeightBefore`). `contactSpeed` is null in Lumped Mass and on barriers
- **Flight height (C3)**: a flight starts after a C1 event and ends at the next sub-step with detected contact on any surface. The sample is the **rock centre** measured vertically over the terrain as `y - terrain.getHeightAt(x)`, only when x lies inside the profile and the segment exists. The initial fall from release does not count; the value is null when there was no valid sample. It is not a bounce height, not a collector height and not a RocFall figure
- **Materials per segment (U4)**: in rigid-body and nonsmooth the impact is governed by the segment's own `cn`, `ct` and roughness. The Cn/Ct variability (percent, `1 ± u·variabilidad/100`, same draws as before) multiplies each segment's value and the result is clamped to [0, 1]. The global Cn/Ct inputs are disabled in all three methods: they only act on profiles with fewer than 2 points. An impact beyond the ends of the profile (its horizontal extension) uses the Cn and Ct of the nearest end segment (no roughness beyond the profile), with the same variability factor, and Stats emits the `fueraDelPerfil` warning. The warning looks at the x of the rock centre in the C1 events: a contact beyond the profile that produces no event does not trigger it. In Lumped Mass an event beyond the profile also carries the `index` of the nearest end segment, but the physics keeps using the global `Kn`/`Kt` and the warning text says so. A segment without `type` still gets the variability and is listed as «sin tipo». In Lumped Mass the same variability acts on `Kn`/`Kt`; barriers keep their own coefficients
- **Impact export**: one CSV row per event, capped at 200 events per rock and 100 000 rows overall, with a visible warning when events are dropped. Per-rock maxima and counts always include every event. The export is blocked (and its button disabled) while fragmentation is active or the run was cancelled
- **Invariant for engine changes**: instrumentation is read-only. It adds no `Math.random` draw, keeps the number and order of draws unchanged, and does not alter floating-point operations of the physical state. Extra `getHeightAt` calls may only touch the `_lastSegIdx` cache. With Cn/Ct variabilities at 0, trajectories are bit-identical to P0.3 in runs without impacts beyond the profile ends (those change on purpose: end-segment material instead of the globals); Lumped Mass is bit-identical with any variability

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
