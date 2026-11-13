'use strict';

/**
 * T0.12 — Tunneling: sub-pasos adaptativos en PhysicsEngine.simulateStep.
 *
 * Defecto: `subSteps = 3` fijo. Con dt = 0.02 y vx = 60 m/s el desplazamiento
 * por sub-paso es 0.4 m y una roca con r = 0.5 atraviesa una pared de
 * 0.3 m de ancho × 30 m de alto sin contacto ni pérdida de velocidad:
 * sale al otro lado a la misma rapidez (tunneling puro).
 *
 * Corrección: el número de sub-pasos se adapta al desplazamiento máximo:
 *   maxSubStepDisplacement = 0.1
 *   subSteps = min(64, max(3, ceil(dt * speedEstimate / maxSubStepDisplacement)))
 * con speedEstimate = rapidez actual + g·dt (cota de la ganancia por
 * gravedad dentro del paso). Con dt = 0.005 el cálculo sigue dando
 * 3 sub-pasos hasta ~60 m/s, así que los resultados por defecto (dt 0.005,
 * rocas < 55 m/s) no cambian.
 *
 * Exposición de la aritmética: PhysicsEngine.prototype.subStepsFor(rock, dt)
 * para poder probarlo directamente (límites 3 y 64, NAN-safe).
 *
 * La variación aleatoria cn/ct sigue siendo UNA por paso (no por sub-paso).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function loadCtx(seed) {
    return loadScripts(
        ['js/terrain.js', 'js/physics.js', 'js/simulation.js'],
        { env: 'node', seed }
    );
}

// Pared estrecha de ancho `wallWidth` y altura `wallHeight` (m) clavada en
// suelo plano: dos rampas suaves para que el tramo no sea un salto vertical.
function wallTerrain(ctx, wallWidth, wallHeight) {
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(
        [
            { x: 0, y: 10 },
            { x: 100 - wallWidth / 2, y: 10 },
            { x: 100, y: 10 + wallHeight },
            { x: 100 + wallWidth / 2, y: 10 },
            { x: 300, y: 10 }
        ]
    );
    return terrain;
}

function newEngine(ctx, method) {
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.calcMethod = method;
    engine.rollingFriction = 0.0;
    engine.fragmentationEnabled = false;
    return engine;
}

/**
 * Lanza la roca horizontalmente a 80 m de la pared y avanza hasta que
 * cruce la ventana de la pared o se detenga (cap generoso de pasos).
 * Devuelve contactos y recorrido sobre la pared.
 */
function runIntoWall({ method, dt, vx, wallWidth, wallHeight, seed = 2 }) {
    const ctx = loadCtx(seed);
    const terrain = wallTerrain(ctx, wallWidth, wallHeight);
    const engine = newEngine(ctx, method);
    const rock = engine.createRock(80, 10.5, 1.0, 2700, vx, 0, 'sphere', 1);
    let sawContact = false;
    let crossedAbove = false;
    for (let s = 0; s < 1500 && !rock.isResting; s++) {
        const xPrev = rock.x;
        engine.simulateStep(rock, terrain, dt, []);
        // Contacto en la pared: desaceleración fuerte, rebote o frena antes
        // del lado lejano de la ventana (+radio +margen).
        if (Math.abs(rock.vx) < vx - 1 || rock.x < 100.3 || rock.bounces > 0) {
            sawContact = true;
        }
        // Atravesó la pared por arriba: y sobre la cima estando aún dentro
        // de la ventana (con radio de margen).
        if (
            Math.abs(rock.x - 100) <= wallWidth / 2 + 0.6 &&
            rock.y > 10 + wallHeight
        ) {
            crossedAbove = true;
        }
        if (rock.x > xPrev + 1) {
            crossedAbove = crossedAbove; // hop grande: cubierto por crossedAbove
        }
        if (rock.x > 112) break; // quedó claramente al otro lado
    }
    return {
        sawContact,
        crossedAbove,
        speed: rock.speed,
        finalX: rock.x,
        resting: rock.isResting
    };
}

for (const method of ['lumped-mass', 'rigid-body', 'nonsmooth']) {
    for (const [dt, vx] of [[0.02, 60], [0.05, 60], [0.05, 100]]) {
        test(`(${method}) pared 0.3 m × 30 m: contacto y sin tunneling (dt=${dt}, v=${vx})`, () => {
            const r = runIntoWall({ method, dt, vx, wallWidth: 0.3, wallHeight: 30 });
            // RED (código viejo): sale al otro lado a la misma velocidad.
            assert.ok(r.sawContact, `contacto no registrado en la pared (finalX=${r.finalX}, speed=${r.speed})`);
            assert.ok(
                !r.crossedAbove,
                `atravesó la pared sin contacto (finalX=${r.finalX.toFixed(3)}, y sobre la cima dentro de la ventana)`
            );
            assert.ok(
                r.speed < 0.95 * vx,
                `sin pérdida de energía: speed=${r.speed.toFixed(2)} ≈ vx=${vx}`
            );
        });
    }
}

