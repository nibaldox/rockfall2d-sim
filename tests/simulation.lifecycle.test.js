'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function scene(duration = 30, dt = 0.005) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: 42 });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.addPoint(-1000, -1000);
    terrain.addPoint(1000, -1000);
    const engine = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, engine);
    sim.configure({ numRocks: 1, animationSpeed: 50, timeStep: dt, maxDuration: duration, fragmentationEnabled: false });
    engine.gravity = 0;
    return { ctx, terrain, engine, sim };
}

function start(sim, duration = sim.maxDuration) {
    sim.start(0, 0, 0.5, 2700, 1, 0, duration, true, 'sphere', 0.6, 'freefall', null);
    return sim.rocks[0];
}

test('30 segundos efectivos no terminan en 7.5 s y guardan posición final', () => {
    const { sim } = scene();
    const rock = start(sim);
    const initialX = rock.x;
    while (sim.isRunning) sim.step();
    assert.ok(Math.abs((rock.x - initialX) - 30) < 0.01, `distancia real ${rock.x - initialX}, esperada 30 m`);
    assert.equal(rock.finalX, rock.x);
    assert.equal(rock.finalY, rock.y);
    assert.equal(rock.stopReason, 'maxTime');
    assert.equal(rock.stepsTaken, 6000);
    assert.ok(Math.abs(rock.elapsedTime - 30) < 1e-9);
});

test('culling y cancelación conservan coordenadas finales, incluso negativas', () => {
    const { terrain, engine, sim } = scene();
    const rock = engine.createRock(-1100, 0, 0.5, 2700, 1, 180, 'sphere');
    engine.simulateStep(rock, terrain, 0.005, []);
    assert.equal(rock.finalX, rock.x);
    assert.equal(rock.finalY, rock.y);
    assert.equal(rock.stopReason, 'culled');
    const other = start(sim);
    sim.step();
    sim.stop();
    assert.equal(other.finalX, other.x);
    assert.equal(other.finalY, other.y);
    assert.equal(other.stopReason, 'cancelled');
    sim.stop();
    assert.equal(sim.finishedRocks.length, 1);
});

test('duración no múltiplo y duración modificada en start usan pasos efectivos', () => {
    const { sim } = scene(30, 0.01);
    const rock = start(sim, 0.025);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stopReason, 'maxTime');
    assert.equal(rock.stepsTaken, 3);
    assert.ok(rock.elapsedTime >= 0.025 && rock.elapsedTime <= 0.035 + 1e-9);
});

test('override de pasos tiene precedencia solo cuando alcanza antes del tiempo', () => {
    const { sim } = scene(30, 0.01);
    sim.maxStepsPerRock = 2;
    const rock = start(sim, 1);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stopReason, 'maxSteps');
    assert.equal(rock.stepsTaken, 2);
});

test('finish es idempotente y motor terminal no consume presupuesto', () => {
    const { engine, terrain } = scene();
    const rock = engine.createRock(0, 0, 0.5, 2700, 1, 0, 'sphere');
    assert.equal(rock.stopReason, null);
    assert.equal(rock.finish('cancelled'), true);
    const x = rock.finalX;
    assert.equal(rock.finish('safetyLimit'), false);
    engine.simulateStep(rock, terrain, 0.01, []);
    assert.equal(rock.stopReason, 'cancelled');
    assert.equal(rock.finalX, x);
    assert.equal(rock.stepsTaken, 0);
    assert.equal(rock.elapsedTime, 0);
});

test('update directo solo cuenta muestreo y parada parcial cuenta un subpaso', () => {
    const { engine, terrain } = scene();
    const direct = engine.createRock(0, 0, 0.5, 2700, 1, 0, 'sphere');
    direct.update(0.01, 0);
    assert.equal(direct.stepsTaken, 0);
    assert.equal(direct.elapsedTime, 0);
    assert.equal(direct._trajStepCounter, 1);
    const rock = engine.createRock(1100, 0, 0.5, 2700, 1, 0, 'sphere');
    const n = engine.subStepsFor(rock, 0.01);
    engine.simulateStep(rock, terrain, 0.01, []);
    assert.equal(rock.stopReason, 'culled');
    assert.equal(rock.stepsTaken, 1);
    assert.ok(Math.abs(rock.elapsedTime - 0.01 / n) < 1e-12);
});

