# Tasks: worker-physics-parity — Phase 1 SimRocas 2D Improvements

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 280–340 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

## Phase 1: Foundation — WorkerRock property and method additions

- [x] 1.1 In `js/worker.js` `WorkerRock` constructor, after `this.mass = ...` line, compute and assign `this.momentOfInertia = this.computeMomentOfInertia()`
- [x] 1.2 In `js/worker.js` `WorkerRock`, add `_polygonArea()` private method — shoelace formula, mirror of `physics.js computePolygonArea()`
- [x] 1.3 In `js/worker.js` `WorkerRock`, add `computeMomentOfInertia()` method — shoelace formula per design lines 73–90
- [x] 1.4 In `js/worker.js` `WorkerRock`, add `_findDeepestPenetrationVertex(terrain)` helper returning `{contactIndex, contactX, contactY, terrainY}` — used by rigid-body, NSD, energy-ratio

## Phase 2: Core — Three new collision methods on WorkerRock

- [x] 2.1 In `js/worker.js` `WorkerRock`, add `_workerLumpedMass(terrain, kn, kt)` — lumped-mass point-mass collision, no angular velocity change, matches design lines 113–121
- [x] 2.2 In `js/worker.js` `WorkerRock`, add `_workerNonsmooth(terrain, cn, mu)` — NSD Coulomb cone, uses `momentOfInertia`, contact velocity at vertex, mu=ct, matches design lines 146–156
- [x] 2.3 In `js/worker.js` `WorkerRock`, add `_workerRigidBody(terrain, cn, ct, energyModel, energyRatio)` — rigid-body impulse + energy-ratio sub-modes, lever arm torque, matches design lines 123–144
- [x] 2.4 In `js/worker.js` `WorkerRock`, add `_workerEnergyRatio(terrain, cn, energyRatio)` — standalone Hungr & Evans energy-ratio bounce, separate dispatch case per spec

## Phase 3: Wiring — Replace handleCollision body with calcMethod dispatch

- [x] 3.1 In `js/worker.js` `WorkerRock.handleCollision()`, replace the entire method body with a `switch (this.calcMethod)` dispatch calling the 4 methods above with `default: _workerLumpedMass`, preserving bounce counting, energy tracking, rest check, and roughness perturbation from original body
- [x] 3.2 In `js/worker.js` `runWorkerSimulation()`, read new config fields `calcMethod`, `Kn`, `Kt`, `energyModel`, `energyRatio`, `rollingResistanceMethod`, `deformationCoef` and assign them as properties on each `WorkerRock` instance at construction time (lines 306–320)

## Phase 4: Config — Wire physics params from app.js to worker message

- [x] 4.1 In `js/app.js` `runSimulationWithWorker()` around line 1473, extend the `config` object: add `calcMethod`, `Kn`, `Kt`, `energyModel`, `energyRatio`, `rollingResistanceMethod`, `deformationCoef` — map from `this.physics` using existing `this.simulation.physics` accessors

## Phase 5: Verification — Manual test scenarios

- [ ] 5.1 Manual: Run same profile in Worker mode with `lumped-mass` vs `rigid-body` — verify bounce counts and maxBounceHeight differ measurably
- [ ] 5.2 Manual: Set angularVelocity non-zero, run `lumped-mass` — verify angularVelocity stays unchanged after bounce
- [ ] 5.3 Manual: Run `rigid-body` with `energyModel='energy-ratio'` vs `energyModel='impulse'` — verify energy-ratio produces lower bounce heights
- [ ] 5.4 Manual: Enable fragmentation, run 20 rocks in Worker mode — verify all child fragments appear (count children in stats output)
- [ ] 5.5 Manual: Run 100-rock Worker simulation — verify no NaN in console, all rocks reach resting state