'use strict';

/**
 * Tests T5.3 + T5.4 + T5.5 — cuerpo rígido 3D con forma real y contacto no
 * suave sobre el DEM (método 'rigid-body' de PhysicsEngine3D).
 *
 * Física cuantitativa (DEMs con Dem.fromFunction, seed fijo, rugosidad y
 * variabilidad 0 salvo indicación):
 *  1. Caja 1×1×1 desde 5 m: rebote ≈ en²·5 (±15 %), reposo sin girar, sin
 *     hundirse (vértice más bajo ≥ terreno − 1 mm).
 *  2. Coulomb: θ = 20° (tan < μ) queda; θ = 35° (tan > μ) desliza con
 *     a ≈ g(sinθ − μ·cosθ) ±10 %.
 *  3. Energía mecánica total nunca sube > 1 % en 3000 pasos con giro inicial.
 *  4. Ladera 35° + llano: 30 irregulares: ≥ 90 % llegan al llano o se detienen
 *     por basculamiento cerca del origen; v(com) ≤ 1.05·sqrt(2gΔh).
 *  5. Dispersión lateral por forma (σ_y > 0.5 m) — realismo de F5.
 *  6. Sin tunneling: pared 0.3 × 30 m, dt 0.02, 60 m/s.
 *  7. Reproducibilidad: misma semilla/shapeSeed → trayectorias idénticas;
 *     pool (worker falso) rigid + variabilidad 0 = mono-hilo exacto.
 *  8. Rendimiento: pasos/s por hilo con irregulares (~20 vértices).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createContext, loadScripts, runScript } = require('./helpers/load.js');

const G = 9.81;
const TOL_PRINT = (label, value, expected, tol) => `${label}: medido=${value.toFixed(6)} esperado=${expected.toFixed(6)} tol=${tol}`;

const FILES = [
    'js/dem.js',
    'js/math3d.js',
    'js/rigid3d.js',
    'js/physics3d.js',
    'js/physics3d-rigid.js',
    'js/source-zones.js',
    'js/simulation3d.js',
];
const POOL_FILES = [...FILES, 'js/sim3d-pool.js'];

function loadCtx(files = FILES, opts = {}) {
    return loadScripts(files, { env: 'browser', seed: 2027, ...opts });
}

/**
 * Cuerpo rígido de box/ellipsoid/irregular directo (sin buildRockSpecs):
 * shapeSeed fijo determina la forma y la actitud inicial.
 */
function makeRigidRock(ctx, { shape = 'box', diameter = 1, density = 2700, aspect = null, position, velocity = null, angularVelocity = null, orientation = null, shapeSeed = 42, omegaMax = 0 }) {
    const Sim = ctx.SimRocas;
    const spec = {
        shape,
        diameter,
        density,
        shapeSeed,
        aspect,
        initialAngularVelocityMax: omegaMax,
    };
    const rng = Sim.seededRandom(spec.shapeSeed);
    const principal = Sim.Rigid3DFactory.buildPrincipal(spec, rng);
    const init = Sim.Rigid3DFactory.initOrientation(rng, spec.initialAngularVelocityMax);
    return new Sim.Rock3D({
        x: position.x,
        y: position.y,
        z: position.z,
        vx: velocity ? velocity.x : 0,
        vy: velocity ? velocity.y : 0,
        vz: velocity ? velocity.z : 0,
        diameter,
        density,
        method: 'rigid-body',
        principal,
        shape: spec.shape,
        shapeSeed,
        orientation: orientation || init.orientation,
        angularVelocity: angularVelocity || init.angularVelocity,
        trajectoryInterval: 1,
    });
}

/** Recorre pasos hasta reposo o tope; devuelve métricas acumuladas. */
function runRock(ctx, engine, rock, dem, { maxSteps = 20000, onStep = null } = {}) {
    const Sim = ctx.SimRocas;
    let steps = 0;
    while (!rock.isResting && rock.stepsTaken < maxSteps) {
        engine.simulateStep(rock, dem);
        steps = rock.stepsTaken;
        if (onStep) { onStep(rock, steps); }
    }
    void Sim;
    return { steps: rock.stepsTaken };
}

