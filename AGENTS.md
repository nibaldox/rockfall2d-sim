# AGENTS.md — RockFall 2D Simulator

## Project Overview

2D rockfall simulation web app. 100% vanilla JavaScript + HTML Canvas. Zero dependencies, no build tools, no bundler, no linter, no test framework.

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
├── css/style.css       # Dark theme, CSS variables for all colors
└── js/
    ├── terrain.js      # Terrain class — 2D polyline, coordinate transforms
    ├── physics.js      # Rock + PhysicsEngine — polygonal collision, impulse, torque
    ├── simulation.js   # Simulation controller — main loop, rock lifecycle
    ├── renderer.js     # Renderer — Canvas 2D drawing, histogram
    ├── stats.js        # Stats — statistics, CSV/text export
    └── app.js          # App — wiring, UI controls, DOM event handlers
```

JS files are loaded in order by `<script>` tags in `index.html`. Each file defines one or more ES6 classes on the global scope. No `import`/`export`, no modules.

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
4. Test by refreshing the browser

## Known Issues

- Profiles with >50 points cause slow simulation
- Release point near terrain may embed rocks
- >1,000 rocks saturates the canvas visually (trace limit needed)
