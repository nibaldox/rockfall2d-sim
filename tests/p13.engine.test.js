'use strict';

/**
 * P1.3, paquete A (motor): colectores pasivos x = xc.
 *
 * Oráculo (CONTRATO_P13 §3 y §6):
 *   - caso balístico sin contacto contra la recurrencia discreta de Euler
 *     semi-implícito;
 *   - pasividad byte a byte frente a `git show 9232d1fe` con 0 y con 3
 *     colectores, en hilo y en vm-Worker, con fragmentación y rugosidad, y con
 *     el mismo número de llamadas a rng;
 *   - cruce por corrección de posición; pieza nacida del otro lado;
 *   - paridad hilo ↔ Worker de los cruces; tope de 64; validación.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { ROOT, createContext } = require('./helpers/load');

const BASE = '9232d1feac442a56a551e569ccd0fdab0cadcd3a';
const ENGINE_FILES = ['js/terrain.js', 'js/physics.js', 'js/simulation.js'];
const SEED = 1234;

const baseCache = new Map();
function source(file, which) {
    if (which === 'now') return fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!baseCache.has(file)) {
        baseCache.set(file, execFileSync('git', ['show', `${BASE}:${file}`], {
            cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
        }));
    }
    return baseCache.get(file);
}

// Cuenta todos los sorteos: Math.random y los generadores de createRng.
const COUNT_RANDOM = `(function () {
    const g = Math.random;
    globalThis.__rngCalls = 0;
    Math.random = function () { globalThis.__rngCalls++; return g(); };
})();`;
const COUNT_CREATE_RNG = `(function () {
    const create = SimRocas.createRng;
    SimRocas.createRng = function (seed) {
        const g = create(seed);
        return function () { globalThis.__rngCalls++; return g(); };
    };
})();`;

function engineContext(which, env = 'browser', extra = {}) {
    const ctx = createContext({ env, seed: SEED, extra });
    vm.runInContext(COUNT_RANDOM, ctx);
    if (env === 'browser') {
        for (const file of ENGINE_FILES) vm.runInContext(source(file, which), ctx, { filename: file });
        vm.runInContext(COUNT_CREATE_RNG, ctx);
    }
    return ctx;
}

const PROFILE = [
    { x: 0, y: 120 }, { x: 40, y: 100 }, { x: 80, y: 70 },
    { x: 120, y: 45 }, { x: 160, y: 25 }, { x: 200, y: 15 },
    { x: 260, y: 10 }, { x: 350, y: 8 }, { x: 450, y: 8 }
];
const COLLECTORS = [
    { id: 'c1', x: 60, label: 'Berma' },
    { id: 'c2', x: 150, label: 'Camino' },
    { id: 'c3', x: 230, label: 'Pie' }
];

// Rugosidad: todos los tramos con 12°, para que el rebote sortee.
function terrainJSON(rough) {
    const ctx = createContext({ env: 'browser' });
    vm.runInContext(source('js/terrain.js', 'base'), ctx);
    const t = new ctx.SimRocas.Terrain();
    t.setPoints(PROFILE.map(p => ({ ...p })));
    if (!rough) return t.toJSON();
    let touched = 0;
    const walk = node => {
        if (!node || typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
            if (key === 'roughness' && typeof node[key] === 'number') { node[key] = 12; touched++; }
            else walk(node[key]);
        }
    };
    const data = JSON.parse(t.toJSON());
    walk(data);
    assert.ok(touched > 0, 'precondición: el JSON del terreno lleva rugosidad por tramo');
    return JSON.stringify(data);
}

const SCENARIOS = {
    fragmentacion: { rough: false, seed: undefined, numRocks: 3, fragmentationEnabled: true, fractureEnergy: 12000 },
    rugosidad: { rough: true, seed: 20261113, numRocks: 8, fragmentationEnabled: false, fractureEnergy: 25000 }
};

function simParams(scenario, collectors) {
    const params = {
        numRocks: scenario.numRocks, gravity: 9.81, cn: 0.6, ct: 0.4, rollingFriction: 0.15,
        cnVariability: 10, ctVariability: 10, timeStep: 0.005, animationSpeed: 50,
        maxDuration: 30, ignoreResting: false,
        fragmentationEnabled: scenario.fragmentationEnabled,
        fractureEnergy: scenario.fractureEnergy, fractureDissipation: 0.4
    };
    if (scenario.seed !== undefined) params.seed = scenario.seed;
    if (collectors !== undefined) params.collectors = collectors;
    return params;
}
const START_ARGS = [10, 130, 0.8, 2700, 2, 30, 30, false, 'sphere', 0.6, 'freefall', null];

function primitives(physics) {
    const out = {};
    for (const key of Object.keys(physics)) {
        if (['number', 'string', 'boolean'].includes(typeof physics[key])) out[key] = physics[key];
    }
    return out;
}

// Todos los campos propios de la roca (también los privados). `strip` quita
// solo los dos campos nuevos de P1.3.
function dumpRocks(rocks, strip) {
    return JSON.stringify(rocks, (key, value) => {
        if (strip && (key === 'crossings' || key === 'crossingsDropped')) return undefined;
        if (value instanceof Set || Object.prototype.toString.call(value) === '[object Set]') return [...value];
        return value;
    });
}

const threadCache = new Map();
function runThread(which, name, collectors) {
    const cacheKey = JSON.stringify([which, name, collectors === undefined ? 'sin clave' : collectors]);
    if (!threadCache.has(cacheKey)) threadCache.set(cacheKey, runThreadOnce(which, name, collectors));
    return threadCache.get(cacheKey);
}

function runThreadOnce(which, name, collectors) {
    const scenario = SCENARIOS[name];
    const ctx = engineContext(which);
    const terrain = new ctx.SimRocas.Terrain();
    terrain.fromJSON(terrainJSON(scenario.rough));
    const physics = new ctx.SimRocas.PhysicsEngine();
    physics.calcMethod = 'rigid-body';
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    sim.configure(simParams(scenario, collectors));
    sim.barriers = [];
    const births = new Map();
    sim.start(...START_ARGS);
    let seen = 0;
    const note = () => { for (; seen < sim.rocks.length; seen++) births.set(sim.rocks[seen].id, sim.rocks[seen].x); };
    note();
    while (sim.isRunning) { sim.step(); note(); }
    return { rocks: sim.rocks, births, rngCalls: ctx.__rngCalls, physicsParams: primitives(physics) };
}

function runWorker(which, name, collectors, where = 'message') {
    const scenario = SCENARIOS[name];
    const msgs = [];
    let ctx;
    ctx = engineContext(which, 'worker', {
        postMessage: m => msgs.push(m),
        importScripts: (...files) => {
            for (const f of files) vm.runInContext(source('js/' + f, which), ctx, { filename: 'js/' + f });
            vm.runInContext(COUNT_CREATE_RNG, ctx);
        }
    });
    vm.runInContext(source('js/worker.js', which), ctx, { filename: 'js/worker.js' });
    const physicsCtx = engineContext(which);
    const physics = new physicsCtx.SimRocas.PhysicsEngine();
    physics.calcMethod = 'rigid-body';
    // Como la App: physicsParams sale del motor ya configurado.
    new physicsCtx.SimRocas.Simulation(new physicsCtx.SimRocas.Terrain(), physics).configure(simParams(scenario, undefined));
    const msg = {
        type: 'start', terrainJSON: terrainJSON(scenario.rough),
        simParams: simParams(scenario, where === 'simParams' ? collectors : undefined),
        physicsParams: primitives(physics), barriers: [], startArgs: START_ARGS
    };
    if (where === 'message' && collectors !== undefined) msg.collectors = collectors;
    let error = null;
    try { ctx.onmessage({ data: msg }); } catch (err) { error = err; }
    const complete = msgs.find(m => m.type === 'complete');
    return { complete, error, rngCalls: ctx.__rngCalls };
}

const stripSerialized = rocks => JSON.stringify(rocks.map(r => {
    const o = { ...r };
    delete o.crossings;
    delete o.crossingsDropped;
    return o;
}));

const CROSSING_KEYS = ['collector', 'x', 'y', 't', 'height', 'top', 'vx', 'vy', 'speed', 'omega',
    'energyTrans', 'energyRot', 'energy', 'mass', 'direction', 'ordinal', 'byCorrection'];

// --- Unidad: motor aislado ---------------------------------------------------

function flatTerrain(y = 0) {
    return {
        points: [{ x: -1000, y }, { x: 1000, y }],
        getHeightAt: () => y,
        getBounds: () => ({ minX: -1000, maxX: 1000, minY: y, maxY: y }),
        getSegmentPropertiesAt: (x, cn, ct) => ({ cn, ct, roughness: 0 }),
        getSegmentAt: () => ({ properties: { roughness: 0 } })
    };
}

function ballisticRock(ctx, engine) {
    const rock = engine.createRock(0, 1000, 0.8, 2700, 0, 0, 'sphere', 0.6);
    rock.vx = 7;
    rock.vy = 3;
    rock.angularVelocity = 1.5;
    return rock;
}

test('balístico sin contacto: el cruce coincide con la recurrencia discreta de Euler semi-implícito', () => {
    const ctx = engineContext('now');
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.cnVariability = 0;
    engine.ctVariability = 0;
    engine.fragmentationEnabled = false;
    const terrain = flatTerrain(0);
    const rock = ballisticRock(ctx, engine);
    const mass = rock.mass, inertia = rock.momentOfInertia, radius = rock.radius;
    const dt = 0.005, g = engine.gravity, xc = 5.0123;
    const collectors = [{ id: 'k', x: xc, label: 'K' }];

    // Recurrencia de referencia, con h variable por paso (subStepsFor).
    let x = 0, y = 1000, vy = 3, t = 0, expected = null;
    const vx = 7;
    for (let step = 0; step < 400 && !expected; step++) {
        const n = Math.min(64, Math.max(3, Math.ceil(dt * (Math.hypot(vx, vy) + g * dt) / 0.1)));
        const h = dt / n;
        for (let i = 0; i < n; i++) {
            const x0 = x, y0 = y, t0 = t;
            vy -= g * h;
            x += vx * h;
            y += vy * h;
            t = step * dt + (i + 1) * h;
            if (x0 < xc && x >= xc) {
                const f = (xc - x0) / (x - x0);
                expected = { y: y0 + f * (y - y0), t: t0 + f * h, vy };
                break;
            }
        }
    }
    assert.ok(expected, 'precondición: la referencia cruza');

    for (let step = 0; step < 400; step++) engine.simulateStep(rock, terrain, dt, [], collectors);
    assert.equal(rock.bounces, 0, 'precondición: sin contacto');
    assert.equal(rock.crossings.length, 1);
    assert.equal(rock.crossingsDropped, 0);
    const c = rock.crossings[0];
    assert.equal(Object.keys(c).join(), CROSSING_KEYS.join());
    assert.equal(c.collector, 'k');
    assert.equal(c.x, xc);
    assert.ok(Math.abs(c.y - expected.y) < 1e-9, `y ${c.y} vs ${expected.y}`);
    assert.ok(Math.abs(c.t - expected.t) < 1e-9, `t ${c.t} vs ${expected.t}`);
    assert.equal(c.vx, 7);
    assert.ok(Math.abs(c.vy - expected.vy) < 1e-9);
    assert.equal(c.speed, Math.hypot(c.vx, c.vy));
    assert.equal(c.omega, 1.5);
    assert.equal(c.height, c.y - 0);
    assert.equal(c.top, c.height + radius);
    const v = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
    assert.equal(c.energyTrans, 0.5 * mass * v * v);
    assert.equal(c.energyRot, 0.5 * inertia * 1.5 * 1.5);
    assert.equal(c.energy, c.energyTrans + c.energyRot);
    assert.equal(c.mass, mass);
    assert.equal(c.direction, 1);
    assert.equal(c.ordinal, 1);
    assert.equal(c.byCorrection, false);
    // Contra la parábola continua, con tolerancia O(h).
    const tc = xc / 7;
    assert.ok(Math.abs(c.t - tc) < 1e-9);
    assert.ok(Math.abs(c.y - (1000 + 3 * tc - 0.5 * g * tc * tc)) < 0.05);
});

test('sin colectores el motor no agrega campos; nacer del otro lado o sobre la línea no cruza', () => {
    const ctx = engineContext('now');
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.fragmentationEnabled = false;
    const terrain = flatTerrain(0);
    for (const list of [undefined, null, []]) {
        const rock = ballisticRock(ctx, engine);
        for (let step = 0; step < 50; step++) engine.simulateStep(rock, terrain, 0.005, [], list);
        assert.equal('crossings' in rock, false);
        assert.equal('crossingsDropped' in rock, false);
    }
    const rock = ballisticRock(ctx, engine);
    const collectors = [{ id: 'atras', x: -2, label: '' }, { id: 'encima', x: 0, label: '' }];
    for (let step = 0; step < 200; step++) engine.simulateStep(rock, terrain, 0.005, [], collectors);
    assert.ok(rock.x > 5);
    assert.equal(JSON.stringify(rock.crossings), '[]');
    assert.equal(rock.crossingsDropped, 0);
});

test('cruce por corrección de posición: byCorrection y ordinal por colector, con sentido', () => {
    const ctx = engineContext('now');
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.fragmentationEnabled = false;
    const terrain = flatTerrain(0);
    const rock = ballisticRock(ctx, engine);
    rock.vx = 0;
    const real = rock.handleCollision;
    let push = 0;
    // Doble del empuje de la colisión: mueve x fuera de update.
    rock.handleCollision = function (...args) {
        this.x += push;
        push = 0;
        return real.apply(this, args);
    };
    const collectors = [{ id: 7, x: 0.25, label: 'L' }];
    push = 0.5;
    engine.simulateStep(rock, terrain, 0.005, [], collectors);
    push = -0.5;
    engine.simulateStep(rock, terrain, 0.005, [], collectors);
    rock.vx = 60;
    engine.simulateStep(rock, terrain, 0.005, [], collectors);
    assert.equal(JSON.stringify(rock.crossings.map(c => [c.collector, c.direction, c.ordinal, c.byCorrection])),
        JSON.stringify([[7, 1, 1, true], [7, -1, 2, true], [7, 1, 3, false]]));
    for (const c of rock.crossings) {
        for (const key of CROSSING_KEYS) {
            if (key !== 'collector' && key !== 'byCorrection') assert.ok(Number.isFinite(c[key]), key);
        }
    }
});

test('tope de 64 cruces por roca y contador crossingsDropped', () => {
    const ctx = engineContext('now');
    const engine = new ctx.SimRocas.PhysicsEngine();
    engine.fragmentationEnabled = false;
    const rock = ballisticRock(ctx, engine);
    const collectors = Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, x: 0.5 + i * 0.05, label: '' }));
    for (let step = 0; step < 200; step++) engine.simulateStep(rock, flatTerrain(0), 0.005, [], collectors);
    assert.equal(rock.crossings.length, 64);
    assert.equal(rock.crossingsDropped, 6);
    assert.equal(rock.crossings.map(c => c.collector).join(), collectors.slice(0, 64).map(c => c.id).join());
});

test('configure valida los colectores, guarda copias y rechaza con Error en español', () => {
    const ctx = engineContext('now');
    const make = () => new ctx.SimRocas.Simulation(new ctx.SimRocas.Terrain(), new ctx.SimRocas.PhysicsEngine());
    const sim = make();
    assert.equal(JSON.stringify(sim.collectors), '[]');
    const input = [{ id: 'a', x: 10, label: 'Uno', extra: 1 }, { id: 2, x: -3.5 }];
    sim.configure({ numRocks: 7, collectors: input });
    assert.equal(JSON.stringify(sim.collectors), JSON.stringify([{ id: 'a', x: 10, label: 'Uno' }, { id: 2, x: -3.5, label: '' }]));
    assert.notEqual(sim.collectors[0], input[0]);
    const bad = [
        'x', {}, [null], [{ id: 'a', x: NaN }], [{ id: 'a', x: '3' }], [{ id: 'a', x: Infinity }],
        [{ id: 'a', x: 1 }, { id: 'a', x: 2 }], [{ id: '', x: 1 }], [{ x: 1 }], [{ id: {}, x: 1 }]
    ];
    for (const collectors of bad) {
        assert.throws(() => sim.configure({ numRocks: 99, collectors }), err => /colector/i.test(err.message),
            JSON.stringify(collectors));
        assert.equal(sim.totalRocks, 7, 'el rechazo no cambia la configuración');
        assert.equal(sim.collectors.length, 2);
    }
    sim.configure({ numRocks: 5 });
    assert.equal(JSON.stringify(sim.collectors), '[]', 'configure sin colectores los vacía');
});

// --- Pasividad e integración del motor --------------------------------------

for (const name of Object.keys(SCENARIOS)) {
    test(`pasividad byte a byte frente a ${BASE.slice(0, 8)} en el hilo (${name})`, () => {
        const base = runThread('base', name, undefined);
        const zero = runThread('now', name, []);
        const absent = runThread('now', name, undefined);
        const three = runThread('now', name, COLLECTORS);
        if (name === 'fragmentacion') assert.ok(base.rocks.some(r => r.generation > 0), 'precondición: hay fragmentos');
        assert.ok(base.rngCalls > 100);
        const expected = dumpRocks(base.rocks, false);
        assert.equal(dumpRocks(zero.rocks, false), expected, '0 colectores: sin quitar nada');
        assert.equal(dumpRocks(absent.rocks, false), expected, 'sin clave collectors');
        assert.equal(dumpRocks(three.rocks, true), expected, '3 colectores');
        assert.equal(zero.rngCalls, base.rngCalls);
        assert.equal(absent.rngCalls, base.rngCalls);
        assert.equal(three.rngCalls, base.rngCalls);
        const total = three.rocks.reduce((n, r) => n + r.crossings.length, 0);
        assert.ok(total >= 3, `precondición: hay cruces (${total})`);
        for (const r of three.rocks) {
            assert.ok(Array.isArray(r.crossings), 'toda pieza lleva crossings');
            assert.equal(r.crossingsDropped, 0);
        }
    });

    test(`pasividad byte a byte frente a ${BASE.slice(0, 8)} en el vm-Worker y paridad de cruces (${name})`, () => {
        const base = runWorker('base', name, undefined);
        const zero = runWorker('now', name, []);
        const absent = runWorker('now', name, undefined);
        const three = runWorker('now', name, COLLECTORS);
        const viaParams = runWorker('now', name, COLLECTORS, 'simParams');
        for (const run of [base, zero, absent, three, viaParams]) assert.equal(run.error, null);
        const expected = JSON.stringify(base.complete.rocks);
        assert.equal(JSON.stringify(zero.complete.rocks), expected, '0 colectores: no se serializan los campos');
        assert.equal(JSON.stringify(absent.complete.rocks), expected);
        assert.equal(stripSerialized(three.complete.rocks), expected);
        assert.equal(JSON.stringify(viaParams.complete.rocks), JSON.stringify(three.complete.rocks));
        for (const run of [zero, absent, three]) assert.equal(run.rngCalls, base.rngCalls);
        assert.equal('crossings' in zero.complete.rocks[0], false);
        assert.equal('crossingsDropped' in zero.complete.rocks[0], false);
        assert.equal(Object.keys(three.complete.rocks[0]).slice(-2).join(), 'crossings,crossingsDropped');

        // I-C: mismos cruces, mismos bytes, y copias propias.
        const thread = runThread('now', name, COLLECTORS);
        const pick = rocks => JSON.stringify(rocks.map(r => ({ id: r.id, crossings: r.crossings, crossingsDropped: r.crossingsDropped })));
        assert.equal(pick(three.complete.rocks), pick(thread.rocks));
        assert.ok(three.complete.rocks.some(r => r.crossings.length > 0));
        for (const r of three.complete.rocks) {
            for (const c of r.crossings) assert.equal(Object.keys(c).join(), CROSSING_KEYS.join());
        }
    });
}

test('una pieza nacida del otro lado de la línea no genera cruce propio', () => {
    const run = runThread('now', 'fragmentacion', COLLECTORS);
    let bornBeyond = 0;
    for (const rock of run.rocks) {
        const born = run.births.get(rock.id);
        for (const collector of COLLECTORS) {
            const own = rock.crossings.filter(c => c.collector === collector.id);
            assert.equal(own.map(c => c.ordinal).join(), own.map((_, i) => i + 1).join());
            // Los sentidos alternan y el primero sale del lado de nacimiento.
            own.forEach((c, i) => assert.equal(c.direction, (born < collector.x ? 1 : -1) * (i % 2 === 0 ? 1 : -1),
                `roca ${rock.id}, colector ${collector.id}, cruce ${i}`));
            if (rock.parentId !== null && rock.parentId !== undefined && born > collector.x) {
                bornBeyond++;
                assert.ok(own.every((c, i) => c.direction === (i % 2 === 0 ? -1 : 1)));
            }
        }
    }
    assert.ok(bornBeyond > 0, 'precondición: hay fragmentos nacidos más allá de un colector');
});

test('el Worker rechaza colectores inválidos con el mismo Error', () => {
    const run = runWorker('now', 'rugosidad', [{ id: 'a', x: 1 }, { id: 'a', x: 2 }]);
    assert.ok(run.error && /colector/i.test(run.error.message));
    assert.equal(run.complete, undefined);
});