/** Penetración residual: max(h_terreno − v_z) sobre los vértices. */
function deepestIngression(ctx, rock, dem) {
    const Sim = ctx.SimRocas;
    void Sim;
    const verts = rock.body.worldVertices();
    let worst = -Infinity;
    let lowest = Infinity;
    for (let i = 0; i < rock.body.shape.vertexCount; i++) {
        const hT = dem.heightAt(verts[3 * i], verts[3 * i + 1]);
        if (Number.isNaN(hT)) { continue; }
        const ing = hT - verts[3 * i + 2];
        if (ing > worst) { worst = ing; }
        if (verts[3 * i + 2] < lowest) { lowest = verts[3 * i + 2]; }
    }
    return { worst, lowest, verts };
}

// ==================================================================
// 0. Contrato: método y parámetros del motor
// ==================================================================

test('motor rigid-body: defaults y validación de method', () => {
    const ctx = loadCtx();
    const Sim = ctx.SimRocas;
    assert.equal(Sim.PhysicsEngine3D.supportedMethods.length, 2);
    assert.equal(Sim.PhysicsEngine3D.supportedMethods[0], 'lumped-mass');
    assert.equal(Sim.PhysicsEngine3D.supportedMethods[1], 'rigid-body');
    const engine = new Sim.PhysicsEngine3D({ method: 'rigid-body' });
    assert.equal(engine.method, 'rigid-body');
    assert.equal(engine.restitutionN, 0.35);
    assert.equal(engine.frictionMu, 0.5);
    assert.equal(engine.rollingResistance, 0.05);
    assert.equal(engine.restAngularThreshold, 0.5);
    const def = new Sim.PhysicsEngine3D();
    assert.equal(def.method, 'lumped-mass');
    assert.throws(() => new Sim.PhysicsEngine3D({ method: 'no-existe' }),
        (err) => err.message.includes('no soportado'));
});

// ==================================================================
// 1. Caja 1×1×1 desde 5 m: rebote en²·H ±15 %, reposo sin girar, sin hundirse
// ==================================================================

test('caja soltada plana desde 5 m sobre plano: rebote ≈ en²·5, reposo sin ω, sin hundirse', () => {
    const ctx = loadCtx();
    const Sim = ctx.SimRocas;
    const dem = Sim.Dem.fromFunction(220, 220, 1, () => 0);
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body',
        restitutionN: 0.35,
        frictionMu: 0.5,
        rollingResistance: 0.05,
        knVariability: 0,
        ktVariability: 0,
        roughnessDeg: 0,
    });
    // com a 5.5 m: cara inferior a 5 m sobre el plano; caída de 5 m hasta el
    // apoyo. Soltada plana (actitud identidad, ω inicial nula).
    const rock = makeRigidRock(ctx, {
        shape: 'box', diameter: 1, aspect: { b: 1, c: 1 },
        position: { x: 110, y: 110, z: 5.5 },
        orientation: { w: 1, x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
    });
    const motor = rock.body;

    // seguimos la altura máx después del primer impacto (sin cortar en 1 m:
    // el tracking es max(z) desde el primer choque hasta el reposo; los
    // rebotes posteriores son mucho menores).
    let impactDone = false;
    let apex = -Infinity;
    runRock(ctx, engine, rock, dem, {
        maxSteps: 30000,
        onStep: (r) => {
            const z = r.body.position.z;
            if (!impactDone && r.body.velocity.z > 0 && z < 0.6) { impactDone = true; }
            if (impactDone && z > apex) { apex = z; }
        },
    });

    assert.equal(rock.stopReason, 'rest', 'debe terminar en reposo');
    const omegaFinal = Math.hypot(
        motor.angularVelocityWorld.x, motor.angularVelocityWorld.y, motor.angularVelocityWorld.z);
    assert.ok(omegaFinal < 0.05, '|ω| final ~0: ' + omegaFinal.toFixed(4));
    assert.ok(Math.abs(motor.velocity.z) < 1e-9 && Math.abs(motor.velocity.x) < 0.05 && Math.abs(motor.velocity.y) < 0.05,
        'velocidad final ~0');

    const e2h = 0.35 * 0.35 * 5; // 0.6125 m
    const rebound = apex - motor.position.z;
    // ventanas ±15 %: [0.5206, 0.7044]
    assert.ok(rebound > 0.35 * e2h && rebound < 1.65 * e2h,
        TOL_PRINT('rebote', rebound, e2h, e2h * 0.35));
    assert.ok(rebound <= 1.15 * e2h && rebound >= 0.85 * e2h,
        TOL_PRINT('rebote (±15 %)', rebound, e2h, e2h * 0.15));

    // sin hundirse: vértice más bajo ≥ terreno − 1 mm
    const ing = deepestIngression(ctx, rock, dem);
    assert.ok(ing.worst <= 0.001, 'hundimiento: ' + ing.worst.toFixed(6) + ' m (vértice ' + ing.lowest.toFixed(4) + ')');
    assert.ok(motor.position.z > 0.49, 'com final apoyado: ' + motor.position.z.toFixed(4) + ' (esperado ~0.5)');
});

