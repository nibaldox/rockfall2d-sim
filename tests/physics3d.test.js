'use strict';

/**
 * Tests de SimRocas.Rock3D / SimRocas.PhysicsEngine3D (js/physics3d.js) — contrato C7.
 *
 * Convenciones: DEM con Dem.fromFunction, variabilidad 0 y roughness 0 salvo
 * indicación, seed fijo (mulberry32 vía helpers/load.js). Los objetos del
 * sandbox son de otro realm: loadCtx() devuelve el namespace SimRocas del
 * sandbox y las aserciones evitan instanceof contra clases locales.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { loadScripts } = require('./helpers/load.js');

const FILES = ['js/dem.js', 'js/math3d.js', 'js/terrain.js', 'js/physics.js', 'js/physics3d.js'];

/** Carga los módulos y devuelve el namespace SimRocas del sandbox. */
function loadCtx(seed = 7) {
    return loadScripts(FILES, { env: 'node', seed }).SimRocas;
}

function makeEngine(S, over = {}) {
    const engine = new S.PhysicsEngine3D(over);
    for (const k of Object.keys(over)) {
        engine[k] = over[k];
    }
    return engine;
}

/** Ejecuta simulateStep hasta que la roca quede isResting o maxSteps. */
function runToStop(engine, rock, dem, maxSteps = 30000) {
    let steps = 0;
    while (!rock.isResting && steps < maxSteps) {
        engine.simulateStep(rock, dem);
        steps++;
    }
    return steps;
}

/**
 * Ladera z decreciente en x, uniforme en y: pendiente de `slopeLen` m y luego
 * `flatLen` m de llano a z=0.
 */
function slopeDemFactory(S, slopeLen, flatLen, slope, cellSize = 0.5, ySize = 10) {
    return S.Dem.fromFunction(
        Math.round((slopeLen + flatLen) / cellSize) + 1,
        Math.round(ySize / cellSize) + 1,
        cellSize,
        (x) => (x <= slopeLen ? (slopeLen - x) * slope : 0),
    );
}

// ---------- Rock3D: construcción y validación ----------

test('Rock3D: masa esfera equivalente, radio, estado inicial', () => {
    const S = loadCtx();
    const rock = new S.Rock3D({ x: 1, y: 2, z: 3, diameter: 2, density: 2600, sourceId: 5 });
    assert.equal(rock.radius, 1);
    approx(rock.mass, 2600 * (4 / 3) * Math.PI, 1e-9);
    approx(rock.kineticEnergy, 0);
    approx(rock.speed, 0);
    assert.equal(rock.isResting, false);
    assert.equal(rock.stopReason, null);
    assert.equal(rock.bounces, 0);
    assert.equal(rock.stepsTaken, 0);
    assert.equal(rock.sourceId, 5);
    assert.ok(rock.trajectory instanceof Float32Array || typeof rock.trajectory.subarray === 'function');
    assert.equal(rock.trajectoryLength, 0);
    assert.ok(Array.isArray(rock.impacts));
});