test('reposo prevalece sobre fragmentación e inmoviliza la roca', () => {
    const { engine, terrain } = scene();
    const rock = engine.createRock(0, 0, 0.5, 2700, 0, 0, 'sphere');
    rock._restCheckCount = 2;
    rock._sustainedContact = true;
    rock.angularVelocity = 0;
    rock.handleCollision = function () {
        this._checkResting({ nx: 0, ny: 1 });
        this._lastCollision = { normal: { nx: 0, ny: 1 }, vn: 1000 };
    };
    engine.fragmentationEnabled = true;
    engine.simulateStep(rock, terrain, 0.01, []);
    assert.equal(rock.stopReason, 'rest');
    assert.equal(rock.isFragmented, false);
});

test('reset y reuso recalculan duración y respetan override explícito', () => {
    const { sim } = scene(1, 0.01);
    let rock = start(sim, 0.02);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stepsTaken, 2);
    sim.reset();
    assert.equal(sim.rocks.length, 0);
    rock = start(sim, 0.04);
    assert.equal(rock.stopReason, null);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stepsTaken, 4);
    assert.equal(rock.stopReason, 'maxTime');
    sim.reset();
    sim.maxStepsPerRock = 2;
    rock = start(sim, 0.1);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stopReason, 'maxSteps');
    assert.equal(rock.stepsTaken, 2);
    sim.reset();
    sim.configure({ numRocks: 1, timeStep: 0.01, maxDuration: 0.03, fragmentationEnabled: false });
    rock = start(sim, 0.03);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stopReason, 'maxTime');
    assert.equal(rock.stepsTaken, 3);
});

test('motor terminal preserva estado completo y no consume RNG', () => {
    const { ctx, engine, terrain } = scene();
    const rock = engine.createRock(0, 0, 0.5, 2700, 1, 0, 'sphere');
    rock.isResting = true;
    const keys = ['x', 'y', 'vx', 'vy', 'rotation', 'angularVelocity', 'elapsedTime', 'stepsTaken', 'finalX', 'finalY', 'stopReason'];
    const before = keys.map(k => rock[k]);
    ctx.randomCalls = { count: 0 };
    require('node:vm').runInContext('Math.random = () => { randomCalls.count++; return 0.5; };', ctx);
    engine.simulateStep(rock, terrain, 0.01, []);
    assert.equal(ctx.randomCalls.count, 0);
    assert.deepEqual(keys.map(k => rock[k]), before);
});

test('subpasos adaptativos reales cuentan tiempo completo y parcial', () => {
    const { engine, terrain } = scene();
    for (const speed of [1, 100]) {
        const full = engine.createRock(0, 0, 0.5, 2700, speed, 0, 'sphere');
        const partial = engine.createRock(1100, 0, 0.5, 2700, speed, 0, 'sphere');
        const n = engine.subStepsFor(full, 0.01);
        assert.equal(n, speed === 1 ? 3 : 10);
        engine.simulateStep(full, terrain, 0.01, []);
        engine.simulateStep(partial, terrain, 0.01, []);
        assert.equal(full.stepsTaken, 1);
        assert.equal(partial.stepsTaken, 1);
        assert.ok(Math.abs(full.elapsedTime - 0.01) < 1e-12);
        assert.equal(partial.stopReason, 'culled');
        assert.ok(Math.abs(partial.elapsedTime - 0.01 / n) < 1e-12);
    }
});

test('precedencia física, tiempo y pasos al coincidir', () => {
    const a = scene(0.01, 0.01);
    a.sim.maxStepsPerRock = 1;
    const timed = start(a.sim, 0.01);
    a.sim.step();
    assert.equal(timed.stopReason, 'maxTime');
    const b = scene(0.01, 0.01);
    b.sim.maxStepsPerRock = 1;
    const culled = start(b.sim, 0.01);
    culled.x = 1100;
    culled.elapsedTime = 0.01 - 0.01 / b.engine.subStepsFor(culled, 0.01);
    b.sim.step();
    assert.ok(Math.abs(culled.elapsedTime - 0.01) < 1e-12);
    assert.equal(culled.stopReason, 'culled');
    assert.equal(culled.stepsTaken, 1);
});