// ==================================================================
// 2. Deslizamiento de Coulomb sobre plano inclinado
// ==================================================================

function makeBoxOnSlope(ctx, thetaDeg, opts = {}) {
    const Sim = ctx.SimRocas;
    const theta = thetaDeg * Math.PI / 180;
    const tanT = Math.tan(theta);
    // plano uniforme que desciende hacia +x
    const dem = Sim.Dem.fromFunction(320, 4, 1, (x) => -x * tanT);
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body',
        restitutionN: 0.35,
        frictionMu: 0.5,
        rollingResistance: 0,
        knVariability: 0,
        ktVariability: 0,
        roughnessDeg: 0,
        ...opts,
    });
    // Caja 1×1×1 APOYADA en el plano inclinado (cara inferior PARALELA a la
    // pendiente: rotación de θ alrededor de Y mapea el eje z del cuerpo en la
    // normal del DEM n = (sinθ, 0, cosθ)). La com va a punto del plano +
    // n·0.5, así que las 4 esquinas de la base quedan EXACTAS en la
    // superficie (contacto sostenido, sin micro-impactos).
    const nx = Math.sin(theta);
    const nz = Math.cos(theta);
    const x0 = 60;
    const rock = makeRigidRock(ctx, {
        shape: 'box', diameter: 1, aspect: { b: 1, c: 1 }, shapeSeed: 7,
        position: { x: x0 + nx * 0.5, y: 2, z: -x0 * tanT + nz * 0.5 },
        velocity: null,
        angularVelocity: { x: 0, y: 0, z: 0 },
        orientation: Sim.Quat.fromAxisAngle({}, { x: 0, y: 1, z: 0 }, theta),
    });
    return { dem, engine, rock, theta, tanT, nx, nz };
}
test('Coulomb θ=20° (tanθ < μ): la caja queda en reposo (< 0.05 m en 3 s)', () => {
    const ctx = loadCtx();
    const { dem, engine, rock } = makeBoxOnSlope(ctx, 20);
    const x0 = rock.body.position.x;
    runRock(ctx, engine, rock, dem, { maxSteps: 600 }); // 3 s con dt 0.005
    assert.equal(rock.stopReason, 'rest', 'stopReason=' + rock.stopReason);
    const drift = rock.body.position.x - x0;
    assert.ok(drift < 0.05, 'desplazamiento: ' + drift.toFixed(4) + ' m');
});

test('Coulomb θ=35° (tanθ > μ): desliza con a ≈ g(sinθ − μ cosθ) ±10 %', () => {
    const ctx = loadCtx();
    const { dem, engine, rock, theta } = makeBoxOnSlope(ctx, 35);
    const aTeorica = G * (Math.sin(theta) - 0.5 * Math.cos(theta)); // ≈ 1.609 m/s²
    const tEnd = 2; // s
    const steps = Math.round(tEnd / engine.dt);
    for (let s = 0; s < steps && !rock.isResting; s++) {
        engine.simulateStep(rock, dem);
    }
    assert.ok(!rock.isResting, 'no debe descansar en 2 s (desliza)');
    const aMedida = rock.body.velocity.x / tEnd;
    assert.ok(Math.abs(aMedida - aTeorica) <= 0.1 * aTeorica,
        TOL_PRINT('a deslizamiento', aMedida, aTeorica, 0.1 * aTeorica)
        + ' | x=' + rock.body.position.x.toFixed(2) + ' vx=' + rock.body.velocity.x.toFixed(3));
});

// ==================================================================
// 3. Energía mecánica total nunca sube > 1 % en 3000 pasos con giro inicial
// ==================================================================

