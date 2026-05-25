# Proposal: worker-physics-parity — Phase 1 SimRocas 2D Improvements

## Intent

Two targeted fixes to eliminate mass loss and physics method gaps between the main-thread simulation and the Web Worker:

1. **Fragment mass conservation**: Ensure every fragment created during rock breakup is retained in the simulation, preserving total mass balance.
2. **Worker physics parity**: The Worker currently uses a single hardcoded lumped-mass-like collision model. It must support all 4 physics methods (`rigid-body`, `lumped-mass`, `nonsmooth`) and both rigid-body energy models (`impulse`, `energy-ratio`) that the main thread exposes.

## Scope

### In Scope
- Add `calcMethod`, `energyModel`, `energyRatio`, `kn`, `kt`, `rollingFriction`, `rollingModel`, `deformationCoef`, `correlatedParams` to the worker config
- Wire those config fields through `app.js` `_runWorker()` to the worker's `runWorkerSimulation()`
- Implement all 4 collision methods in `WorkerRock.handleCollision()` — dispatch based on `calcMethod`
- Implement `_workerLumpedMass()`, `_workerNonsmooth()`, `_workerRigidBody()` in worker (matching `physics.js` methods)
- Expose `momentOfInertia` on `WorkerRock` (needed for rigid-body and NSD torque)
- Preserve all N fragments in `workerFragmentRock()` — no discard of smallest fragment
- Add `fragmentRock` config passthrough to ensure worker uses same fragmentation logic as main thread

### Out of Scope
- Fixing the `WorkerRock` mass formula (sphere vs. polygon — this is pre-existing in both threads)
- Adding new physics methods
- Performance profiling or sub-step tuning
- Changes to the STL slice or structural failure modules

## Capabilities

### New Capabilities
- `worker-collision-methods`: Worker now supports rigid-body (impulse + energy-ratio), lumped-mass (Kn/Kt), and nonsmooth dynamics (Coulomb cone) — matching the main thread fully.

### Modified Capabilities
- `block-fragmentation`: Clarified that ALL N fragments (2 or 3) must be retained — no mass is discarded. This was likely a latent bug where the calling code on the main thread may drop fragments if a condition was missed.

## Approach

**Change 1 — Worker config extension:**
Add all missing physics parameters to the `config` object in `app.js` `_runWorker()` (lines 1473–1484) and read them in `runWorkerSimulation()`. Pass them to `WorkerRock` instances where needed.

**Change 2 — Worker collision dispatch:**
`WorkerRock.handleCollision(terrain, cn, ct)` currently implements only a single simplified impulse model. Replace body with a switch on `calcMethod` that calls `_workerLumpedMass`, `_workerNonsmooth`, or `_workerRigidBody`. These mirror the corresponding methods in `physics.js` but without vertex cache invalidation (worker has no rendering).

**Change 3 — Moment of inertia:**
Add `computeMomentOfInertia()` to `WorkerRock` (currently missing). Use the same polygonal shoelace formula as `physics.js`.

**Change 4 — Fragment retention verification:**
Audit `workerFragmentRock()` — it already builds ALL N children into the `children` array (lines 493–517). Verify that calling code in `runWorkerSimulation()` (lines 381–385) pushes all returned children unconditionally. Confirm the same in `physics.js` + `simulation.js` path.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `js/app.js` | Modified | Add physics config fields to worker message (lines ~1473–1484) |
| `js/worker.js` | Modified | Collision dispatch, 3 new collision methods, momentOfInertia, fragment retention audit |
| `js/physics.js` | No change | Source of truth for collision algorithms (reference only) |
| `js/simulation.js` | No change | Main-thread fragment handling (reference only) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Worker collision regression | Med | Add console.log/console.warn in worker for first 1000 messages; compare worker vs. main-thread bounce counts on test profile |
| Performance regression from NSD | Med | NSD is more expensive; add early-exit if rock is far from terrain. Profile before/after with 100+ rocks |
| Mass conservation regression | Low | Add post-simulation mass sum check in app.js: sum(parent masses) should equal sum(child masses) ± 1e-6 |
| Breaking existing worker results | Med | Keep calcMethod default as current behavior ('lumped-mass' style) so existing users see no change unless they switch |

## Rollback Plan

- **Single-file rollback**: All changes are isolated to `js/worker.js` and `js/app.js`
- Revert `js/app.js` config additions by deleting the new fields from the `config` object
- Revert `js/worker.js` collision dispatch by restoring the original `handleCollision` body
- Test: load app, select "Worker" mode, run 10 rocks, verify bounce counts match before/after

## Dependencies

- Physics algorithms must remain synchronized with `physics.js` — if `_handleRigidBody` or `_handleNonsmooth` changes in `physics.js`, the worker equivalents must be updated in the same commit
- No external dependencies; vanilla JS

## Success Criteria

- [ ] Worker accepts and uses `calcMethod` from config; switching methods changes bounce heights measurably
- [ ] All N fragments (N=2 or N=3) appear in the simulation after fragmentation — no fragment is silently dropped
- [ ] Total mass before fragmentation ≈ sum of masses of all child fragments (within floating-point tolerance)
- [ ] Worker trajectory results match main-thread results within ±5% for bounce count and runout distance for all 4 methods
- [ ] 100-rock worker simulation completes without error; no NaN velocities or positions