test('margen temporal fijo distingue 0.5 ns de 2 ns tras 6000 pasos', () => {
    for (const [offset, expected] of [[5e-10, 6000], [2e-9, 6001]]) {
        const duration = 30 + offset;
        const { sim } = scene(duration, 0.005);
        const rock = start(sim);
        while (sim.isRunning) sim.step();
        assert.equal(rock.stopReason, 'maxTime');
        assert.equal(rock.stepsTaken, expected, `offset ${offset}`);
        assert.ok(rock.elapsedTime >= duration - 1e-9, `offset ${offset}: ${rock.elapsedTime}`);
        assert.ok(rock.elapsedTime <= duration + 0.005 + 1e-9);
    }
});

test('duración máxima y paso mínimo de la UI no acumulan paso extra', () => {
    const duration = 600;
    const { sim } = scene(duration, 0.001);
    const rock = start(sim);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stopReason, 'maxTime');
    assert.equal(rock.stepsTaken, 600000);
    assert.ok(rock.elapsedTime >= duration - 1e-9);
    assert.ok(rock.elapsedTime <= duration + 0.001 + 1e-9);
});


function temporalFixture(duration, dt) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: 937 });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.addPoint(-1000, -10000);
    terrain.addPoint(1000, -10000);
    const engine = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, engine);
    sim.configure({ numRocks: 1, animationSpeed: 50, timeStep: dt, maxDuration: duration, fragmentationEnabled: false });
    sim.start(0, 0, 0.5, 2700, 1, 0, duration, true, 'sphere', 0.6, 'freefall', null);
    assert.equal(sim.rocks.length, 1);
    assert.equal(sim.rocks[0].ignoreResting, true);
    assert.equal(engine.fragmentationEnabled, false);
    return { sim, rock: sim.rocks[0] };
}

test('S8: un nanosegundo redondeado no termina antes del margen', () => {
    const duration = 30.000000001;
    const dt = 0.005;
    const { sim, rock } = temporalFixture(duration, dt);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stopReason, 'maxTime');
    assert.equal(rock.stepsTaken, 6001);
    assert.ok(duration - rock.elapsedTime <= 1e-9);
    assert.ok(rock.elapsedTime - duration < dt);
});

test('barrido de invariante temporal paso a paso', (t) => {
    const started = performance.now();
    const failures = [];
    const k = 800;
    for (const dt of [0.001, 0.005, 0.05]) {
        for (const offset of [-2e-9, -1e-9, 0, 0.5e-9, 0.9e-9, 1e-9, 1.1e-9, 2e-9]) {
            const duration = k * dt + offset;
            try {
                assert.ok(duration <= 60);
                const { sim, rock } = temporalFixture(duration, dt);
                while (sim.isRunning) {
                    assert.ok(duration - rock.elapsedTime > 1e-9, 'paso previo ya dentro del margen');
                    sim.step();
                }
                assert.equal(rock.stopReason, 'maxTime');
                assert.ok(duration - rock.elapsedTime <= 1e-9, 'terminación fuera del margen');
                assert.ok(rock.elapsedTime - duration < dt, 'paso excedido');
                assert.ok(Math.abs(rock.elapsedTime - rock.stepsTaken * dt) <= 1e-12, 'acumulación');
            } catch (error) {
                failures.push(`dt=${dt}, offset=${offset}: ${error.message}`);
            }
        }
    }
    t.diagnostic(`Barrido: ${((performance.now() - started) / 1000).toFixed(3)} s; k=${k}`);
    assert.deepEqual(failures, []);
});

test('umbral exacto por pasos completos no añade paso por redondeo de subpasos', () => {
    const dt = 0.013217205007691645;
    const expected = 14205;
    const duration = expected * dt + 1e-9;
    assert.ok(expected * dt >= duration - 1e-9);
    const { sim } = scene(duration, dt);
    const rock = start(sim);
    while (sim.isRunning) sim.step();
    assert.equal(rock.stopReason, 'maxTime');
    assert.equal(rock.stepsTaken, expected);
    assert.ok(rock.elapsedTime >= duration - 1e-9);
});
