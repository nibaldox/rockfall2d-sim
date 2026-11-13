# Contratos 3D (C7) — SimRocas

Contrato congelado para la física 3D (fase F4, masa concentrada), el controlador de simulación, las zonas fuente, el pool de Workers y los rásteres de resultados. Todos los módulos son scripts clásicos que cuelgan de `globalThis.SimRocas` dentro de un IIFE y funcionan en ventana, Web Worker y Node (`tests/helpers/load.js`).

## Sistema de coordenadas

- Coordenadas **locales del DEM** (`SimRocas.Dem`): `x` este, `y` norte, `z` arriba, en metros. Nunca se simula en coordenadas UTM; el origen Float64 vive en el `Dem`.
- Gravedad: `(0, 0, -g)`.
- Terreno: `dem.heightAt(x, y)` y `dem.normalAt(x, y, out)`; `NaN`/`null` = sin dato.

## `SimRocas.V3` (js/math3d.js)

Funciones escalares sin asignación sobre objetos `{x, y, z}` con parámetro `out`:
`set(out, x, y, z)`, `copy(out, a)`, `add(out, a, b)`, `sub(out, a, b)`, `scale(out, a, s)`, `addScaled(out, a, b, s)`, `dot(a, b)`, `cross(out, a, b)`, `length(a)`, `normalize(out, a)` (devuelve longitud; vector nulo → (0,0,0)), `rotateAroundAxis(out, v, axisUnit, angleRad)` (Rodrigues), `anyPerpendicular(out, unitN)`.
`SimRocas.Quat` queda para F5 (cuerpo rígido).

## `SimRocas.Rock3D` (js/physics3d.js)

```
new Rock3D({ x, y, z, vx = 0, vy = 0, vz = 0, diameter, density, sourceId = 0 })
```
- Lanza `Error` en español si `diameter <= 0` o `density <= 0`.
- `radius = diameter / 2`; `mass = density · (4/3)·π·r³` (esfera equivalente, coherente con el 2D).
- Estado: `x, y, z, vx, vy, vz, isResting, stopReason` (`null` | `'rest'` | `'culled'` | `'maxSteps'` | `'maxTime'`), `bounces`, `stepsTaken`, `elapsedTime`, `sustainedContact`, `_restCheckCount`.
- Métricas: `maxKineticEnergy` (J), `maxImpactVelocity` (m/s), `maxBounceHeight` (m sobre el terreno), `totalEnergyDissipated` (J), `finalX/finalY/finalZ`.
- Trayectoria: `trajectory` = `Float32Array` creciente de cuádruplos `(x, y, z, speed)` registrado cada `trajectoryInterval` pasos (defecto 4) más el punto final; `trajectoryLength` = número de cuádruplos válidos. Método `getTrajectory()` → `subarray` recortado.
- Impactos: `impacts` = array de `{ x, y, z, energyKJ, vn }` (solo impactos con |vn| ≥ umbral), tope `maxImpactsRecorded` (defecto 200).
- `kineticEnergy` (getter, J) y `speed` (getter).

## `SimRocas.PhysicsEngine3D` (js/physics3d.js)

Parámetros (propiedades públicas, valores por defecto):
`gravity 9.81`, `dt 0.005`, `kn 0.35`, `kt 0.75`, `knVariability 10`, `ktVariability 10` (%), `rollingFriction 0.15`, `slideVelocityThreshold 0.5`, `restThreshold 0.08`, `maxSubStepDisplacement 0.1`, `roughnessDeg 0`, `materialAt = null` (gancho opcional `(x, y) => ({ kn, kt, rollingFriction, roughnessDeg })`, F5).

`simulateStep(rock, dem)`:
1. `subSteps = min(64, max(3, ceil(dt · (|v| + g·dt) / maxSubStepDisplacement)))` — mismo criterio que el 2D (`PhysicsEngine.prototype.subStepsFor`).
2. `kn`, `kt` con variabilidad aleatoria **una vez por paso**.
3. Por sub-paso: integrar (Euler semi-implícito: `v += g·h`, `p += v·h`); si `(x, y)` sale del DEM o cae en celda sin dato → `isResting = true`, `stopReason = 'culled'`.
4. Contacto: `h = heightAt(x, y)`; `n = normalAt(x, y)`; penetración a lo largo de la normal `pen = (h − (z − r)) · n.z`; si `pen > 0` hay contacto.
5. Rugosidad: si `roughnessDeg > 0` y es **impacto**, rotar `n` un ángulo uniforme en `[0, roughnessDeg]` alrededor de un eje aleatorio del plano tangente; si la normal perturbada queda con `nz <= 0`, usar la normal real.
6. `vn = v · n`. Si `vn >= 0` → sin respuesta de velocidad (solo corrección de posición).
   - **Impacto** (`|vn| >= slideVelocityThreshold`): `v' = −kn·vn·n + kt·vt` (vt = v − vn·n); `bounces++`; registrar impacto; corrección de posición energéticamente neutra (descontar `m·g·lift` de la energía cinética como `Rock._penetrationCorrection` del 2D, sin anular la velocidad si no alcanza).
   - **Contacto sostenido** (`|vn| < umbral`): `v' = vt` (sin `kt`); `sustainedContact = true`; corrección de posición sin cargo de energía.
   - Corrección de posición: `z += lift` con `lift = pen / n.z` (levanta hasta que el punto más bajo de la esfera toque la superficie).