function approx(a, b, tol = 1e-9) {
    assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} ± ${tol}`);
}

test('Rock3D: lanza Error en español si diameter o density <= 0', () => {
    const S = loadCtx();
    assert.throws(() => new S.Rock3D({ x: 0, y: 0, z: 0, diameter: 0, density: 2600 }), /diámetro|diametro/i);
    assert.throws(() => new S.Rock3D({ x: 0, y: 0, z: 0, diameter: 1, density: -1 }), /densidad/i);
});

// ---------- 1. Rebote vertical ----------

test('Caída vertical de 10 m: primer rebote ≈ kn²·10 m (±3 %)', () => {
    const S = loadCtx(11);
    const dem = S.Dem.fromFunction(101, 101, 1, () => 0);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0 });
    const rock = new S.Rock3D({ x: 50, y: 50, z: 10 + 0.5, diameter: 1, density: 2600 });

    let firstBounce = false;
    let apex = -Infinity;
    let steps = 0;
    while (!rock.isResting && steps < 8000) {
        engine.simulateStep(rock, dem);
        if (!firstBounce && rock.bounces >= 1) {
            firstBounce = true;
        } else if (firstBounce) {
            // altura sobre el terreno: el punto inferior de la roca
            const h = rock.z - rock.radius - dem.heightAt(rock.x, rock.y);
            if (h > apex) { apex = h; }
        }
        steps++;
    }

    const expected = 0.35 * 0.35 * 10;
    assert.ok(apex > expected * 0.97 && apex < expected * 1.03, `apex=${apex} esperado≈${expected}`);
    assert.ok(rock.isResting, 'la roca termina en reposo');
});

// ---------- 2. Energía mecánica ----------

test('Energía mecánica no sube > 1 % en 3000 pasos (caída con vx=2)', () => {
    const S = loadCtx(12);
    const dem = S.Dem.fromFunction(101, 101, 1, () => 0);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0 });
    const rock = new S.Rock3D({ x: 20, y: 20, z: 5, vx: 2, diameter: 1, density: 2600 });
    const m = rock.mass;
    const E0 = 0.5 * m * rock.speed * rock.speed + m * 9.81 * (rock.z - rock.radius);

    let maxE = E0;
    for (let i = 0; i < 3000 && !rock.isResting; i++) {
        engine.simulateStep(rock, dem);
        const E = 0.5 * m * rock.speed * rock.speed + m * 9.81 * (rock.z - rock.radius);
        if (E > maxE) { maxE = E; }
    }

    assert.ok(maxE <= 1.01 * E0, `maxE=${maxE} E0=${E0}`);
});

// ---------- 3. Pendiente uniforme de 35° + llano ----------

test('Ladera 35° de 300 m + llano: 30 rocas llegan al llano sin detenerse en la pendiente', () => {
    const S = loadCtx(13);
    const slope = Math.tan(35 * Math.PI / 180);
    const dem = slopeDemFactory(S, 300, 2200, slope, 0.5, 10);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0, roughnessDeg: 0 });

    const hRelease = dem.heightAt(5, 5);
    const dhRelease = hRelease - 0; // desnivel hasta el llano
    const vMax = 1.05 * Math.sqrt(2 * 9.81 * dhRelease);

    for (let i = 0; i < 30; i++) {
        const rock = new S.Rock3D({ x: 5, y: 5, z: hRelease + rock3Radius(1), diameter: 1, density: 2600 });
        const n = runToStop(engine, rock, dem);
        assert.ok(n < 30000, `roca ${i}: no alcanzó reposo en 30000 pasos`);
        assert.equal(rock.stopReason, 'rest', `roca ${i}: stopReason=${rock.stopReason} finalX=${rock.finalX}`);
        assert.ok(rock.finalX > 299, `roca ${i}: no llegó al llano (finalX=${rock.finalX})`);
        assert.ok(rock.maxImpactVelocity < vMax, `roca ${i}: velocidad ${rock.maxImpactVelocity} > límite ${vMax}`);
    }
});

function rock3Radius(d) {
    return d / 2;
}

// ---------- 4. Plano de 5° (bajo el ángulo de rodadura) ----------

test('Plano de 5°: roca liberada en reposo queda stopReason \'rest\' moviéndose < 2 m', () => {
    const S = loadCtx(14);
    const slope = Math.tan(5 * Math.PI / 180);
    const dem = slopeDemFactory(S, 200, 100, slope, 0.5, 10);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0 });
    const h0 = dem.heightAt(5, 5);
    const rock = new S.Rock3D({ x: 5, y: 5, z: h0 + 0.5, diameter: 1, density: 2600 });

    runToStop(engine, rock, dem, 5000);
    assert.equal(rock.stopReason, 'rest');
    const dx = rock.finalX - 5;
    const dy = rock.finalY - 5;
    assert.ok(Math.hypot(dx, dy) < 2, `desplazamiento=${Math.hypot(dx, dy)}`);
});

// ---------- 5. Simetría lateral y rugosidad ----------

test('Simetría lateral: pendiente uniforme en y, vy=0 → |Δy| < 1e-6 (roughness 0)', () => {
    const S = loadCtx(15);
    const slope = Math.tan(35 * Math.PI / 180);
    const dem = slopeDemFactory(S, 300, 2200, slope, 1, 200);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0, roughnessDeg: 0 });

    // y en el centro del ancho del DEM
    const hw = dem.heightAt(5, 100);
    const rock = new S.Rock3D({ x: 5, y: 100, z: hw + 0.5, diameter: 1, density: 2600 });
    runToStop(engine, rock, dem);
    assert.ok(Math.abs(rock.finalY - 100) < 1e-6, `Δy=${rock.finalY - 100}`);
});

test('Rugosidad 15°: dispersión lateral en 50 rocas (σ_y > 0.5 m) y acotada', () => {
    const S = loadCtx(16);
    const slope = Math.tan(35 * Math.PI / 180);
    const dem = slopeDemFactory(S, 300, 2200, slope, 1, 400);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0, roughnessDeg: 15 });
    const hRelease = dem.heightAt(5, 200);

    const finals = [];
    for (let i = 0; i < 50; i++) {
        // caída de 3 m sobre el terreno: fuerza impactos reales (la rugosidad
        // solo actúa en impactos), necesarios para dispersar en y.
        const rock = new S.Rock3D({ x: 5, y: 200, z: hRelease + 0.5 + 3, diameter: 1, density: 2600 });
        runToStop(engine, rock, dem, 30000);
        assert.ok(rock.stopReason === 'rest' || rock.stopReason === 'culled',
            `roca ${i}: stopReason=${rock.stopReason}`);
        assert.ok(Math.abs(rock.finalY - 200) < 190, `roca ${i}: Δy=${rock.finalY - 200}`);
        finals.push(rock.finalY);
    }

    const mean = finals.reduce((s, v) => s + v, 0) / finals.length;
    const variance = finals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (finals.length - 1);
    const sd = Math.sqrt(variance);
    assert.ok(sd > 0.5, `σ_y=${sd}`);
});

// ---------- 6. Paridad 2D↔3D ----------

const BENCHMARK_PROFILE = [
    [0, 120], [40, 100], [80, 70], [120, 45], [160, 25],
    [200, 15], [260, 10], [350, 8], [450, 8],
];

function profileZ(x) {
    const pts = BENCHMARK_PROFILE;
    if (x <= pts[0][0]) { return pts[0][1]; }
    for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        if (x <= x2) { return z1 + (x - x1) / (x2 - x1) * (z2 - z1); }
    }
    return pts[pts.length - 1][1];
}

test('Paridad 2D↔3D: perfil extruido uniforme en y, alcance medio dentro de ±5 %', () => {
    const S = loadCtx(17);
    const N_ROCKS = 30;
    const RELEASE_X = 5;
    const CELL = 0.5;

    // --- 3D: DEM extruido del perfil (uniforme en y), llano extendido a 1500 m ---
    const demo = S.Dem.fromFunction(
        Math.round(1500 / CELL) + 1,
        Math.round(10 / CELL) + 1,
        CELL,
        (x) => profileZ(x),
    );
    const engine3d = makeEngine(S, { knVariability: 0, ktVariability: 0, roughnessDeg: 0 });
    const finals3d = [];
    for (let i = 0; i < N_ROCKS; i++) {
        const h = demo.heightAt(RELEASE_X, 5);
        const rock = new S.Rock3D({ x: RELEASE_X, y: 5, z: h + 0.5, diameter: 1, density: 2600 });
        runToStop(engine3d, rock, demo, 200000);
        assert.equal(rock.stopReason, 'rest', `3D roca ${i}: ${rock.stopReason}`);
        finals3d.push(rock.finalX);
    }
    const mean3d = average(finals3d);

    // --- 2D: motor lumped-mass con Terrain del mismo perfil ---
    const pts = BENCHMARK_PROFILE.concat([[1000, 8], [1500, 8]]);
    const terrain = new S.Terrain();
    terrain.setPoints(pts.map(([x, y]) => ({ x, y })), 'roca-suave');
    for (let i = 0; i < terrain.segments.length; i++) {
        terrain.setSegmentProperties(i, { cn: 0.35, ct: 0.75, roughness: 0 });
    }
    const engine2d = new S.PhysicsEngine();
    engine2d.calcMethod = 'lumped-mass';
    engine2d.kn = 0.35;
    engine2d.kt = 0.75;
    engine2d.cnVariability = 0;
    engine2d.ctVariability = 0;
    engine2d.rollingFriction = 0.15;
    engine2d.fragmentationEnabled = false;

    const finals2d = [];
    for (let i = 0; i < N_ROCKS; i++) {
        const h = terrain.getHeightAt(RELEASE_X);
        const rock = new S.Rock(RELEASE_X, h + 0.5, 1, 2600, 0, 0, 'sphere');
        let steps = 0;
        while (!rock.isResting && steps < 200000) {
            engine2d.simulateStep(rock, terrain, 0.005, null);
            steps++;
        }
        assert.ok(rock.isResting, `2D roca ${i}: no paró en 200000 pasos`);
        finals2d.push(rock.x);
    }
    const mean2d = average(finals2d);

    const rel = Math.abs(mean3d - mean2d) / mean2d;
    // Tolerancia del contrato C7: ±5 %. Las diferencias conocidas de modelo:
    // normal bilineal del DEM (aquí exacta sobre perfil por tramos porque los
    // nudos caen en la retícula) y la desaceleración de rodadura del 3D
    // (µ·g·n.z) frente a la del 2D (µ·g constante).
    if (rel > 0.05) {
        console.log(`  [paridad] mean2D=${mean2d} mean3D=${mean3d} desviación=${(rel * 100).toFixed(2)} %`);
    }
    assert.ok(rel <= 0.05, `desviación ${(rel * 100).toFixed(2)} % > 5 % (2D=${mean2d}, 3D=${mean3d})`);
});

function average(xs) {
    let s = 0;
    for (const x of xs) { s += x; }
    return s / xs.length;
}

// ---------- 7. Culled ----------

test('Salida del DEM o celda NaN → stopReason \'culled\'', () => {
    const S = loadCtx(18);

    // (a) celda NaN
    const demNaN = S.Dem.fromFunction(101, 101, 1, (x) => (x < 100 ? 0 : NaN));
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0 });
    const rockA = new S.Rock3D({ x: 50, y: 50, z: 0.5, vx: 20, diameter: 1, density: 2600 });
    runToStop(engine, rockA, demNaN);
    assert.equal(rockA.stopReason, 'culled');
    assert.ok(rockA.isResting);

    // (b) fuera de la grilla
    const demSmall = S.Dem.fromFunction(21, 21, 1, () => 0);
    const rockB = new S.Rock3D({ x: 18, y: 10, z: 0.5, vx: 10, diameter: 1, density: 2600 });
    runToStop(engine, rockB, demSmall);
    assert.equal(rockB.stopReason, 'culled');
});

// ---------- 8. Sub-pasos adaptativos (tunneling) ----------

test('Pared de 0.3 m × 30 m, dt 0.02 y 60 m/s: hay contacto (no tunneling)', () => {
    const S = loadCtx(19);
    const cell = 0.1;
    const dem = S.Dem.fromFunction(501, 101, cell, (x) => {
        // pared: nodos en [29.9, 30.2] a z=30 (≈0.3 m de ancho); 10 m en y
        return (x >= 29.9 && x <= 30.2) ? 30 : 0;
    });
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0, dt: 0.02 });
    const rock = new S.Rock3D({ x: 5, y: 5, z: 0.5, vx: 60, diameter: 1, density: 2600 });

    runToStop(engine, rock, dem, 4000);
    assert.ok(rock.bounces >= 1, 'la roca debe contactar la pared (bounces >= 1)');
    assert.ok(rock.impacts.length >= 1 || rock.bounces >= 1);
});

// ---------- 9. Trayectoria e impactos ----------

test('Trayectoria: cuádruplos coherentes, impactos con energyKJ > 0, tope maxImpactsRecorded', () => {
    const S = loadCtx(20);
    const dem = S.Dem.fromFunction(101, 101, 1, () => 0);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0 });

    const rock = new S.Rock3D({ x: 50, y: 50, z: 10 + 0.5, diameter: 1, density: 2600 });
    runToStop(engine, rock, dem, 8000);

    trajCheck(rock);

    // impactos: energía > 0 y tope del array
    const rockCap = new S.Rock3D({ x: 50, y: 50, z: 10 + 0.5, diameter: 1, density: 2600, maxImpactsRecorded: 2 });
    runToStop(engine, rockCap, dem, 8000);
    for (const imp of rockCap.impacts) {
        assert.ok(imp.energyKJ > 0, 'energyKJ > 0');
        assert.ok(Number.isFinite(imp.vn));
        assert.ok(Math.abs(imp.vn) >= 0.5, 'solo impactos con |vn| >= umbral');
    }
    assert.ok(rockCap.impacts.length <= 2, `tope: ${rockCap.impacts.length}`);
});

function trajCheck(rock) {
    const traj = rock.getTrajectory();
    // Los objetos del sandbox son de otro realm: comprobamos por duck typing
    // (constructor.name 'Float32Array' o método subarray) — no instanceof local.
    assert.ok(
        (traj.constructor && traj.constructor.name === 'Float32Array') || typeof traj.subarray === 'function',
        'getTrajectory devuelve un Float32Array del realm del sandbox',
    );
    assert.equal(traj.length, rock.trajectoryLength * 4);
    assert.ok(traj.length >= 8, 'al menos 2 cuádruplos');
    const last = traj.length - 4;
    approx(traj[last], rock.finalX, 1e-4);
    approx(traj[last + 1], rock.finalY, 1e-4);
    approx(traj[last + 2], rock.finalZ, 1e-4);
    approx(traj[last + 3], rock.speed, 1e-4);
    for (let i = 0; i < traj.length; i++) {
        assert.ok(Number.isFinite(traj[i]), `traj[${i}] finito`);
    }
}

// ---------- 10. Rendimiento ----------

test('Rendimiento: 200 rocas × 6000 pasos en ladera 1000×1000 (pasos/s > 150k)', () => {
    const S = loadCtx(21);
    const cell = 1;
    const slopeAngle = 6.84 * Math.PI / 180;
    const dem = S.Dem.fromFunction(1000, 1000, cell, (x) => (x <= 999 ? (999 - x) * Math.tan(slopeAngle) : 0));
    const engine = makeEngine(S, {
        knVariability: 0,
        ktVariability: 0,
        rollingFriction: 0.01,
        roughnessDeg: 0,
    });

    const STEPS = 6000;
    const N = 200;
    const t0 = performance.now();
    let stepsDone = 0;
    for (let i = 0; i < N; i++) {
        const h = dem.heightAt(30, 500);
        // vx inicial: sin él una roca apoyada en reposo queda en reposo al nacer
        // (velocidad 0 < umbral de reposo) y el test no mediría 6000 pasos.
        const rock = new S.Rock3D({ x: 30, y: 500, z: h + 0.5, vx: 10, diameter: 1, density: 2600 });
        for (let s = 0; s < STEPS; s++) {
            if (rock.isResting || rock.stopReason === 'culled') { break; }
            engine.simulateStep(rock, dem);
        }
        stepsDone += rock.stepsTaken;
    }
    const t1 = performance.now();
    const seconds = (t1 - t0) / 1000;
    const stepsPerSec = stepsDone / seconds;
    console.log(`  [rendimiento] ${stepsDone} pasos en ${seconds.toFixed(2)} s → ${(stepsPerSec / 1000).toFixed(0)}k pasos/s`);
    assert.ok(stepsPerSec > 150000, `pasos/s = ${stepsPerSec.toFixed(0)} <= 150000`);
});

// ---------- extra: hook materialAt ----------

test('materialAt: el gancho puede frenar la roca en pendiente (F5)', () => {
    const S = loadCtx(22);
    const slope = Math.tan(35 * Math.PI / 180);
    const dem = slopeDemFactory(S, 300, 2200, slope, 0.5, 10);
    const engine = makeEngine(S, { knVariability: 0, ktVariability: 0, roughnessDeg: 0 });
    engine.materialAt = () => ({ rollingFriction: 2.0 }); // µ·g ≫ g·sin35 → frena

    const hRelease = dem.heightAt(5, 5);
    const rock = new S.Rock3D({ x: 5, y: 5, z: hRelease + 0.5, diameter: 1, density: 2600 });
    runToStop(engine, rock, dem, 30000);
    assert.equal(rock.stopReason, 'rest');
    assert.ok(rock.finalX < 299, `la roca frenó en la ladera (finalX=${rock.finalX})`);
});
