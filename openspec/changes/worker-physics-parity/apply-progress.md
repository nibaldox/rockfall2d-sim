# Apply Progress: worker-physics-parity

## Status

**Implementation complete — awaiting manual verification (Phase 5)**

## Summary

Implemented all 4 collision calculation methods (`lumped-mass`, `rigid-body`, `nonsmooth`, `energy-ratio`) in `WorkerRock` via a calcMethod dispatch, matching the main-thread `physics.js` structure. Added shoelace-based `momentOfInertia` computation, polygon area helper, deepest-penetration vertex finder, and roughness perturbation helper. Wired physics params from `app.js` config to worker message.

## Completed Tasks

### Phase 1: Foundation

- [x] **1.1** `this.momentOfInertia = this.computeMomentOfInertia()` called in `WorkerRock` constructor after shape generation
- [x] **1.2** `_polygonArea()` — shoelace formula, mirrors `physics.js computePolygonArea()`
- [x] **1.3** `computeMomentOfInertia()` — polygonal shoelace: `I = (rho/24) * Σ cross*(r1²+r1·r2+r2²)`
- [x] **1.4** `_findDeepestPenetrationVertex(terrain)` — iterates rotated shape vertices, returns `{contactIndex, contactX, contactY, terrainY}`

### Phase 2: Core Methods

- [x] **2.1** `_workerLumpedMass(terrain, kn, kt)` — point-mass, no angular velocity change, uses `kn`/`kt` instead of `cn`/`ct`
- [x] **2.2** `_workerNonsmooth(terrain, cn, mu)` — NSD Coulomb cone, uses `momentOfInertia`, `ct` as `mu`
- [x] **2.3** `_workerRigidBody(terrain, cn, ct, energyModel, energyRatio)` — impulse model with lever arm torque + energy-ratio sub-mode
- [x] **2.4** `_workerEnergyRatio(terrain, cn, energyRatio)` — standalone Hungr & Evans, separate dispatch case

### Phase 3: Wiring

- [x] **3.1** `handleCollision()` dispatch: `if/else if` chain on `this.calcMethod`, fallback `_workerLumpedMass`
- [x] **3.2** `runWorkerSimulation()` reads `calcMethod`, `Kn`, `Kt`, `energyModel`, `energyRatio` from config, assigns as properties on each `WorkerRock` instance

### Phase 4: Config

- [x] **4.1** `app.js` config object extended with `calcMethod`, `Kn`, `Kt`, `energyModel`, `energyRatio`, `rollingResistanceMethod`, `deformationCoef`

## Files Changed

| File | Action | Lines (approx) | What |
|------|--------|----------------|------|
| `js/worker.js` | Modified | +230 | Added `_polygonArea`, `computeMomentOfInertia`, `_findDeepestPenetrationVertex`, `_applyRoughnessPerturbation`, `_checkRest`, `_workerLumpedMass`, `_workerRigidBody`, `_workerNonsmooth`, `_workerEnergyRatio`; replaced `handleCollision()` body with dispatch; wired calcMethod params in rock construction |
| `js/app.js` | Modified | +6 | Extended `config` object in `_runWorker()` with physics params |

## Implementation Notes

- **No test framework**: all verification is manual (browser hard refresh Ctrl+Shift+R)
- **Default behavior preserved**: when `calcMethod` is absent/unrecognized, falls back to `lumped-mass` with default `Kn=0.35`, `Kt=0.75`
- **Rotation handling**: `_findDeepestPenetrationVertex` applies `this.rotation` rotation transform to local shape vertices before world-space computation, matching `physics.js` pattern
- **Roughness perturbation**: factored into `_applyRoughnessPerturbation()` helper, shared by all 4 collision methods
- **Rest check**: factored into `_checkRest()` helper, shared by all 4 collision methods
- **Energy tracking**: all methods preserve `totalEnergyDissipated`, `maxKineticEnergy`, `maxImpactVelocity`, `impactEnergies`, `bouncePoints`, `maxBounceHeight`

## Open Issues

None — implementation matches design spec.

## Verification Required (Phase 5 — Manual)

- [ ] **5.1** Worker mode: `lumped-mass` vs `rigid-body` produce measurably different bounce counts / maxBounceHeight
- [ ] **5.2** `lumped-mass` with non-zero `angularVelocity` → angularVelocity unchanged after bounce
- [ ] **5.3** `rigid-body` + `energyModel='energy-ratio'` produces lower bounce heights than `energyModel='impulse'`
- [ ] **5.4** Fragmentation: all N child fragments appear in stats output (no silent discard)
- [ ] **5.5** 100-rock worker simulation: no NaN in console, all rocks reach resting state

## Delivery

- Single PR
- Estimated changed lines: ~320 (within 400-line budget)
- Chained PRs: not recommended (medium risk, single PR acceptable per tasks.md)