7. Rodadura: solo con contacto real, desaceleración `rollingFriction · g · n.z` opuesta a la velocidad tangencial, sin invertir su sentido.
8. Reposo: con contacto, `_restCheckCount++`; si `_restCheckCount >= 3` y `speed < restThreshold · slopeFactor` y (`bounces > 2` o `sustainedContact`) → `isResting = true`, `stopReason = 'rest'`, velocidad 0. `slopeFactor = max(0.1, 1 − 2·tanθ)` con `tanθ = sqrt(nx² + ny²) / nz` (mismo criterio que el 2D, decisión G7 pendiente).
9. `stepsTaken++`, `elapsedTime += dt`, métricas, trayectoria.

## `SimRocas.SourceZones` (js/source-zones.js)

- Zona puntual: `{ id, type: 'point', x, y }`.
- Zona poligonal: `{ id, type: 'polygon', vertices: [{x, y}, ...] }` (≥ 3 vértices, simple, sentido indiferente).
- `SourceZones.area(zone)`, `SourceZones.contains(zone, x, y)`, `SourceZones.sample(zone, count, rng = Math.random)` → `[{x, y}]` uniforme en el polígono (triangulación en abanico ponderada por área si es convexo; muestreo por rechazo en el bbox si no).
- `SourceZones.distribute(zones, totalRocks)` → reparto proporcional al área (zonas puntuales cuentan como área 1 m²) que suma exactamente `totalRocks`.

## `SimRocas.Simulation3D` (js/simulation3d.js)

```
const sim = new Simulation3D(dem, engine);
sim.configure({ maxDuration = 60, trajectoryInterval = 4 });
sim.start({ zones, totalRocks, diameter, density, releaseMode: 'fall'|'detachment', heightAboveGround = 2, initialVelocity = {vx:0, vy:0, vz:0}, diameterVariability = 0 /* % */ });
while (sim.isRunning) sim.step(stepsPerRock = 50);
sim.getResults() // { rocks: Rock3D[], stats }
```
- `detachment`: la roca inicia apoyada (`z = h + r`); `fall`: `z = h + r + heightAboveGround`.
- `maxSteps = ceil(maxDuration / dt)` → `stopReason = 'maxSteps'`.

## Pool de Workers (js/sim3d-pool.js + js/workers/sim3d-worker.js)

- IN (al worker): `{ type: 'start', dem: dem.toTransferable() (o heights en SharedArrayBuffer si crossOriginIsolated), engineParams, simParams, rockSpecs: [{ x, y, z, vx, vy, vz, diameter, density, sourceId }], seed }`.
- OUT: `{ type: 'progress', done, total }`, `{ type: 'complete', rocks: [serialización plana con trajectory Float32Array transferible] }`, `{ type: 'error', message }`.
- El pool reparte `rockSpecs` generados en el hilo principal (para reproducibilidad) entre `navigator.hardwareConcurrency − 1` workers.

## Rásteres de resultados (js/results3d.js)

`SimRocas.Results3D.build(dem, rocks, { cellSize = dem.cellSize })` → rásteres alineados al DEM (`cols`, `rows`, `cellSize`, origen del DEM):
- `passCount` (Uint32): nº de rocas distintas que pasan por cada celda (rasterizar segmentos de trayectoria),
- `maxEnergyKJ` (Float32), `maxBounceHeight` (Float32, altura sobre el terreno), `stopCount` (Uint32, posiciones finales con `stopReason = 'rest'`),
- `reachProbability` (Float32) = passCount / nRocas.
Exportación: `Results3D.toAsc(raster, dem, field)` → texto ESRI ASCII Grid con origen mundo.
