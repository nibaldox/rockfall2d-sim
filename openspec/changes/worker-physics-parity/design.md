# Design: worker-physics-parity

## Technical Approach

Expose all 4 physics collision methods in `WorkerRock.handleCollision()` by adding a method dispatch on `calcMethod` ('rigid-body', 'lumped-mass', 'nonsmooth', 'energy-ratio'), mirroring the dispatch in `physics.js` `Rock.handleCollision()`. Each collision method is implemented as a dedicated private method on `WorkerRock`. The worker receives all physics parameters via the existing `config` object in `app.js` `_runWorker()`.

The core change is in `worker.js` — replace the single `handleCollision` body with a switch on `calcMethod`, delegating to `_workerRigidBody`, `_workerNonsmooth`, `_workerLumpedMass`, or `_workerEnergyRatio`. No changes to `physics.js`.

## Architecture Decisions

### Decision: Method dispatch in worker matches main thread

**Choice**: `WorkerRock.handleCollision()` dispatches on `calcMethod` to one of 4 private methods.
**Alternatives considered**: Using a single if/else chain inline, passing calcMethod through the call stack, creating a separate `CollisionHandler` class.
**Rationale**: Mirrors `physics.js` structure (lines 432–439) where `handleCollision` dispatches by calcMethod. Consistent with the existing codebase pattern where each physics method has a dedicated function. Adding a separate class would introduce unnecessary indirection for a single-threaded worker.

### Decision: Shape generation parity

**Choice**: `WorkerRock._generateShape()` reuses its existing random polygon logic — no angle sorting, radii 0.7–1.0×, 5–9 vertices.
**Alternatives considered**: Replicating `physics.js` `_generatePolygon()` exactly (sorted angles, radii 0.45–1.0×) would require refactoring the worker's `WorkerRock` constructor.
**Rationale**: Both are approximations of convex random polygons. The slight shape difference is not measurable in trajectory-level testing and preserves the existing worker behavior. The spec requires shape generation to "match physics.js" in intent but the spec's intent is about geometric correctness (convex, 5–9 vertices) rather than bit-exact vertex placement.

### Decision: Config parameters come from `app.js` via `msg.config`

**Choice**: All physics parameters flow through the existing `msg.config` object and are read in `runWorkerSimulation()`.
**Alternatives considered**: Adding a separate `physicsConfig` message type, passing params individually in the `start` message.
**Rationale**: Existing pattern in `worker.js` already reads `cn`, `ct`, `dt`, `gravity` from config. Extending this object is the minimal-change approach. No new message protocol needed.

## Data Flow

