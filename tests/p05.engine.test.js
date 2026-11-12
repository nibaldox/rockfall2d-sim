'use strict';

/**
 * Tests del motor P0.5 (W5a): PRNG inyectable con semilla (mulberry32).
 *
 * Contrafactual: `js/physics.js` y `js/simulation.js` de P0.4B (commit
 * bc8649b0) se leen con `git show bc8649b0:<ruta>` desde la raíz del repo
 * para verificar I1; si git no está disponible, el archivo falla (no se salta). Interfaz: `SimRocas.createRng(seed)`, `SimRocas.RNG_ALGORITHM`
 * y la opción `seed` de `Simulation.configure(params)` (en el Worker,
 * `msg.simParams.seed`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const { createContext, runScript } = require('./helpers/load');

const ROOT = path.join(__dirname, '..');
const BASE_COMMIT = 'bc8649b0';
const baseCache = {};
// Sin alternativa por variable de entorno ni por ruta externa: si `git show`
// falla, lanza y el archivo de tests falla.
function baseSource(file) {
    if (!baseCache[file]) {
        baseCache[file] = execFileSync('git', ['show', `${BASE_COMMIT}:${file}`], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
        });
    }
    return baseCache[file];
}
const SEED = 12345;
const METHODS = ['rigid-body', 'lumped-mass', 'nonsmooth'];
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
const BARRIER = [{ x1: 40, y1: 18, x2: 40, y2: 26, cn: 0.3, ct: 0.5, thickness: 0.2 }];

// Definición pública de mulberry32, con contador de sorteos.
const MULBERRY32_SOURCE = `(function (seed) {
    let a = seed >>> 0;
    return function () {
        globalThis.__randomCalls++;
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
})`;

function makeCtx(baseline = false, extra = {}, env = 'browser') {
    const ctx = createContext({ env, extra });
    vm.runInContext('globalThis.__randomCalls = 0;', ctx);
    if (env === 'worker') return ctx;
    runScript(ctx, 'js/terrain.js');
    if (baseline) {
        vm.runInContext(baseSource('js/physics.js'), ctx, { filename: 'base-physics.js' });
        vm.runInContext(baseSource('js/simulation.js'), ctx, { filename: 'base-simulation.js' });
    } else {
        runScript(ctx, 'js/physics.js');
        runScript(ctx, 'js/simulation.js');
    }
    return ctx;
}

// Sustituye `Math.random`: 'stub' (mulberry32 del test), 'createRng' (el
// generador del motor) o 'forbidden' (cualquier sorteo directo lanza).
function installRandom(ctx, mode, seed) {
    if (mode === 'stub') {
        vm.runInContext(`globalThis.__randomCalls = 0; Math.random = ${MULBERRY32_SOURCE}(${seed});`, ctx);
    } else if (mode === 'createRng') {
        vm.runInContext(`Math.random = SimRocas.createRng(${seed});`, ctx);
    } else if (mode === 'forbidden') {
        vm.runInContext('Math.random = function () { throw new Error(\'Math.random directo con semilla\'); };', ctx);
    }
}

function simParams(o) {
    const params = {
        numRocks: o.numRocks || 12, animationSpeed: 1, timeStep: 0.005, maxDuration: 30,
        fragmentationEnabled: !!o.fragmentation, fractureEnergy: 500
    };
    if ('seed' in o) params.seed = o.seed;
    return params;
}

const startArgs = o => [10, 51, 0.5, 2700, 0, 0, 30, false, o.shapeType || 'polygon', 1, 'freefall', null];

const SCALARS = ['id', 'parentId', 'rootId', 'fragmentKind', 'generation', 'isCore', 'x', 'y', 'vx', 'vy',
    'rotation', 'angularVelocity', 'mass', 'diameter', 'bounces', 'stopReason', 'finalX', 'finalY',
    'stepsTaken', 'elapsedTime', 'maxKineticEnergy', 'maxBounceHeight', 'impactCount', 'maxImpactEnergy',
    'releaseX', 'releaseY'];

// Huella de una corrida: todos los campos, forma, color y trayectoria.
// JSON conserva los dobles de forma exacta (ida y vuelta más corta).
function fingerprint(rocks) {
    // Array.from: las rocas viven en otro contexto de vm y `map` devolvería un
    // arreglo de ese contexto, que deepStrictEqual distingue por prototipo.
    return Array.from(rocks, r => {
        const out = {};
        for (const f of SCALARS) out[f] = Object.is(r[f], -0) ? '-0' : r[f];
        out.shape = r.shape;
        out.color = r.color;
        out.trajectory = Array.from(r.trajectory);
        return JSON.stringify(out);
    });
}

function finish(sim) {
    let it = 0;
    while (sim.isRunning && it++ < 400000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida debe terminar');
}

// `random`: { mode, seed } se instala DESPUÉS de construir motor y simulación
// (resolución tardía de `Math.random`).
function runIn(ctx, o, random) {
    const S = ctx.SimRocas;
    const terrain = new S.Terrain();
    terrain.setPoints(PROFILE);
    const physics = new S.PhysicsEngine();
    const sim = new S.Simulation(terrain, physics);
    if (random) installRandom(ctx, random.mode, random.seed);
    sim.configure(simParams(o));
    physics.calcMethod = o.calcMethod;
    if (o.physics) Object.assign(physics, o.physics);
    sim.barriers = o.barrier ? BARRIER : [];
    sim.start(...startArgs(o));
    finish(sim);
    return { sim, physics, rocks: sim.rocks, prints: fingerprint(sim.rocks), randomCalls: ctx.__randomCalls };
}

const CASES = [];
for (const calcMethod of METHODS) {
    for (const fragmentation of [false, true]) {
        for (const barrier of [false, true]) CASES.push({ calcMethod, fragmentation, barrier });
    }
}
const label = o => `${o.calcMethod}, fragmentación=${o.fragmentation}, barrera=${o.barrier}`;

// --- mulberry32 -------------------------------------------------------------

test('mulberry32: createRng(1) coincide con el oráculo escrito a mano y RNG_ALGORITHM lo declara', () => {
    const S = makeCtx().SimRocas;
    assert.equal(S.RNG_ALGORITHM, 'mulberry32');
    assert.equal(typeof S.createRng, 'function');
    // Oráculo: definición pública del algoritmo, con aritmética de 32 bits.
    let a = 1;
    const oracle = () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const rng = S.createRng(1);
    const got = [];
    const want = [];
    for (let i = 0; i < 5; i++) {
        got.push(rng());
        want.push(oracle());
    }
    assert.deepEqual(got, want);
    // Primer valor de mulberry32(1), calculado a mano: 2694395259 / 2^32.
    assert.equal(got[0], 0.6270739405881613);
    for (const v of got) assert.ok(v >= 0 && v < 1);
    // Generadores independientes: no comparten estado.
    const other = S.createRng(1);
    assert.equal(other(), got[0]);
});

// --- I1 ---------------------------------------------------------------------

for (const o of CASES) {
    test(`I1 sin semilla, idéntico a bc8649b0 con Math.random sustituido: ${label(o)}`, () => {
        const random = { mode: 'stub', seed: 777 };
        const now = runIn(makeCtx(false), o, random);
        const old = runIn(makeCtx(true), o, random);
        assert.equal(now.randomCalls, old.randomCalls, 'misma cantidad de sorteos');
        assert.ok(now.randomCalls > 0);
        assert.deepEqual(now.prints, old.prints);
        if (o.fragmentation) assert.ok(now.rocks.some(r => r.generation > 0), 'precondición: hay fragmentos');
    });
}

test('I1: las formas elipse y bloque tampoco cambian sin semilla', () => {
    for (const shapeType of ['ellipse', 'block', 'sphere']) {
        const o = { calcMethod: 'rigid-body', fragmentation: true, barrier: true, shapeType };
        const random = { mode: 'stub', seed: 31 };
        const now = runIn(makeCtx(false), o, random);
        const old = runIn(makeCtx(true), o, random);
        assert.equal(now.randomCalls, old.randomCalls, shapeType);
        assert.deepEqual(now.prints, old.prints, shapeType);
    }
});

// --- I2 ---------------------------------------------------------------------

for (const o of CASES) {
    test(`I2 con semilla, todo sorteo sale del generador y en el mismo orden: ${label(o)}`, () => {
        // Con semilla, un `Math.random` directo lanzaría.
        const seeded = runIn(makeCtx(), { ...o, seed: SEED }, { mode: 'forbidden' });
        // Sin semilla, `Math.random := createRng(SEED)`.
        const viaMath = runIn(makeCtx(), o, { mode: 'createRng', seed: SEED });
        assert.deepEqual(seeded.prints, viaMath.prints);
    });
}

// --- I3 ---------------------------------------------------------------------

function workerRun(o) {
    const msgs = [];
    let ctx;
    ctx = makeCtx(false, {
        postMessage: m => msgs.push(m),
        importScripts: (...files) => files.forEach(f => runScript(ctx, 'js/' + f))
    }, 'worker');
    runScript(ctx, 'js/worker.js');
    const terrainCtx = makeCtx();
    const terrain = new terrainCtx.SimRocas.Terrain();
    terrain.setPoints(PROFILE);
    installRandom(ctx, 'forbidden');
    ctx.onmessage({ data: {
        type: 'start', terrainJSON: terrain.toJSON(), simParams: simParams(o),
        physicsParams: { calcMethod: o.calcMethod }, barriers: o.barrier ? BARRIER : [], startArgs: startArgs(o)
    } });
    const complete = msgs.find(m => m.type === 'complete');
    assert.ok(complete, 'el Worker debe completar');
    assert.equal(complete.status, 'completed');
    return fingerprint(complete.rocks);
}

for (const calcMethod of METHODS) {
    test(`I3 misma semilla: normal↔normal, Worker↔Worker y normal↔Worker (${calcMethod})`, () => {
        const o = { calcMethod, fragmentation: true, barrier: true, seed: SEED };
        const a = runIn(makeCtx(), o);
        const b = runIn(makeCtx(), o);
        assert.deepEqual(a.prints, b.prints, 'normal↔normal');
        assert.deepEqual(Array.from(a.rocks, r => r.id), Array.from(b.rocks, r => r.id), 'mismos id');
        assert.equal(a.rocks[0].id, 1);
        assert.ok(a.rocks.some(r => r.generation > 0), 'precondición: hay fragmentos');
        const w1 = workerRun(o);
        const w2 = workerRun(o);
        assert.deepEqual(w1, w2, 'Worker↔Worker');
        assert.deepEqual(w1, a.prints, 'normal↔Worker');
    });
}

test('I3: repetir start en la misma simulación reinicia el generador y el contador de id', () => {
    const o = { calcMethod: 'rigid-body', fragmentation: true, barrier: false, seed: 7 };
    const first = runIn(makeCtx(), o);
    first.sim.start(...startArgs(o));
    finish(first.sim);
    assert.deepEqual(fingerprint(first.sim.rocks), first.prints);
    assert.equal(first.sim.rocks[0].id, 1);
});

test('I3: una semilla distinta da otro resultado', () => {
    const o = { calcMethod: 'rigid-body', fragmentation: false, barrier: false };
    const a = runIn(makeCtx(), { ...o, seed: 1 });
    const b = runIn(makeCtx(), { ...o, seed: 2 });
    assert.notDeepEqual(a.prints, b.prints);
    assert.notEqual(a.rocks[0].finalX, b.rocks[0].finalX);
});

test('sin semilla tras una corrida con semilla, el motor vuelve a Math.random', () => {
    const o = { calcMethod: 'rigid-body', fragmentation: false, barrier: false };
    const ctx = makeCtx();
    const seeded = runIn(ctx, { ...o, seed: SEED });
    installRandom(ctx, 'stub', 99);
    seeded.sim.configure(simParams(o));
    seeded.sim.start(...startArgs(o));
    finish(seeded.sim);
    assert.ok(ctx.__randomCalls > 0);
    assert.deepEqual(fingerprint(seeded.sim.rocks), runIn(makeCtx(), o, { mode: 'stub', seed: 99 }).prints);
});

// --- Validación ---------------------------------------------------------------

test('validación: las semillas inválidas lanzan un error y las válidas se aceptan', () => {
    const ctx = makeCtx();
    const S = ctx.SimRocas;
    const terrain = new S.Terrain();
    terrain.setPoints(PROFILE);
    const sim = new S.Simulation(terrain, new S.PhysicsEngine());
    const base = simParams({});
    for (const seed of [1.5, -1, 4294967296, NaN, Infinity, -Infinity, '5', null, true, {}]) {
        assert.throws(() => sim.configure({ ...base, seed }), /[Ss]emilla/, `semilla ${String(seed)}`);
        assert.throws(() => S.createRng(seed), /[Ss]emilla/, `createRng ${String(seed)}`);
    }
    assert.throws(() => S.createRng(undefined), /[Ss]emilla/);
    for (const seed of [0, 1, 12345, 4294967295]) {
        sim.configure({ ...base, seed });
        assert.equal(sim.seed, seed);
    }
    sim.configure({ ...base, seed: undefined });
    assert.equal(sim.seed, undefined);
    sim.configure(base);
    assert.equal(sim.seed, undefined);
});

test('el generador no viaja como propiedad enumerable de motor ni de roca', () => {
    const run = runIn(makeCtx(), { calcMethod: 'rigid-body', fragmentation: false, barrier: false, seed: 3 });
    for (const obj of [run.physics, run.rocks[0]]) {
        for (const key of Object.keys(obj)) assert.notEqual(typeof obj[key], 'function', key);
    }
});

// --- Correlación Cn/Ct y Kn/Kt (CW5, contrato §4) ------------------------------

function mulberry(seed) {
    let a = seed >>> 0;
    const fn = () => {
        fn.calls++;
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    fn.calls = 0;
    return fn;
}

function pearson(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
}

// Factores de un paso. Con el motor de W5a (sin `stepVariationFactors`) usa
// la misma secuencia de cuatro llamadas que hacía `simulateStep`.
function drawFactors(physics) {
    if (typeof physics.stepVariationFactors === 'function') return physics.stepVariationFactors();
    return {
        cnFactor: physics.variationFactor(physics.cnVariability, 'cn'),
        ctFactor: physics.variationFactor(physics.ctVariability, 'ct'),
        knFactor: physics.variationFactor(physics.cnVariability, 'cn'),
        ktFactor: physics.variationFactor(physics.ctVariability, 'ct')
    };
}

function sampleFactors(correlated, n, seed, cnVar = 20, ctVar = 35) {
    const physics = new (makeCtx().SimRocas.PhysicsEngine)();
    const rng = mulberry(seed);
    physics.setRng(rng);
    physics.cnVariability = cnVar;
    physics.ctVariability = ctVar;
    physics.correlatedParams = correlated;
    const out = { cn: [], ct: [], kn: [], kt: [], calls: 0 };
    for (let i = 0; i < n; i++) {
        const f = drawFactors(physics);
        out.cn.push(f.cnFactor);
        out.ct.push(f.ctFactor);
        out.kn.push(f.knFactor);
        out.kt.push(f.ktFactor);
    }
    out.calls = rng.calls;
    return out;
}

test('correlación activa: Pearson(cn, ct) > 0.99 y Pearson(kn, kt) > 0.99, con un shared por par', () => {
    const on = sampleFactors(true, 2000, 4242);
    assert.ok(pearson(on.cn, on.ct) > 0.99, `r(cn, ct) = ${pearson(on.cn, on.ct)}`);
    assert.ok(pearson(on.kn, on.kt) > 0.99, `r(kn, kt) = ${pearson(on.kn, on.kt)}`);
    // Cada par usa su propio shared: los pares son independientes entre sí.
    assert.ok(Math.abs(pearson(on.cn, on.kn)) < 0.1, `r(cn, kn) = ${pearson(on.cn, on.kn)}`);
    // factor = 1 + shared·variación en ambos: mismo shared, signo positivo.
    for (let i = 0; i < on.cn.length; i++) {
        const sharedCn = (on.cn[i] - 1) / 0.20;
        const sharedCt = (on.ct[i] - 1) / 0.35;
        assert.ok(Math.abs(sharedCn - sharedCt) < 1e-12, `paso ${i}: ${sharedCn} vs ${sharedCt}`);
        assert.ok(Math.abs((on.kn[i] - 1) / 0.20 - (on.kt[i] - 1) / 0.35) < 1e-12, `paso ${i} (kn, kt)`);
        assert.ok(Math.abs(sharedCn) <= 1);
    }
});

test('correlación apagada: |r| < 0.1 con n >= 1000 y factores idénticos bit a bit a la fórmula de W5a', () => {
    const n = 2000;
    const off = sampleFactors(false, n, 4242);
    assert.ok(Math.abs(pearson(off.cn, off.ct)) < 0.1, `r(cn, ct) = ${pearson(off.cn, off.ct)}`);
    assert.ok(Math.abs(pearson(off.kn, off.kt)) < 0.1, `r(kn, kt) = ${pearson(off.kn, off.kt)}`);
    const ref = mulberry(4242);
    for (let i = 0; i < n; i++) {
        assert.equal(off.cn[i], 1 + (ref() * 2 - 1) * (20 / 100));
        assert.equal(off.ct[i], 1 + (ref() * 2 - 1) * (35 / 100));
        assert.equal(off.kn[i], 1 + (ref() * 2 - 1) * (20 / 100));
        assert.equal(off.kt[i], 1 + (ref() * 2 - 1) * (35 / 100));
    }
});

test('correlación: mismo número y orden de sorteos con el control activo y apagado', () => {
    const on = sampleFactors(true, 1000, 99);
    const off = sampleFactors(false, 1000, 99);
    assert.equal(on.calls, 4000);
    assert.equal(off.calls, 4000);
    // Mismo orden: el primer sorteo de cada par es el de cn/kn en ambos modos.
    assert.deepEqual(on.cn, off.cn);
    assert.deepEqual(on.kn, off.kn);
    assert.notDeepEqual(on.ct, off.ct);

    // Un paso real de `simulateStep` en caída libre consume lo mismo.
    const calls = [true, false].map(correlated => {
        const S = makeCtx().SimRocas;
        const terrain = new S.Terrain();
        terrain.setPoints(PROFILE);
        const physics = new S.PhysicsEngine();
        const rng = mulberry(5);
        physics.setRng(rng);
        physics.cnVariability = 20;
        physics.ctVariability = 20;
        physics.correlatedParams = correlated;
        const rock = new S.Rock(10, 80, 0.5, 2700, 0, 0, 'polygon', 1, rng);
        const before = rng.calls;
        for (let i = 0; i < 5; i++) physics.simulateStep(rock, terrain, 0.01, []);
        return rng.calls - before;
    });
    assert.equal(calls[0], calls[1]);
    assert.equal(calls[0], 20);
});

test('correlación en una corrida: simulateStep usa los factores correlacionados y la semilla la reproduce', () => {
    const S = makeCtx().SimRocas;
    const physics = new S.PhysicsEngine();
    assert.equal(typeof physics.stepVariationFactors, 'function');
    let seen = 0;
    const original = physics.stepVariationFactors.bind(physics);
    physics.stepVariationFactors = () => { seen++; return original(); };
    const terrain = new S.Terrain();
    terrain.setPoints(PROFILE);
    physics.simulateStep(new S.Rock(10, 80, 0.5, 2700, 0, 0, 'polygon', 1), terrain, 0.01, []);
    assert.equal(seen, 1);

    const vary = correlatedParams => ({ cnVariability: 20, ctVariability: 20, correlatedParams });
    for (const calcMethod of METHODS) {
        const o = { calcMethod, fragmentation: true, barrier: true, seed: 777, physics: vary(true) };
        const a = runIn(makeCtx(), o);
        const b = runIn(makeCtx(), o);
        assert.deepEqual(a.prints, b.prints, `${calcMethod}: misma semilla, control activo`);
        // I2 con el control activo: mismo flujo que Math.random := createRng(seed).
        const viaMath = runIn(makeCtx(), { ...o, seed: undefined }, { mode: 'createRng', seed: 777 });
        assert.deepEqual(a.prints, viaMath.prints, `${calcMethod}: I2 con el control activo`);
        const off = runIn(makeCtx(), { ...o, physics: vary(false) });
        assert.notDeepEqual(a.prints, off.prints, `${calcMethod}: el control cambia la corrida`);
    }
});

test('correlación apagada en una corrida con variabilidad: idéntica a la base bc8649b0', () => {
    for (const calcMethod of METHODS) {
        const o = {
            calcMethod, fragmentation: true, barrier: true,
            physics: { cnVariability: 20, ctVariability: 35, correlatedParams: false }
        };
        const now = runIn(makeCtx(), o, { mode: 'stub', seed: 31 });
        const base = runIn(makeCtx(true), o, { mode: 'stub', seed: 31 });
        assert.deepEqual(now.prints, base.prints, calcMethod);
        assert.equal(now.randomCalls, base.randomCalls, calcMethod);
    }
});