test('energía mecánica total (.Tr+rot+pot) no sube > 1 % en 3000 pasos (caja con giro)', () => {
    const ctx = loadCtx();
    const Sim = ctx.SimRocas;
    const dem = Sim.Dem.fromFunction(220, 220, 1, () => 0);
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body', restitutionN: 0.35, frictionMu: 0.5,
        roughnessDeg: 0, knVariability: 0, ktVariability: 0,
    });
    const rock = makeRigidRock(ctx, {
        shape: 'box', diameter: 1, aspect: { b: 1, c: 1 },
        position: { x: 110, y: 110, z: 5.5 },
        angularVelocity: { x: 3, y: 2, z: 1.5 },
    });
    const m = rock.mass;
    let E0 = null;
    let Emax = -Infinity;
    let EmaxRel = 0;
    runRock(ctx, engine, rock, dem, {
        maxSteps: 3000,
        onStep: (r) => {
            const E = r.body.kineticEnergy() + m * G * r.body.position.z;
            if (E0 === null) { E0 = E; }
            if (E > Emax) {
                Emax = E;
                EmaxRel = E / E0 - 1;
            }
        },
    });
    assert.ok(EmaxRel <= 0.01, 'deriva de energía: +' + (EmaxRel * 100).toFixed(3) + ' % (E0=' + E0.toFixed(1) + ' J)');
});

// ==================================================================
// 4. Ladera 35° + llano: 30 irregulares llegan al llano o se detienen cerca
// ==================================================================

function laderaDem(ctx) {
    const TAN35 = Math.tan(35 * Math.PI / 180);
    return ctx.SimRocas.Dem.fromFunction(260, 24, 1, (x) => Math.max(0, (150 - x) * TAN35));
}

test('ladera 35° + llano: 30 irregulares — ≥90 % llegan al llano o basculan cerca del origen; v ≤ 1.05·sqrt(2gΔh)', () => {
    const ctx = loadCtx(FILES, { seed: 515 });
    const Sim = ctx.SimRocas;
    const dem = laderaDem(ctx);
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body', restitutionN: 0.35, frictionMu: 0.5,
        rollingResistance: 0.05, roughnessDeg: 0, knVariability: 0, ktVariability: 0,
    });
    const zone = { id: 'zona', type: 'polygon', vertices: [{ x: 4, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 18 }, { x: 4, y: 18 }] };
    const specs = Sim.Simulation3D.buildRockSpecs(dem, {
        zones: [zone], totalRocks: 30, diameter: 1, density: 2700,
        method: 'rigid-body', shape: 'irregular', releaseMode: 'fall', heightAboveGround: 2,
        diameterVariability: 0,
    }, Sim.seededRandom(121));
    const sim = new Sim.Simulation3D(dem, engine);
    sim.configure({ maxDuration: 40, trajectoryInterval: 4 });
    sim.startWithSpecs(specs);
    while (sim.isRunning) { sim.step(50); }

    const TOE = 150;
    let reached = 0;
    let tipNearOrigin = 0;
    let other = 0;
    let maxSpeedViolations = 0;
    for (const rock of sim.rocks) {
        const reachedLowland = rock.finalX > TOE + rock.diameter / 2 + 0.5;
        const idx = sim.rocks.indexOf(rock);
        if (reachedLowland) { reached++; } else {
            const drift = Math.hypot(rock.finalX - specs[idx].x, rock.finalY - specs[idx].y);
            if (rock.stopReason === 'rest' && drift < 10) { tipNearOrigin++; } else { other++; }
        }
        // cota de velocidad: máx rapidez en trayectoria ≤ 1.05·sqrt(2gΔh)
        const traj = rock.getTrajectory();
        let vmax = 0;
        for (let i = 3; i < traj.length; i += 4) { if (traj[i] > vmax) { vmax = traj[i]; } }
        const dh = Math.max(0, specs[sim.rocks.indexOf(rock)].z - 0);
        const vLimit = 1.05 * Math.sqrt(2 * G * dh + 0.1 * 0.1);
        if (vmax > vLimit) { maxSpeedViolations++; }
    }
    const ok = reached + tipNearOrigin;
    assert.ok(ok >= 27, 'reached=' + reached + ' tipNearOrigin=' + tipNearOrigin + ' lost=' + other + ' '
        + 'maxSpeedViolations=' + maxSpeedViolations
        + ' | rest=' + sim.rocks.filter((r) => r.stopReason === 'rest').length
        + ' culled=' + sim.rocks.filter((r) => r.stopReason === 'culled').length
        + ' maxSteps=' + sim.rocks.filter((r) => r.stopReason === 'maxSteps').length);
    assert.equal(maxSpeedViolations, 0, 'ninguna roca supera 1.05·sqrt(2gΔh)');
    assert.equal(sim.rocks.length, 30);
});

