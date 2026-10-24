'use strict';

/**
 * Tests del modelo de fragmentación progresiva (js/physics.js, tras c1fdbd7):
 *   - PhysicsEngine._fragmentRockProgressive(rock, normal, energyRatio)
 *       ratio < 3  -> abrasión: 1-3 esquirlas + núcleo que sobrevive
 *       ratio >= 3 -> ruptura: 2 fragmentos principales + esquirlas, sin núcleo
 *   - fragmentRock(rock, normal): wrapper legado (ratio fijo 2.0, array plano)
 *   - simulateStep(): gatillo impactEnergy > fractureEnergy
 *                     && generation < 3 && diameter > 0.10
 *   - T0.7: unidades de massLossRatio (fracción de masa, no kg/m) y contacto
 *     lumped-mass por cuerpo (con radio), ambos corregidos.
 *
 * Cada caso estocástico se repite con 20 semillas (el nº de esquirlas, los
 * ángulos de eyección y las escalas de velocidad son aleatorios).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const EPS = 1e-6;

// Terreno plano y=0 con la interfaz completa que usan las rutas de colisión.
function flatTerrain() {
    return {
        getHeightAt: () => 0,
        getSurfaceNormalAt: () => ({ nx: 0, ny: 1 }),
        getSegmentPropertiesAt: (x, cn, ct) => ({ cn, ct, roughness: 0 }),
        getSegmentAt: () => null
    };
}

// Esfera d=0.8 (densidad 2700): con las fracciones de masa del modelo
// (5%-15% por esquirla en abrasión, 3%-10% en ruptura) el diámetro de cada
// esquirla queda por encima del filtro de polvo de 0.05 m
// (js/physics.js:1131 y :1220), así la conservación de masa es exacta.
// Velocidad conocida "tras el rebote": vx=3, vy=8.
function makeRock(ctx, overrides = {}) {
    const { x = 5, y = 1, diameter = 0.8, vx = 3, vy = 8 } = overrides;
    const rock = new ctx.SimRocas.Rock(x, y, diameter, 2700, 0, 0, 'sphere');
    rock.vx = vx;
    rock.vy = vy;
    rock.angularVelocity = 0;
    return rock;
}

function allPieces(result) {
    const pieces = result.children.slice();
    if (result.core) pieces.push(result.core);
    return pieces;
}

function assertMassConserved(pieces, parent, label) {
    const total = pieces.reduce((s, r) => s + r.mass, 0);
    const diff = Math.abs(total - parent.mass);
    assert.ok(diff < EPS,
        `${label}: la suma de masas (${total}) debe igualar la masa del padre (${parent.mass}), diff=${diff}`);
}

function assertEnergyNotCreated(pieces, parent, label) {
    const parentKe = parent.kineticEnergy;
    const childrenKe = pieces.reduce((s, r) => s + r.kineticEnergy, 0);
    assert.ok(childrenKe <= parentKe + EPS,
        `${label}: la energía cinética de los fragmentos (${childrenKe} J) no debe superar la del padre (${parentKe} J)`);
}

function assertIsChild(piece, parent, label) {
    assert.equal(piece.generation, parent.generation + 1,
        `${label}: generation = parent.generation + 1`);
    assert.equal(piece.parentId, parent.id,
        `${label}: parentId = parent.id`);
}

// --- Contrato de _fragmentRockProgressive ---------------------------------

test('abrasión ratio 1.2: una esquirla, núcleo sobrevive, masa y energía conservadas', () => {
    for (const seed of SEEDS) {
        const ctx = loadScripts(['js/physics.js'], { seed });
        const engine = new ctx.SimRocas.PhysicsEngine();
        const parent = makeRock(ctx);
        const label = `seed ${seed}`;

        const result = engine._fragmentRockProgressive(parent, { nx: 0, ny: 1 }, 1.2);

        assert.ok(result.core, `${label}: en abrasión el núcleo debe sobrevivir (core no nulo)`);
        assert.equal(result.children.length, 1, `${label}: con ratio < 1.5 se desprende exactamente 1 esquirla`);

        const pieces = allPieces(result);
        assertMassConserved(pieces, parent, label);
        assertEnergyNotCreated(pieces, parent, label);

        for (const child of result.children) assertIsChild(child, parent, label);

        const core = result.core;
        assert.equal(core.generation, parent.generation, `${label}: el núcleo conserva la generation del padre`);
        assert.equal(core.parentId, parent.parentId, `${label}: el núcleo hereda el parentId del padre`);
        assert.equal(core.id, parent.id, `${label}: el núcleo conserva el id del padre (continuidad de trayectoria)`);
        assert.equal(core.isCore, true, `${label}: core.isCore === true`);
        assert.ok(core.mass < parent.mass, `${label}: el núcleo pierde masa (${core.mass} < ${parent.mass})`);

        // La llamada no muta al padre.
        assert.equal(parent.vx, 3, `${label}: el padre conserva su vx`);
        assert.equal(parent.vy, 8, `${label}: el padre conserva su vy`);
    }
});

test('abrasión ratio 2.5: 2-3 esquirlas, núcleo sobrevive, masa y energía conservadas', () => {
    for (const seed of SEEDS) {
        const ctx = loadScripts(['js/physics.js'], { seed });
        const engine = new ctx.SimRocas.PhysicsEngine();
        const parent = makeRock(ctx);
        const label = `seed ${seed}`;

        const result = engine._fragmentRockProgressive(parent, { nx: 0, ny: 1 }, 2.5);

        assert.ok(result.core, `${label}: en abrasión el núcleo debe sobrevivir (core no nulo)`);
        assert.ok(result.children.length >= 2 && result.children.length <= 3,
            `${label}: 2-3 esquirlas en abrasión, got ${result.children.length}`);

        const pieces = allPieces(result);
        assertMassConserved(pieces, parent, label);
        assertEnergyNotCreated(pieces, parent, label);

        for (const child of result.children) assertIsChild(child, parent, label);
        assert.equal(result.core.generation, parent.generation, `${label}: el núcleo conserva la generation`);
    }
});

test('ruptura ratio 4: sin núcleo, 3-4 fragmentos, masa y energía conservadas', () => {
    for (const seed of SEEDS) {
        const ctx = loadScripts(['js/physics.js'], { seed });
        const engine = new ctx.SimRocas.PhysicsEngine();
        const parent = makeRock(ctx);
        const label = `seed ${seed}`;

        const result = engine._fragmentRockProgressive(parent, { nx: 0, ny: 1 }, 4.0);

        assert.equal(result.core, null, `${label}: en ruptura el núcleo debe ser nulo`);
        assert.ok(result.children.length >= 3 && result.children.length <= 4,
            `${label}: 1-2 esquirlas + 2 fragmentos principales, got ${result.children.length}`);

        assertMassConserved(result.children, parent, label);
        assertEnergyNotCreated(result.children, parent, label);

        for (const child of result.children) assertIsChild(child, parent, label);
    }
});

test('fragmentRock (legado): array plano de 2 a 4 elementos con el núcleo incluido', () => {
    for (const seed of SEEDS) {
        const ctx = loadScripts(['js/physics.js'], { seed });
        const engine = new ctx.SimRocas.PhysicsEngine();
        const parent = makeRock(ctx);
        const label = `seed ${seed}`;

        const pieces = engine.fragmentRock(parent, { nx: 0, ny: 1 });

        assert.ok(Array.isArray(pieces), `${label}: debe devolver un array plano`);
        assert.ok(pieces.length >= 2 && pieces.length <= 4,
            `${label}: entre 2 y 4 elementos, got ${pieces.length}`);

        const cores = pieces.filter((r) => r.isCore);
        assert.equal(cores.length, 1, `${label}: exactamente un núcleo (ratio 2.0 = abrasión)`);
        for (const piece of pieces) {
            if (piece.isCore) continue;
            assertIsChild(piece, parent, label);
        }

        assertMassConserved(pieces, parent, label);
        assertEnergyNotCreated(pieces, parent, label);
    }
});

// --- Gatillo en simulateStep ------------------------------------------------

function fragmentationEngine(ctx, fractureEnergy) {
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.fragmentationEnabled = true;
    engine.fractureEnergy = fractureEnergy;
    engine.calcMethod = 'lumped-mass';
    return engine;
}

// Roca con el centro por debajo del suelo y=0: lumped-mass detecta contacto
// por centro (no por cuerpo), así se garantiza _lastCollision para el gatillo.
function fallingRock(ctx, { generation = 0, diameter = 0.5 } = {}) {
    const rock = new ctx.SimRocas.Rock(5, -0.05, diameter, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.vy = -10;
    rock.angularVelocity = 0;
    rock.generation = generation;
    rock.ignoreResting = true;
    return rock;
}

test('simulateStep dispara fragmentación cuando impactEnergy > fractureEnergy', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 7 });
    const engine = fragmentationEngine(ctx, 1);
    const rock = fallingRock(ctx);

    const children = engine.simulateStep(rock, flatTerrain(), 0.005, []);

    assert.ok(Array.isArray(children) && children.length >= 2,
        `una roca elegible (generation 0, d=0.5, E>>umbral) debe fragmentar, got ${children}`);
    assert.equal(rock.isFragmented, true, 'el padre queda marcado como fragmentado');
    for (const child of children) assertIsChild(child, rock, 'gatillo');
});

test('simulateStep: roca de generation 3 no se fragmenta (límite generation < 3)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 7 });
    const engine = fragmentationEngine(ctx, 1);
    const rock = fallingRock(ctx, { generation: 3 });

    const children = engine.simulateStep(rock, flatTerrain(), 0.005, []);

    assert.equal(children, null, 'no debe devolver hijos');
    assert.equal(rock.isFragmented, false, 'no debe marcarse como fragmentada');
    assert.ok(rock.bounces > 0, 'la roca sí colisionó: el bloqueo es por generación, no por falta de contacto');
});

test('simulateStep: roca de diámetro 0.08 no se fragmenta (mínimo 0.10)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 7 });
    const engine = fragmentationEngine(ctx, 1); // umbral mínimo: solo el diámetro puede bloquear
    const rock = fallingRock(ctx, { diameter: 0.08 });

    const children = engine.simulateStep(rock, flatTerrain(), 0.005, []);

    assert.equal(children, null, 'no debe devolver hijos');
    assert.equal(rock.isFragmented, false, 'no debe marcarse como fragmentada');
    assert.ok(rock.bounces > 0, 'la roca sí colisionó con energía suficiente: el bloqueo es por diámetro');
});

test('simulateStep: roca de generation 2 sí se fragmenta (control del límite)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 7 });
    const engine = fragmentationEngine(ctx, 1);
    const rock = fallingRock(ctx, { generation: 2 });

    const children = engine.simulateStep(rock, flatTerrain(), 0.005, []);

    assert.ok(Array.isArray(children) && children.length >= 2,
        `generation 2 < 3 debe fragmentar, got ${children}`);
});

test('simulateStep respeta fractureEnergy: bajo el umbral fragmenta, por encima no', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 7 });
    const terrain = flatTerrain();
    // impactEnergy ≈ 0.5 * 176.7 kg * (10.02 m/s)² ≈ 8.9e3 J (d=0.5, ρ=2700)
    const engineLow = fragmentationEngine(ctx, 5000);
    const childrenLow = engineLow.simulateStep(fallingRock(ctx), terrain, 0.005, []);
    assert.ok(Array.isArray(childrenLow) && childrenLow.length >= 2,
        'con fractureEnergy=5000 (< impacto ~8.9e3 J) debe fragmentar');

    const engineHigh = fragmentationEngine(ctx, 20000);
    const childrenHigh = engineHigh.simulateStep(fallingRock(ctx), terrain, 0.005, []);
    assert.equal(childrenHigh, null, 'con fractureEnergy=20000 (> impacto) no debe fragmentar');
});

// --- Unidades de massLossRatio (T0.7) ---------------------------------------

test('massLossRatio es una fracción (0..1) tras abrasión y ruptura, no kg/m', () => {
    for (const seed of [41, 42, 43]) {
        const ctx = loadScripts(['js/physics.js'], { seed });
        const engine = new ctx.SimRocas.PhysicsEngine();
        const label = `seed ${seed}`;

        const parentA = makeRock(ctx);
        const abrasion = engine._fragmentRockProgressive(parentA, { nx: 0, ny: 1 }, 2.5);
        assert.ok(abrasion.core, `${label}: en abrasión hay núcleo`);
        assert.ok(abrasion.core.massLossRatio >= 0 && abrasion.core.massLossRatio <= 0.4 + EPS,
            `${label}: massLossRatio en abrasión = ${abrasion.core.massLossRatio} fuera de [0, 0.4]`);

        const parentR = makeRock(ctx);
        const rupture = engine._fragmentRockProgressive(parentR, { nx: 0, ny: 1 }, 4.0);
        for (const child of rupture.children) {
            assert.ok(child.massLossRatio >= 0 && child.massLossRatio <= 0.4 + EPS,
                `${label}: massLossRatio en ruptura = ${child.massLossRatio} fuera de [0, 0.4]`);
        }
    }
});

// --- Contacto lumped-mass (T0.7, corregido) ---------------------------------

test('lumped-mass detecta el contacto cuando solo el cuerpo (no el centro) penetra', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 3 });
    const terrain = flatTerrain();
    // Esfera d=0.5 (radio 0.25) con el centro en y=0.2: el cuerpo llega hasta
    // y=-0.05 (0.05 m enterrados) pero el centro sigue sobre el suelo.
    const rock = new ctx.SimRocas.Rock(5, 0.2, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.vy = -10;
    rock.angularVelocity = 0;

    rock.handleCollision(terrain, 0.6, 0.4, 'impulse', 0.7, 'lumped-mass', 0.6, 0.4);

    // Contacto por cuerpo: se registra el impacto y el gatillo de
    // fragmentación queda disponible.
    assert.equal(rock.bounces, 1, 'el contacto se registra (bounces === 1)');
    assert.ok(rock._lastCollision, 'hay _lastCollision para el gatillo de fragmentación');
    assert.ok(rock.vy > 0, `la roca rebota (vy > 0); vy actual = ${rock.vy}`);
    // Tras la corrección de posición el centro queda a radio del terreno.
    assert.ok(Math.abs(rock.y - rock.radius) < 1e-3,
        `centro a radio del terreno (esperado ~0.25, real ${rock.y})`);
});

test('contraste: rigid-body sí detecta el mismo contacto (vértice más profundo)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 3 });
    const rock = new ctx.SimRocas.Rock(5, 0.2, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.vy = -10;
    rock.angularVelocity = 0;

    rock.handleCollision(flatTerrain(), 0.6, 0.4, 'impulse', 0.7, 'rigid-body');

    assert.ok(rock._lastCollision, 'rigid-body registra el contacto');
    assert.ok(rock.vy > 0, `rigid-body rebota (vy > 0), got vy=${rock.vy}`);
});

test('contraste: nonsmooth sí detecta el mismo contacto (vértice más profundo)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: 3 });
    const rock = new ctx.SimRocas.Rock(5, 0.2, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.vy = -10;
    rock.angularVelocity = 0;

    rock.handleCollision(flatTerrain(), 0.6, 0.4, 'impulse', 0.7, 'nonsmooth');

    assert.ok(rock._lastCollision, 'nonsmooth registra el contacto');
    assert.ok(rock.vy > 0, `nonsmooth rebota (vy > 0), got vy=${rock.vy}`);
});
