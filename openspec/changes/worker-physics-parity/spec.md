# Delta for worker-physics-parity — Spec

## ADDED Requirements

### Requirement: Worker exposes `calcMethod` dispatch

The worker MUST accept `calcMethod` as part of the config object and dispatch collision handling to the correct algorithm: `rigid-body`, `lumped-mass`, `nonsmooth`, or `energy-ratio`. The default when `calcMethod` is absent or unrecognized MUST be `lumped-mass` (preserving existing behavior).

The worker MUST expose `momentOfInertia` on `WorkerRock` as a numeric property, computed at construction from the polygonal shape via the shoelace formula, matching `physics.js` `Rock.computeMomentOfInertia()`.

### Requirement: `rigid-body` collision method

When `calcMethod === 'rigid-body'`, `WorkerRock.handleCollision()` MUST call `_workerRigidBody(terrain, cn, ct, energyModel, energyRatio)` implementing:

**Contact detection**: Iterate all shape vertices, find deepest penetration below terrain, use that vertex as contact point.

**Impulse model** (when `energyModel === 'impulse'` or absent):
1. Compute contact point lever arm: `rx = contactX - this.x`, `ry = contactY - this.y`
2. Compute contact velocity: `vContactX = this.vx - angularVelocity * ry`, `vContactY = this.vy + angularVelocity * rx`
3. Compute `vDotN = vContactX * nx + vContactY * ny`; if `vDotN >= 0` return (separating)
4. Compute normal impulse: `rCrossN = rx * rny - ry * rnx`, `denom = 1/mass + (rCrossN²)/momentOfInertia`, `j = -(1 + cn) * vDotN / denom`
5. Update velocity: `vx += j * nx / mass`, `vy += j * ny / mass`
6. Update angular velocity: `angularVelocity += rCrossN * j / momentOfInertia`
7. Compute tangential impulse via Coulomb stick/slip: `tangentX = -rny`, `tangentY = rnx`, `vDotT`, `rCrossT`, `jt = (1 - ct) * vDotT / denomT`, clamp `jt` to `[-ct * |j|, ct * |j|]`
8. Apply tangential impulse to vx, vy, angularVelocity

**Energy-ratio model** (when `energyModel === 'energy-ratio'`):
1. Decompose velocity into normal and tangential components
2. Scale normal component by `Math.sqrt(energyRatio)` (energy retained = energyRatio)
3. Scale tangential component by `Math.sqrt(energyRatio)`
4. Scale `angularVelocity` by `Math.sqrt(energyRatio)`

In both models: apply stochastic roughness perturbation to the normal vector before computing impulses, and clamp rock position to `terrainY + 0.01` after collision.

#### Scenario: rigid-body impulse — bounce with rotation

- GIVEN a rock with diameter 0.5m, density 2500, `calcMethod='rigid-body'`, `energyModel='impulse'`, `cn=0.6`, `ct=0.4`
- WHEN the rock impacts terrain at 8 m/s with angular velocity 0
- THEN bounce count increases by 1, velocity normal component reverses with coefficient `cn`, tangential component reduced by `(1-ct)`, and angular velocity changes due to lever arm torque

#### Scenario: rigid-body energy-ratio — energy-preserving bounce

- GIVEN a rock with `calcMethod='rigid-body'`, `energyModel='energy-ratio'`, `energyRatio=0.7`
- WHEN the rock impacts terrain at 10 m/s
- THEN speed after bounce = `10 * sqrt(0.7)` ≈ 8.37 m/s, angular velocity scaled by same factor

---

### Requirement: `lumped-mass` collision method

When `calcMethod === 'lumped-mass'`, `WorkerRock.handleCollision()` MUST call `_workerLumpedMass(terrain, kn, kt)` implementing:

1. Compute `terrainY = terrain.getHeightAt(this.x)`, skip if `penetration <= 0`
2. Decompose velocity: `vn = vx * nx + vy * ny`, skip if `vn >= 0` (separating)
3. Apply `kn` and `kt`: `vx = -kn * vn * nx + kt * (vx - vn * nx)`, `vy = -kn * vn * ny + kt * (vy - vn * ny)`
4. Clamp `y = max(terrainY + 0.01, y)`
5. Angular velocity MUST NOT be updated (point mass — no rotation)

The segment's `cn`/`ct` are ignored for velocity update when using lumped-mass; only `kn`/`kt` apply.

#### Scenario: lumped-mass — no angular velocity change after bounce

- GIVEN a rock with `calcMethod='lumped-mass'`, `kn=0.6`, `kt=0.4`, initial `angularVelocity=2.0 rad/s`
- WHEN the rock bounces on terrain
- THEN `vx` and `vy` are updated using `kn`/`kt`, but `angularVelocity` remains unchanged at 2.0 rad/s

---

### Requirement: `nonsmooth` collision method

When `calcMethod === 'nonsmooth'`, `WorkerRock.handleCollision()` MUST call `_workerNonsmooth(terrain, cn, mu)` implementing:

1. Find deepest-penetrating vertex as contact point
2. Compute contact velocity at that vertex: `vContact = this.v - this.angularVelocity × r`
3. Compute normal impulse via Poisson law: `jn = -(1 + cn) * vDotN / (1/mass + rCrossN²/momentOfInertia)`
4. Apply normal impulse to `vx`, `vy`, `angularVelocity`
5. Compute tangential impulse with Coulomb cone: `jtFree = -vDotT / (1/mass + rCrossT²/momentOfInertia)`, clamp to `[-mu * |jn|, mu * |jn|]`
6. Apply tangential impulse; set `y = terrainY + 0.01`

The parameter `cn` is the Poisson restitution coefficient; `ct` is not used — friction is governed by `mu` (friction coefficient from `config.ct` or segment `ct`).

#### Scenario: nonsmooth — Coulomb stick/slip on low-friction surface

- GIVEN a rock with `calcMethod='nonsmooth'`, `cn=0.5`, `ct=0.2` (used as mu), `momentOfInertia=0.05 kg·m²`
- WHEN the rock contacts terrain with high tangential velocity
- THEN tangential impulse is clamped to `mu * |jn|`, producing stick when friction is sufficient and slip when it is not

---

### Requirement: `energy-ratio` as a top-level calcMethod

When `calcMethod === 'energy-ratio'`, `WorkerRock.handleCollision()` MUST call `_workerEnergyRatio(terrain, cn, energyRatio)` implementing the Hungr & Evans energy-ratio method:

1. Decompose velocity at contact: `vn = vx * nx + vy * ny`, `vtX = vx - vn * nx`, `vtY = vy - vn * ny`
2. Compute bounce speed: `speedAfter = |vn| * sqrt(energyRatio)`
3. Recompose: `vx = vtX * sqrt(energyRatio) - vn * sqrt(energyRatio) * nx`, same for vy
4. Scale `angularVelocity *= sqrt(energyRatio)`

This is a separate dispatch case, not a sub-mode of `rigid-body`.

#### Scenario: energy-ratio — bounce height proportional to energyRatio

- GIVEN a rock with `calcMethod='energy-ratio'`, `cn=0.6`, `energyRatio=0.5`
- WHEN the rock falls 20m and impacts terrain at ~19.8 m/s
- THEN bounce height ≈ `0.5 * (19.8)² / (2 * 9.81)` ≈ 10m (proportional to energyRatio)
- AND bounce count for a 30m slope is measurably lower than the same rock with `energyRatio=0.8`

---

### Requirement: Angular velocity in rigid-body and NSD collisions

For both `rigid-body` and `nonsmooth` methods, the worker MUST compute torque from the contact point lever arm:

- Lever arm vector: `r = (contactX - rock.x, contactY - rock.y)`
- Cross product (2D): `rCrossN = rx * rny - ry * rnx` (for normal impulse), `rCrossT` (for tangential)
- Angular acceleration contribution: `deltaOmega = rCrossN * j / momentOfInertia`

`momentOfInertia` MUST be available on `WorkerRock` via `computeMomentOfInertia()`, called at construction time and stored as a property. The formula uses the polygonal shoelace method identical to `physics.js`:
`I = (rho / 24) * Σ over edges (r1² + r1·r2 + r2²) * (r1 × r2)`

Where `rho = mass / polygonArea`.

#### Scenario: torque from off-center contact

- GIVEN a rock with `momentOfInertia=0.04 kg·m²`, angular velocity 0, contacting terrain at a vertex 0.15m from center
- WHEN `calcMethod='rigid-body'`, `cn=0.6`, `ct=0.4`, impact speed 6 m/s
- THEN angular velocity after bounce is non-zero, proportional to `rCrossN * j / I`

---

### Requirement: Config params passed from app.js to worker

The worker message (`msg.config`) received by `runWorkerSimulation()` MUST include these fields when present in `app.js` `_runWorker()` config:

| Parameter | Type | Used by | Purpose |
|-----------|------|---------|---------|
| `calcMethod` | string | `handleCollision` dispatch | Select collision algorithm |
| `cn` | number | rigid-body, NSD, energy-ratio | Normal restitution / Poisson coefficient |
| `ct` | number | rigid-body (impulse), NSD (mu) | Tangential restitution or friction coefficient |
| `Kn` | number | lumped-mass | Normal restitution coefficient |
| `Kt` | number | lumped-mass | Tangential restitution coefficient |
| `energyModel` | string | rigid-body | `'impulse'` or `'energy-ratio'` sub-mode |
| `energyRatio` | number | rigid-body (energy-ratio), energy-ratio | Energy retained per bounce (0–1) |
| `rollingResistanceMethod` | string | rolling friction | `'simple'` or `'davis-mcinnnes'` |
| `deformationCoef` | number | rolling friction (davis-mcinnnes) | Soil deformation coefficient |
| `fragmentationEnabled` | boolean | fragmentation | Enable/disable rock breakup |
| `fractureEnergy` | number | fragmentation | Impact energy threshold for breakup (J) |
| `fractureDissipation` | number | fragmentation | Energy lost to fracture (0–1) |
| `shapeType` | string | WorkerRock construction | `'sphere'`\|`'polygon'`\|`'ellipse'`\|`'block'` |
| `aspectRatio` | number | WorkerRock construction | Shape aspect ratio |

Defaults: `calcMethod='lumped-mass'`, `cn=0.6`, `ct=0.4`, `Kn=0.6`, `Kt=0.4`, `energyRatio=0.5`, `rollingResistanceMethod='simple'`, `fragmentationEnabled=true`, `fractureEnergy=25000`, `fractureDissipation=0.4`.

## MODIFIED Requirements

### Requirement: block-fragmentation — all N fragments retained

**Previously**: Fragmentation may silently discard the smallest fragment, causing mass loss.

All N child rocks produced by fragmentation MUST be pushed unconditionally into the simulation's rock array. The `workerFragmentRock()` function already constructs all N children; the calling code in `runWorkerSimulation()` MUST push every returned child without filtering or discarding any.

No fragment mass is to be discarded. Total mass after fragmentation = sum of child masses (within floating-point tolerance ±1e-10 kg).

#### Scenario: 3-fragment breakup — all children appear in simulation

- GIVEN fragmentation produces 3 children with masses [m1, m2, m3]
- WHEN the parent rock breaks up
- THEN 3 new rocks appear in the rocks array with `generation = parent.generation + 1`, `parentId = parent.id`
- AND total mass m1 + m2 + m3 equals parent mass within ±1e-10 kg

## REMOVED Requirements

None — this change adds only.