// ==================================================================
// 5. Dispersión lateral por forma (σ_y > 0.5 m con irregulares)
// ==================================================================

test('dispersión lateral: σ_y final > 0.5 m con irregulares en pendiente uniforme (realismo F5)', () => {
    const ctx = loadCtx(FILES, { seed: 2030 });
    const Sim = ctx.SimRocas;
    const TAN35 = Math.tan(35 * Math.PI / 180);
    const dem = Sim.Dem.fromFunction(300, 24, 1, (x) => -x * TAN35);
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body', restitutionN: 0.35, frictionMu: 0.5,
        rollingResistance: 0.05, roughnessDeg: 0, knVariability: 0, ktVariability: 0,
    });
    const zone = { id: 'puntual', type: 'point', x: 60, y: 12 };
    const specs = Sim.Simulation3D.buildRockSpecs(dem, {
        zones: [zone], totalRocks: 30, diameter: 1, density: 2700,
        method: 'rigid-body', shape: 'irregular', releaseMode: 'fall', heightAboveGround: 2,
        diameterVariability: 0,
    }, Sim.seededRandom(77));
    const sim = new Sim.Simulation3D(dem, engine);
    sim.configure({ maxDuration: 30, trajectoryInterval: 4 });
    sim.startWithSpecs(specs);
    while (sim.isRunning) { sim.step(50); }

    // σ_y de las finales (todas parten en y≈12 con vy = 0)
    const ys = sim.rocks.map((r) => r.finalY);
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sigma = Math.sqrt(ys.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ys.length);
    assert.ok(sigma > 0.5, 'σ_y final: ' + sigma.toFixed(3) + ' m (media y=' + mean.toFixed(3) + '; range='
        + Math.min(...ys).toFixed(2) + '..' + Math.max(...ys).toFixed(2) + ')');
});

// ==================================================================
// 6. Sin tunneling: pared 0.3 × 30 m, dt 0.02, v 60 m/s
// ==================================================================

test('tunneling: pared 0.3 m × 30 m con dt 0.02 y 60 m/s — contacto y sin atraviesa', () => {
    const ctx = loadCtx();
    const Sim = ctx.SimRocas;
    // pared: nodos x∈[99.9, 100.1] a 40 m; suelo en 10 (cell 0.1, ancho 0.3 m en y)
    const dem = Sim.Dem.fromFunction(3001, 4, 0.1, (x) => (x >= 99.9 && x <= 100.1001 ? 40 : 10));
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body', restitutionN: 0.35, frictionMu: 0.5,
        rollingResistance: 0, roughnessDeg: 0, dt: 0.02, knVariability: 0, ktVariability: 0,
    });
    const rock = makeRigidRock(ctx, {
        shape: 'irregular', diameter: 1, shapeSeed: 99, omegaMax: 0.1,
        position: { x: 60, y: 0.15, z: 10.5 },
        velocity: { x: 60, y: 0, z: 0 },
        orientation: { w: 1, x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
    });
    let sawContact = false;
    let maxX = -Infinity;
    for (let s = 0; s < 1500 && !rock.isResting; s++) {
        engine.simulateStep(rock, dem);
        maxX = Math.max(maxX, rock.body.position.x);
        if (rock.bounces > 0 || rock.body.velocity.x < 57) { sawContact = true; }
        if (rock.finalX < 20) { break; }
    }
    assert.ok(sawContact, 'contacto no registrado en la pared');
    assert.ok(maxX <= 100.6, 'atravesó la pared sin contacto: maxX=' + maxX.toFixed(3));
    assert.ok(rock.body.velocity.x < 0.95 * 60 || rock.isResting,
        'sin pérdida de energía: vx=' + rock.body.velocity.x.toFixed(2));
});

// ==================================================================
// 7. Reproducibilidad: semilla/shapeSeed → trayectorias idénticas; pool exacto
// ==================================================================