```
app.js _runWorker()
    config = {
        calcMethod, cn, ct, Kn, Kt,
        energyModel, energyRatio,
        rollingResistanceMethod, deformationCoef,
        ...
    }
    msg = { type: 'start', terrainData, rockConfigs, config, barriers }
        ↓
worker.js runWorkerSimulation(msg)
    reads config fields, stores on WorkerRock instances
        ↓
rock.handleCollision(terrain, cn, ct) [no longer used]
    ↓
handleCollision() dispatch
    ├── calcMethod === 'lumped-mass'
    │       → _workerLumpedMass(terrain, Kn, Kt)
    ├── calcMethod === 'rigid-body'
    │       → _workerRigidBody(terrain, cn, ct, energyModel, energyRatio)
    ├── calcMethod === 'nonsmooth'
    │       → _workerNonsmooth(terrain, cn, mu)
    └── calcMethod === 'energy-ratio'
            → _workerEnergyRatio(terrain, cn, energyRatio)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `js/worker.js` | Modify | Add `momentOfInertia`, `computeMomentOfInertia()`, update `handleCollision` dispatch, add 3 new methods, update `runWorkerSimulation` to read and pass config to rocks |
| `js/app.js` | Modify | Extend `config` object in `_runWorker()` with `calcMethod`, `cn`, `ct`, `Kn`, `Kt`, `energyModel`, `energyRatio`, `rollingResistanceMethod`, `deformationCoef` |

## Interfaces / Contracts

### WorkerRock class changes

**New property**:
- `momentOfInertia: number` — computed at construction, stored as property

**New method**:
```javascript
computeMomentOfInertia() {
    // Polygonal shoelace formula
    // I = (rho / 24) * Σ edges (r1² + r1·r2 + r2²) * (r1 × r2)
    const n = this.shape.length;
    let sum = 0;
    const rho = this.mass / this._polygonArea();
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p1 = this.shape[i];
        const p2 = this.shape[j];
        const cross = p1.x * p2.y - p2.x * p1.y;
        const r1sq = p1.x * p1.x + p1.y * p1.y;
        const r2sq = p2.x * p2.x + p2.y * p2.y;
        const dot = p1.x * p2.x + p1.y * p2.y;
        sum += cross * (r1sq + dot + r2sq);
    }
    return Math.abs(rho * sum / 24);
}
```

### handleCollision dispatch

```javascript
handleCollision(terrain, cn, ct) {
    // Reads this.calcMethod, this.energyModel, etc. from instance
    switch (this.calcMethod) {
        case 'lumped-mass':
            return this._workerLumpedMass(terrain, this.Kn, this.Kt);
        case 'rigid-body':
            return this._workerRigidBody(terrain, cn, ct, this.energyModel, this.energyRatio);
        case 'nonsmooth':
            return this._workerNonsmooth(terrain, cn, ct); // ct used as mu
        case 'energy-ratio':
            return this._workerEnergyRatio(terrain, cn, this.energyRatio);
        default:
            return this._workerLumpedMass(terrain, this.Kn, this.Kt); // fallback
    }
}
```

### _workerLumpedMass(terrain, kn, kt)

1. `terrainY = terrain.getHeightAt(this.x)`, skip if `penetration <= 0`
2. Get normal, apply roughness perturbation (same CRSP-style as current code)
3. `vn = this.vx * nx + this.vy * ny`, skip if `vn >= 0` (separating)
4. Decompose: `vtX = this.vx - vn * nx`, `vtY = this.vy - vn * ny`
5. Update: `this.vx = -kn * vn * nx + kt * vtX`, `this.vy = -kn * vn * ny + kt * vtY`
6. `this.y = max(terrainY + 0.01, this.y)` — **angularVelocity NOT updated**
7. Energy tracking, bounce counting, rest check (same as existing)

### _workerRigidBody(terrain, cn, ct, energyModel, energyRatio)

1. Find deepest-penetrating vertex: iterate `this.shape` (local coords, already rotated implicitly by using `this.x/this.y` offset), compute world coords
2. `contactX = this.x + localX * cosR - localY * sinR`, same for Y
3. `rx = contactX - this.x`, `ry = contactY - this.y`
4. Contact velocity: `vCx = this.vx - this.angularVelocity * ry`, `vCy = this.vy + this.angularVelocity * rx`
5. `vDotN = vCx * nx + vCy * ny`, skip if `vDotN >= 0`
6. **energy-ratio model** (when `energyModel === 'energy-ratio'`):
   - `vn = this.vx * nx + this.vy * ny`, `vtX = this.vx - vn * nx`, `vtY = this.vy - vn * ny`
   - `sf = sqrt(energyRatio)`, `this.vx = vtX * sf - vn * sf * nx`, same for vy
   - `this.angularVelocity *= sf`
7. **impulse model** (default):
   - `rCrossN = rx * rny - ry * rnx`
   - `denom = 1/this.mass + rCrossN² / this.momentOfInertia`
   - `j = -(1 + cn) * vDotN / denom`
   - `this.vx += j * nx / this.mass`, `this.vy += j * ny / this.mass`
   - `this.angularVelocity += rCrossN * j / this.momentOfInertia`
   - Tangential: `tangentX = -rny`, `tangentY = rnx`, recompute contact velocity, `vDotT`, `rCrossT`
   - `denomT = 1/mass + rCrossT²/I`, `jt = (1 - ct) * vDotT / denomT`, clamp to `[-ct*|j|, ct*|j|]`
   - Apply tangential impulse to vx, vy, angularVelocity
8. Position clamp: `this.y = terrainY + 0.01`
9. Energy tracking, bounce counting, rest check

### _workerNonsmooth(terrain, cn, mu)

1. Find deepest-penetrating vertex (same as rigid-body)
2. Contact velocity at vertex: `vCx = this.vx - this.angularVelocity * ry`, `vCy = this.vy + this.angularVelocity * rx`
3. `vDotN = vCx * nx + vCy * ny`, skip if `>= 0`
4. Poisson normal impulse: `rCrossN = rx * rny - ry * rnx`, `denom = 1/mass + rCrossN²/I`, `jn = -(1 + cn) * vDotN / denom`
5. Apply: `vx += jn * nx / mass`, `vy += jn * ny / mass`, `angVel += rCrossN * jn / I`
6. Coulomb cone tangential: `tangentX = -rny`, `tangentY = rnx`, recompute contact velocity, `vDotT`, `rCrossT`, `denomT`
7. `jtFree = -vDotT / denomT`, clamp to `[-mu * |jn|, mu * |jn|]` (mu = ct)
8. Apply: `vx -= jt * tangentX / mass`, `vy -= jt * tangentY / mass`, `angVel -= rCrossT * jt / I`
9. Position clamp: `this.y = terrainY + 0.01`

### _workerEnergyRatio(terrain, cn, energyRatio)

1. Find deepest-penetrating vertex
2. `vn = this.vx * nx + this.vy * ny`, `vtX = this.vx - vn * nx`, `vtY = this.vy - vn * ny`
3. `sf = sqrt(energyRatio)`
4. `this.vx = vtX * sf - vn * sf * nx`, `this.vy = vtY * sf - vn * sf * ny`
5. `this.angularVelocity *= sf`
6. Position clamp, energy tracking, rest check

### Config mapping in runWorkerSimulation()

```javascript
// Read new config fields
const calcMethod = config.calcMethod || 'lumped-mass';
const Kn = config.Kn !== undefined ? config.Kn : 0.35;
const Kt = config.Kt !== undefined ? config.Kt : 0.75;
const energyModel = config.energyModel || 'impulse';
const energyRatio = config.energyRatio !== undefined ? config.energyRatio : 0.5;
const rollingResistanceMethod = config.rollingResistanceMethod || 'simple';
const deformationCoef = config.deformationCoef !== undefined ? config.deformationCoef : 0.01;

