'use strict';

// T0.7 (T0.7b) — slope/rolling behavior tests for lumped-mass mode.
//
// Defect A: _handleLumpedMass applies the impact law (vn -> -kn*vn, vt -> kt*vt)
// on EVERY sub-step of sustained contact. On a slope, gravity re-injects a tiny
// normal velocity each sub-step (|vn| ~ g*cos(theta)*dt ~ 0.013 m/s), so the
// tangential velocity is multiplied by kt = 0.75 ~600 times per second and
// rocks stop mid-slope even on 35 degrees with rollingFriction 0.15 (~8.5 deg).
// Reference lumped-mass models (RocFall, CRSP, Pierre2) distinguish IMPACT
// (|vn| above a minimum-velocity threshold) from SLIDING/ROLLING (below it).
//
// Defect B: _penetrationCorrection zeroes the velocity when the climb-out
// energy exceeds the current kinetic energy — a rock released at REST on a
// slope is frozen in place every sub-step.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function makeCtx(seed) {
    return loadScripts(['js/terrain.js', 'js/physics.js'], { seed: seed });
}

function makeSteepTerrain(ctx) {
    const t = new ctx.SimRocas.Terrain();
    const h = 200 * Math.tan(35 * Math.PI / 180); // ≈ 140.04 m
    t.addPoint(0, h);
    t.addPoint(200, 0);
    t.addPoint(600, 0);
    return t;
}

function makeFlatTerrain(ctx) {
    const t = new ctx.SimRocas.Terrain();
    t.addPoint(-50, 0);
    t.addPoint(600, 0);
    return t;
}

function makeGentleTerrain(ctx) {
    const t = new ctx.SimRocas.Terrain();
    const h = 200 * Math.tan(5 * Math.PI / 180);
    t.addPoint(0, h);
    t.addPoint(200, 0);
    t.addPoint(600, 0);
    return t;
}

// Simulate one rock until rest or step budget exhausted; returns { x, maxV, steps }.
function runRock(engine, terrain, rock, maxSteps) {
    let maxV = 0;
    let steps = 0;
    for (; steps < maxSteps && !rock.isResting; steps++) {
        engine.simulateStep(rock, terrain, 0.005, []);
        const s = rock.speed;
        if (s > maxV) maxV = s;
    }
    return { x: rock.x, maxV, steps, resting: rock.isResting };
}

test('lumped-mass: rocks released uphill on a 35 degree slope must not stop on the slope', () => {
    const ctx = makeCtx(42);
    const terrain = makeSteepTerrain(ctx);
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.calcMethod = 'lumped-mass';
    engine.fragmentationEnabled = false;

    const finals = [];
    for (let i = 0; i < 30; i++) {
        const rock = engine.createRock(5, terrain.getHeightAt(5) + 0.6, 0.5, 2700, 1, 0, 'polygon', 0.6);
        const r = runRock(engine, terrain, rock, 6000);
        finals.push(r.x);
    }

    finals.sort((a, b) => a - b);
    const median = finals[15];

    assert.equal(finals.filter((x) => x < 200).length, 0,
        'no rock may come to rest while still on the 35 deg slope; finals: ' + finals.map((x) => x.toFixed(1)).join(','));
    assert.ok(median > 200, `median final x (${median.toFixed(1)}) must exceed the slope end (200 m)`);
});

test('lumped-mass: rock released AT REST on the 35 degree slope must slide/roll downhill', () => {
    const ctx = makeCtx(42);
    const terrain = makeSteepTerrain(ctx);
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.calcMethod = 'lumped-mass';
    engine.fragmentationEnabled = false;

    const x0 = 5;
    // Use the engine so shape/mass match simulation; centre exactly at terrain + radius.
    const xd = 0.5;
    const rock = engine.createRock(x0, 0, xd, 2700, 0, 0, 'sphere', 0.6);
    rock.x = x0;
    rock.y = terrain.getHeightAt(x0) + rock.radius;

    const r = runRock(engine, terrain, rock, 1000); // 1000 steps = 5 s

    assert.ok(rock.x - x0 > 20, `rock released at rest must advance > 20 m downhill in 5 s, moved ${(rock.x - x0).toFixed(2)} m (resting=${rock.isResting})`);
});

test('nonsmooth: rock released AT REST on the 35 degree slope must slide/roll downhill', () => {
    const ctx = makeCtx(42);
    const terrain = makeSteepTerrain(ctx);
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.calcMethod = 'nonsmooth';
    engine.fragmentationEnabled = false;

    const x0 = 5;
    const rock = engine.createRock(x0, 0, 0.5, 2700, 0, 0, 'polygon', 0.6);
    rock.x = x0;
    rock.y = terrain.getHeightAt(x0) + rock.radius;

    engine.simulateStep(rock, terrain, 0.005, []); // settle onto vertices
    rock.y = terrain.getHeightAt(rock.x) + rock.radius;

    runRock(engine, terrain, rock, 1000);

    // Barra > 10 m: el modelo nonsmooth (referencia correcta, sin defectos
    // T0.7b) desliza con fricción de Coulomb mu = ct = 0.4 más la fricción de
    // rodadura aplicada encima, con lo que recorre ~15.4 m en 5 s — y ese
    // valor es idéntico antes y después de T0.7b (nonsmooth no se toca).
    // Una roca atascada por defecto B avanzaría ~0 m; el umbral 20 m exigía
    // al método correcto más de lo que da su propia física.
    assert.ok(rock.x - x0 > 10, `nonsmooth rock at rest must slide > 10 m downhill in 5 s, moved ${(rock.x - x0).toFixed(2)} m`);
});

test('lumped-mass: rock at rest on a gentle 5 degree slope comes to rest nearby', () => {
    const ctx = makeCtx(42);
    const terrain = makeGentleTerrain(ctx);
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.calcMethod = 'lumped-mass';
    engine.fragmentationEnabled = false;

    const x0 = 50;
    const rock = engine.createRock(x0, 0, 0.5, 2700, 0, 0, 'sphere', 0.6);
    rock.x = x0;
    rock.y = terrain.getHeightAt(x0) + rock.radius;

    runRock(engine, terrain, rock, 2000);

    assert.ok(rock.isResting, 'rock on 5 deg slope (< rolling resistance 8.5 deg) must come to rest');
    assert.ok(Math.abs(rock.x - x0) < 2, `rock on 5 deg slope must stay within 2 m of release, moved ${(rock.x - x0).toFixed(2)} m`);
});

test('lumped-mass: rock dropped 5 m onto flat ground bounces and then comes to rest', () => {
    const ctx = makeCtx(42);
    const terrain = makeFlatTerrain(ctx);
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.calcMethod = 'lumped-mass';
    engine.fragmentationEnabled = false;

    const rock = engine.createRock(100, 5, 0.5, 2700, 0, 0, 'sphere', 0.6);
    const r = runRock(engine, terrain, rock, 6000);

    assert.ok(rock.bounces >= 1, 'a 5 m drop onto flat ground must produce at least one real bounce');
    assert.ok(rock.impactEnergies.length >= 1, 'a real impact must be recorded in impactEnergies');
    assert.ok(rock.isResting, `rock must come to rest within 6000 steps (steps=${r.steps})`);
});

module.exports = null;