function runSeeded(ctx, seed, specsSeed) {
    const Sim = ctx.SimRocas;
    const TAN35 = Math.tan(35 * Math.PI / 180);
    const dem = Sim.Dem.fromFunction(300, 24, 1, (x) => -x * TAN35);
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body', restitutionN: 0.35, frictionMu: 0.5, rollingResistance: 0.05,
        roughnessDeg: 0, knVariability: 0, ktVariability: 0,
    });
    const zone = { id: 'puntual', type: 'point', x: 60, y: 12 };
    const specs = Sim.Simulation3D.buildRockSpecs(dem, {
        zones: [zone], totalRocks: 8, diameter: 1, density: 2700,
        method: 'rigid-body', shape: 'irregular', releaseMode: 'fall', heightAboveGround: 2,
        diameterVariability: 0,
    }, Sim.seededRandom(specsSeed));
    const sim = new Sim.Simulation3D(dem, engine);
    sim.configure({ maxDuration: 12, trajectoryInterval: 4 });
    sim.startWithSpecs(specs);
    while (sim.isRunning) { sim.step(50); }
    return { specs, rocks: sim.rocks };
}

test('reproducibilidad: misma semilla/shapeSeed → trayectorias y orientaciones idénticas', () => {
    const ctxA = loadCtx(FILES, { seed: 314 });
    const ctxB = loadCtx(FILES, { seed: 314 });
    const a = runSeeded(ctxA, 314, 314);
    const b = runSeeded(ctxB, 314, 314);
    assert.equal(a.rocks.length, b.rocks.length);
    for (let i = 0; i < a.rocks.length; i++) {
        const tA = a.rocks[i].getTrajectory();
        const tB = b.rocks[i].getTrajectory();
        assert.equal(tA.length, tB.length, 'roca ' + i + ' longitud trayectoria');
        for (let k = 0; k < tA.length; k++) {
            assert.ok(tA[k] === tB[k], 'roca ' + i + ' traj[' + k + ']: ' + tA[k] + ' ≠ ' + tB[k]);
        }
        const oA = a.rocks[i].getOrientations();
        const oB = b.rocks[i].getOrientations();
        assert.equal(oA.length, oB.length, 'roca ' + i + ' longitud orientaciones');
        for (let k = 0; k < oA.length; k++) {
            assert.ok(oA[k] === oB[k], 'orientación no reproducible: ' + k);
        }
    }
});

// --- worker falso (igual que sim3d-pool.test.js, mínimo) -------------------

function makeFakeWorkerClass() {
    return class FakeWorker {
        constructor(url) {
            const self = this;
            this.url = url;
            this.onmessage = null;
            this.onerror = null;
            this._terminated = false;
            this._ctx = createContext({
                env: 'worker',
                extra: {
                    postMessage: (msg) => {
                        queueMicrotask(() => {
                            if (!self._terminated && self.onmessage) { self.onmessage({ data: msg }); }
                        });
                    },
                    importScripts: (...files) => {
                        for (const f of files) {
                            const rel = path.posix.normalize(path.join('js', 'workers', String(f).split('?')[0]));
                            runScript(self._ctx, rel);
                        }
                    },
                },
            });
            runScript(this._ctx, 'js/workers/sim3d-worker.js');
        }
        postMessage(msg) {
            const ctx = this._ctx;
            const self = this;
            queueMicrotask(() => {
                if (!self._terminated && ctx.onmessage) { ctx.onmessage({ data: msg }); }
            });
        }
        terminate() {
            this._terminated = true;
            return true;
        }
    };
}

const POOL_ENGINE = {
    method: 'rigid-body', restitutionN: 0.35, frictionMu: 0.5, rollingResistance: 0.05,
    dt: 0.005, roughnessDeg: 0, knVariability: 0, ktVariability: 0,
};
const POOL_SIM = { maxDuration: 12, trajectoryInterval: 4, stepsPerRock: 50 };

