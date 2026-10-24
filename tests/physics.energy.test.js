'use strict';

/**
 * Tests de conservación de energía para js/physics.js (T0.7).
 *
 * Los defectos confirmados aquí tienen una firma común:(existe una) energía
 * mecánica que se crea de la nada —
 *   - impulso de fricción nonsmooth con el signo invertido (duplica el
 *     deslizamiento tangencial en cada impacto),
 *   - corrección de posición absoluta `terrainY + 0.01` que levanta el CENTRO
 *     1 cm por impacto sin importar tamaño ni penetración,
 *   - contacto lumped-mass por centro, sin radio,
 *   - fricción de rodadura aplicada a rocas en pleno vuelo.
 *
 * Escenario A: esfera d = 0.5 soltada desde 10 m sobre suelo plano
 * (0,0)-(200,0), preset 'concreto' (rugosidad 0), vx = 2, fragmentación
 * desactivada, cnVariability = ctVariability = 0, 3000 pasos.
 * La energía E = 0.5·m·v² + m·g·(y − radio) (+ rotación en poligonales) no
 * debe superar nunca la inicial en más del 1 %.
 *
 * Escenario B: perfil de benchmark, 30 rocas 'polygon' con seed fijo liberadas
 * en (5, 125): la velocidad máxima observada debe cumplir el tope balístico
 * v <= 1.05·sqrt(2·g·(125 − minY_terreno) + v0²).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

const SEED = 42;
const METHODS = ['lumped-mass', 'rigid-body', 'nonsmooth'];
const G = 9.81;

// ---------------------------------------------------------------------------
// Terreno real SimRocas.Terrain, de punto a punto.
// ---------------------------------------------------------------------------

// Suelo plano (0,0)-(2000,0) con rugosidad 0 ('concreto') para que los
// impulsos sean reproducibles sin perturbaciones del normal. El trazado es
// largo a propósito: con 200 m la culling de límites (x > maxX + 50) detenía
// la simulación antes de que se acumulara el bombeo de energía y el test
// pasaría vacuamente con el código defectuoso.
function flatTerrain(ctx) {
    const terrain = new ctx.SimRocas.Terrain();
    for (const [x, y] of [[0, 0], [2000, 0]]) {
        terrain.addPoint(x, y, 'concreto');
    }
    return terrain;
}

// Perfil de benchmark (el mismo del informe T0.5).
const BENCH_PROFILE = [
    [0, 120], [40, 100], [80, 70], [120, 45], [160, 25],
    [200, 15], [260, 10], [350, 8], [450, 8]
];
const BENCH_MIN_Y = Math.min(...BENCH_PROFILE.map((p) => p[1]));
const BENCH_RELEASE_Y = 125;
const BENCH_V0 = 1;

function benchTerrain(ctx) {
    const terrain = new ctx.SimRocas.Terrain();
    for (const [x, y] of BENCH_PROFILE) {
        terrain.addPoint(x, y);
    }
    return terrain;
}

function makeEngine(ctx, calcMethod) {
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.calcMethod = calcMethod;
    engine.fragmentationEnabled = false;
    engine.cnVariability = 0;
    engine.ctVariability = 0;
    return engine;
}

// E mecánica: 0.5·m·v² + m·g·(y − radio) (+ 0.5·I·ω² en los métodos con
// rotación real; en lumped-mass la rotación es cosmética, punto masa).
function mechanicalEnergy(rock, calcMethod) {
    const eTrans = 0.5 * rock.mass * (rock.vx * rock.vx + rock.vy * rock.vy);
    const ePot = rock.mass * G * (rock.y - rock.radius);
    if (calcMethod === 'lumped-mass') return eTrans + ePot;
    const eRot = 0.5 * rock.momentOfInertia * rock.angularVelocity * rock.angularVelocity;
    return eTrans + ePot + eRot;
}

// ---------------------------------------------------------------------------
// Escenario A: caída plana de 10 m, conservación de energía.
// ---------------------------------------------------------------------------

for (const method of METHODS) {
    test(`conservación de energía (${method}): caída plana 10 m nunca supera E0 en más de 1 %`, () => {
        const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { seed: SEED });
        const terrain = flatTerrain(ctx);
        const engine = makeEngine(ctx, method);

        const rock = engine.createRock(100, 10, 0.5, 2700, 2, 0, 'sphere');
        const e0 = mechanicalEnergy(rock, method);
        const limit = e0 * 1.01;

        let maxE = e0;
        for (let step = 0; step < 3000; step++) {
            engine.simulateStep(rock, terrain, 0.005, []);
            maxE = Math.max(maxE, mechanicalEnergy(rock, method));
        }

        assert.ok(rock.bounces > 0, 'la roca debe colisionar con el terreno (bounces > 0)');
        assert.ok(Math.abs(rock.x - 100) < 1900, 'la roca no debe haber sido descartada (culling) por los límites del terreno');
        assert.ok(maxE <= limit, `E máxima ${(maxE / e0 * 100).toFixed(2)} % de E0 ` +
            `(E0 = ${e0.toFixed(0)} J, exceso = ${(maxE - e0).toFixed(1)} J > 1 % permitido)`);
    });
}

// ---------------------------------------------------------------------------
// Escenario B: perfil de benchmark, tope balístico de velocidad.
// ---------------------------------------------------------------------------

const BENCH_SPEED_CAP = 1.05 * Math.sqrt(2 * G * (BENCH_RELEASE_Y - BENCH_MIN_Y) + BENCH_V0 * BENCH_V0);

for (const method of METHODS) {
    test(`perfil benchmark (${method}): 30 rocas 'polygon' respetan el tope balístico ${BENCH_SPEED_CAP.toFixed(1)} m/s`, () => {
        const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { seed: SEED });
        const terrain = benchTerrain(ctx);
        const engine = makeEngine(ctx, method);

        let maxSpeedSeen = 0;
        for (let i = 0; i < 30; i++) {
            const rock = engine.createRock(5, BENCH_RELEASE_Y, 0.5, 2700, BENCH_V0, 0, 'polygon', 0.6);
            for (let step = 0; step < 6000 && !rock.isResting; step++) {
                engine.simulateStep(rock, terrain, 0.005, []);
            }
            maxSpeedSeen = Math.max(maxSpeedSeen, rock.maxImpactVelocity);
        }

        assert.ok(maxSpeedSeen <= BENCH_SPEED_CAP,
            `velocidad máxima ${maxSpeedSeen.toFixed(2)} m/s > tope balístico ${BENCH_SPEED_CAP.toFixed(2)} m/s`);
    });
}

// ---------------------------------------------------------------------------
// Corrección de posición: cada impacto corrige sólo la penetración real.
// ---------------------------------------------------------------------------

test('corrección de posición: tras un impacto el centro queda a radio del terreno (no a 1 cm)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: SEED });
    const rock = new ctx.SimRocas.Rock(100, -0.25, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.vy = -10;
    rock.angularVelocity = 0;

    const terrain = {
        getHeightAt: () => 0,
        getSurfaceNormalAt: () => ({ nx: 0, ny: 1 }),
        getSegmentPropertiesAt: (x, cn, ct) => ({ cn, ct, roughness: 0 }),
        getSegmentAt: () => ({ properties: { roughness: 0 } })
    };

    for (const method of ['nonsmooth', 'rigid-body']) {
        const probe = new ctx.SimRocas.Rock(100, -0.25, 0.5, 2700, 0, 0, 'sphere');
        probe.vy = -10;
        probe.angularVelocity = 0;
        probe.handleCollision(terrain, 0.6, 0.4, 'impulse', 0.7, method, 0.35, 0.75);
        assert.ok(Math.abs(probe.y - rock.radius) < 1e-3,
            `${method}: centro tras el impacto a=${probe.y}, esperado ≈ radio = ${rock.radius}`);
    }
});

// ---------------------------------------------------------------------------
// Fricción de rodadura: no debe aplicarse a una roca en vuelo.
// ---------------------------------------------------------------------------

test('applyRollingFriction no altera velocidad ni omega de una roca 10 m sobre el terreno (3 métodos x 2 modelos)', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js'], { seed: SEED });
    const terrain = flatTerrain(ctx);

    for (const method of METHODS) {
        for (const rollingModel of ['simple', 'davis-mcinnnes']) {
            const rock = engine_rock_in_flight(ctx, method);
            const vx0 = rock.vx, vy0 = rock.vy, o0 = rock.angularVelocity;
            rock.applyRollingFriction(terrain, 0.15, 0.005, rollingModel, 0.01, method);
            assert.equal(rock.vx, vx0, `${method}/${rollingModel}: vx cambió en vuelo`);
            assert.equal(rock.vy, vy0, `${method}/${rollingModel}: vy cambió en vuelo`);
            assert.equal(rock.angularVelocity, o0, `${method}/${rollingModel}: omega cambió en vuelo`);
        }
    }
});

function engine_rock_in_flight(ctx, method) {
    const rock = new ctx.SimRocas.Rock(100, 10, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 3;
    rock.vy = -2;
    rock.angularVelocity = 5;
    return rock;
}

// ---------------------------------------------------------------------------
// Contacto lumped-mass con radio: el cuerpo penetra aunque el centro no.
// ---------------------------------------------------------------------------

test('lumped-mass: roca d=0.5 con centro en y=0.2 sobre suelo y=0 y vy=-10 rebota (vy > 0)', () => {
    const ctx = loadScripts(['js/physics.js'], { seed: SEED });
    const terrain = {
        getHeightAt: () => 0,
        getSurfaceNormalAt: () => ({ nx: 0, ny: 1 }),
        getSegmentPropertiesAt: (x, cn, ct) => ({ cn, ct, roughness: 0 }),
        getSegmentAt: () => null
    };
    const rock = new ctx.SimRocas.Rock(5, 0.2, 0.5, 2700, 0, 0, 'sphere');
    rock.vx = 0;
    rock.vy = -10;
    rock.angularVelocity = 0;

    rock.handleCollision(terrain, 0.6, 0.4, 'impulse', 0.7, 'lumped-mass', 0.6, 0.4);

    assert.ok(rock.vy > 0, `con el cuerpo enterrado 5 cm la roca debe rebotar; vy = ${rock.vy}`);
    assert.ok(rock.bounces === 1, 'el contacto debe registrarse exactamente una vez');
});