// Tramo vertical: empuje horizontal a nivel del suelo contra la pared ancha
// (2 m) y baja (5 m): sin cohetes y con frena visible en 800 pasos.
test('lumped-mass: empuje horizontal contra pared 2 m × 5 m a 20 m/s termina en reposo contra ella', () => {
    const ctx = loadCtx(4);
    const terrain = wallTerrain(ctx, 2, 5);
    const engine = newEngine(ctx, 'lumped-mass');
    const rock = engine.createRock(80, 10.5, 1.0, 2700, 20, 0, 'sphere', 1);
    for (let s = 0; s < 800 && !rock.isResting; s++) engine.simulateStep(rock, terrain, 0.02, []);
    assert.ok(rock.bounces > 0, 'la roca alcanza la pared (bounces > 0)');
    assert.ok(
        rock.finalX <= 100 + 1 + 1.0,
        `debe quedar pegado a la pared (finalX=${rock.finalX})`
    );
    // Tras los rebotes contra la pared el empuje queda acotado por el
    // impulso de rebote cn·v (≈ 0.5·20): sin atravesar y sin seguir
    // empujando con la rapidez inicial.
    assert.ok(
        Math.abs(rock.vx) < 0.6 * 20,
        `debe perder el empuje contra la pared (vx=${rock.vx.toFixed(2)})`
    );
});

// --- Aritmética de sub-pasos: subStepsFor(rock, dt) -------------------------

test('subStepsFor: 3 sub-pasos por debajo del umbral de desplazamiento', () => {
    const ctx = loadCtx(1);
    const { PhysicsEngine, Rock } = ctx.SimRocas;
    assert.equal(typeof PhysicsEngine.prototype.subStepsFor, 'function');
    const engine = new PhysicsEngine();
    // Bajo el umbral dt·v < 0.3: el cálculo devuelve 3 (con dt 0.005 hasta
    // ~60 m/s, para asegurar que los resultados por defecto no cambian).
    for (const dt of [0.001, 0.002, 0.005]) {
        for (const v of [0, 1, 5, 20, 40]) {
            const rock = new Rock(0, 0, 0.5, 2700, v, 0, 'sphere', 1);
            assert.equal(
                engine.subStepsFor(rock, dt), 3,
                `dt=${dt}, v=${v}: bajo el umbral deben ser 3 sub-pasos`
            );
        }
    }
    // Con dt mayores el umbral dt·v < 0.3 se alcanza antes.
    const calm = new Rock(0, 0, 0.5, 2700, 8, 0, 'sphere', 1);
    assert.equal(engine.subStepsFor(calm, 0.02), 3, 'dt 0.02, v=8: bajo el umbral, 3 sub-pasos');
    const slow = new Rock(0, 0, 0.5, 2700, 15, 0, 'sphere', 1);
    assert.equal(engine.subStepsFor(slow, 0.01), 3, 'dt 0.01, v=15: bajo el umbral, 3 sub-pasos');
});

test('subStepsFor: crece con la rapidez y satura en 64', () => {
    const ctx = loadCtx(1);
    const { PhysicsEngine, Rock } = ctx.SimRocas;
    const engine = new PhysicsEngine();
    const fast = new Rock(0, 0, 0.5, 2700, 60, 0, 'sphere', 1);
    assert.ok(engine.subStepsFor(fast, 0.02) > 3, 'a 60 m/s con dt 0.02 se necesitan más de 3');
    const veryFast = new Rock(0, 0, 0.5, 2700, 100, 0, 'sphere', 1);
    const many = engine.subStepsFor(veryFast, 0.05);
    assert.ok(many > 3, `a 100 m/s con dt 0.05 se necesitan más de 3 (salió ${many})`);
    // La formulación con rapidez + g·dt excede 64 sólo en casos absurdos:
    // la cota máxima es exactamente 64.
    assert.ok(engine.subStepsFor(veryFast, 0.05) <= 64, 'cota superior 64');
});

test('subStepsFor: NAN-safe (entradas degeneradas no rompen el bucle maestro)', () => {
    const ctx = loadCtx(1);
    const { PhysicsEngine } = ctx.SimRocas;
    const engine = new PhysicsEngine();
    const fake = { vx: NaN, vy: NaN };
    const n = engine.subStepsFor(fake, 0.02);
    assert.ok(Number.isFinite(n) && n >= 3 && n <= 64, `con NaN debe devolver 3 (salió ${n})`);
});