test('pool paridad exacta con method rigid-body (worker falso, variabilidad 0)', async () => {
    const ctx = loadCtx(POOL_FILES, { seed: 2718 });
    const Sim = ctx.SimRocas;
    const TAN35 = Math.tan(35 * Math.PI / 180);
    const dem = Sim.Dem.fromFunction(300, 24, 1, (x) => -x * TAN35);
    const zone = { id: 'puntual', type: 'point', x: 60, y: 12 };
    const specs = Sim.Simulation3D.buildRockSpecs(dem, {
        zones: [zone], totalRocks: 8, diameter: 1, density: 2700,
        method: 'rigid-body', shape: 'irregular', releaseMode: 'fall', heightAboveGround: 2,
        diameterVariability: 0,
    }, Sim.seededRandom(616));

    // mono-hilo
    const engine = new Sim.PhysicsEngine3D(POOL_ENGINE);
    const sim = new Sim.Simulation3D(dem, engine);
    sim.configure(POOL_SIM);
    sim.startWithSpecs(specs);
    while (sim.isRunning) { sim.step(50); }

    // pool con 3 workers falsos
    const FakeWorker = makeFakeWorkerClass();
    const poolCtx = loadCtx(POOL_FILES, { seed: 2718 });
    const pool = new poolCtx.SimRocas.Sim3DPool({ size: 3, WorkerClass: FakeWorker, workerUrl: 'js/workers/sim3d-worker.js?v=1' });
    const result = await pool.run({ dem, engineParams: POOL_ENGINE, simParams: POOL_SIM, rockSpecs: specs, seed: 2718 });

    assert.equal(result.rocks.length, specs.length);
    for (let i = 0; i < specs.length; i++) {
        const b = sim.rocks[i];
        const r = result.rocks[i];
        assert.equal(r.stopReason, b.stopReason, 'roca ' + i + ' stopReason');
        assert.ok(Math.abs(r.finalX - b.finalX) <= 1e-9, 'roca ' + i + ' finalX');
        assert.ok(Math.abs(r.finalY - b.finalY) <= 1e-9, 'roca ' + i + ' finalY');
        assert.ok(Math.abs(r.finalZ - b.finalZ) <= 1e-9, 'roca ' + i + ' finalZ');
        assert.ok(r.orientations && r.orientations.length === b.getOrientations().length,
            'roca ' + i + ' orientaciones transportadas');
        for (let k = 0; k < r.orientations.length; k++) {
            assert.ok(Math.abs(r.orientations[k] - b.getOrientations()[k]) <= 1e-9, 'roca ' + i + ' orient[' + k + ']');
        }
    }
});

// ==================================================================
// 8. Rendimiento: pasos/s por hilo con irregulares (~20 vértices)
// ==================================================================

test('rendimiento: irregulares ~20 vértices — pasos/s por hilo (objetivo orientativo > 30k)', () => {
    const ctx = loadCtx(FILES, { seed: 998 });
    const Sim = ctx.SimRocas;
    const dem = Sim.Dem.fromFunction(400, 24, 1, (x) => x >= 40 ? 0 : (40 - x) * Math.tan(35 * Math.PI / 180));
    const zone = { id: 'puntual', type: 'point', x: 6, y: 12 };
    const specs = Sim.Simulation3D.buildRockSpecs(dem, {
        zones: [zone], totalRocks: 4, diameter: 1, density: 2700,
        method: 'rigid-body', shape: 'irregular', releaseMode: 'fall', heightAboveGround: 3,
        diameterVariability: 0,
    }, Sim.seededRandom(1234));
    const engine = new Sim.PhysicsEngine3D({
        method: 'rigid-body', restitutionN: 0.35, frictionMu: 0.5, rollingResistance: 0.05,
        roughnessDeg: 0, knVariability: 0, ktVariability: 0,
    });
    const rocks = specs.map((s) => {
        const rng = Sim.seededRandom(s.shapeSeed);
        const principal = Sim.Rigid3DFactory.buildPrincipal(s, rng);
        return new Sim.Rock3D({
            x: s.x, y: s.y, z: s.z - s.diameter / 2 + principal.boundingRadius,
            vx: s.vx, vy: s.vy, vz: s.vz, diameter: s.diameter, density: s.density,
            method: 'rigid-body', principal, shape: s.shape,
            orientation: null, angularVelocity: null, trajectoryInterval: 1,
        });
    });
    const STEPS = 4000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < STEPS; i++) {
        for (const rock of rocks) { engine.simulateStep(rock, dem); }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const perSec = (STEPS * rocks.length) / (ms / 1000);
    const verts = rocks[0].body.shape.vertexCount;
    console.log('[bench] vértices=' + verts + ' pasos/s por hilo=' + Math.round(perSec).toLocaleString('en-US'));
    assert.ok(perSec > 5000, 'rendimiento inaceptable: ' + Math.round(perSec) + ' pasos/s (vértices=' + verts + ')');
});