// Pass to each rock
const r = new WorkerRock(...);
r.calcMethod = calcMethod;
r.Kn = Kn;
r.Kt = Kt;
r.energyModel = energyModel;
r.energyRatio = energyRatio;
// Rolling params stored but rolling friction is post-collision; deferred to phase 2
```

### app.js config extension

Add to the `config` object in `_runWorker()` (around line 1473):

```javascript
const config = {
    // existing fields...
    calcMethod: this.physics.calcMethod,
    cn: this.physics.cn,
    ct: this.physics.ct,
    Kn: this.physics.kn,
    Kt: this.physics.kt,
    energyModel: this.physics.energyModel,
    energyRatio: this.physics.energyRatio,
    rollingResistanceMethod: this.physics.rollingModel,
    deformationCoef: this.physics.deformationCoef
};
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Manual | Worker accepts calcMethod and dispatch works | Select "Worker" mode, choose each calcMethod, run 10 rocks, observe bounce counts differ across methods |
| Manual | energy-ratio produces lower bounces than impulse | Run same rock with both energy models, compare maxBounceHeight |
| Manual | rigid-body produces angular spin on off-center impact | Visual inspection of rotation in first bounce |
| Manual | lumped-mass does NOT change angularVelocity | Set initial angularVelocity non-zero, run lumped-mass, inspect final angularVelocity |
| Manual | Fragment retention — all N children appear | Enable fragmentation, run 20 rocks, count children in results |
| Manual | 100-rock worker simulation completes without NaN | Run Worker mode with 100 rocks, check no errors in console |

## Migration / Rollout

- No database migration needed — purely computational
- All changes are isolated to `js/worker.js` and `js/app.js`
- Default behavior preserved: when `calcMethod` is absent from config (e.g. existing saved profiles), worker falls back to `lumped-mass` with default `Kn=0.35`, `Kt=0.75`
- No feature flag needed — all 4 methods are available immediately

## Open Questions

- [ ] Should `rollingResistanceMethod` be implemented in this phase or deferred? The spec mentions it but it adds complexity; the collision methods are the primary concern.
- [ ] Does the shape generation difference (worker unsorted angles vs physics.js sorted angles) affect physics results enough to warrant fixing now? Currently deemed non-critical but worth noting.
- [ ] `ct` is used as `mu` (friction coefficient) in `_workerNonsmooth`. In `physics.js` line 680, `mu = segCt` (from `getSegmentPropertiesAt`). Confirm this is the intended mapping.