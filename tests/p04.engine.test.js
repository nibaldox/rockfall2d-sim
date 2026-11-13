'use strict';

/**
 * Tests del motor P0.4 (WP1): `id` único por corrida, linaje (`parentId`,
 * `rootId`, `fragmentKind`, `bornAt`), `discardedMass`, reloj y
 * `maxDownhillAdvance` heredados y serialización en el Worker.
 *
 * Contrafactual: `js/physics.js` y `js/simulation.js` de P0.2-β (commit
 * 18e4a1c3) se cargan desde copias en exec/WP1/ para verificar I1–I3.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createContext, runScript } = require('./helpers/load');

const C = '/home/xodla/.hermes/profiles/rocxkfall/reports/rockfall-p0';
const BASE_PHYSICS = process.env.P02B_PHYSICS || path.join(C, 'exec', 'WP1', 'p02b-physics.js');
const BASE_SIMULATION = process.env.P02B_SIMULATION || path.join(C, 'exec', 'WP1', 'p02b-simulation.js');
const SEED = 12345;
const METHODS = ['rigid-body', 'lumped-mass', 'nonsmooth'];
const KINDS = ['primary', 'core', 'major', 'spall'];
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
const BARRIER = [{ x1: 40, y1: 18, x2: 40, y2: 26, cn: 0.3, ct: 0.5, thickness: 0.2 }];

// PRNG determinista con contador de llamadas (I2). Reinstalable por corrida.
function installRandom(ctx, seed) {
    vm.runInContext(`(function () {
        let a = ${seed} >>> 0;
        globalThis.__randomCalls = 0;
        Math.random = function () {
            globalThis.__randomCalls++;
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    })();`, ctx);
}

function makeCtx(baseline) {
    const ctx = createContext({ env: 'browser' });
    runScript(ctx, 'js/terrain.js');
    if (baseline) {
        vm.runInContext(fs.readFileSync(BASE_PHYSICS, 'utf8'), ctx, { filename: 'p02b-physics.js' });
        vm.runInContext(fs.readFileSync(BASE_SIMULATION, 'utf8'), ctx, { filename: 'p02b-simulation.js' });
    } else {
        runScript(ctx, 'js/physics.js');
        runScript(ctx, 'js/simulation.js');
    }
    return ctx;
}

function simParams(o) {
    return {
        numRocks: o.numRocks || 20, animationSpeed: 1, timeStep: 0.005,
        maxDuration: o.maxDuration || 30,
        fragmentationEnabled: !!o.fragmentation, fractureEnergy: o.fractureEnergy || 500
    };
}

function startArgs(o) {
    return [10, 51, 0.5, 2700, 0, 0, o.maxDuration || 30, false, 'polygon', 1, 'freefall', null];
}

function runIn(ctx, o) {
    installRandom(ctx, o.seed || SEED);
    const S = ctx.SimRocas;
    const terrain = new S.Terrain();
    terrain.setPoints(PROFILE);
    const physics = new S.PhysicsEngine();
    const sim = new S.Simulation(terrain, physics);
    sim.configure(simParams(o));
    if (o.maxSteps) sim.maxStepsPerRock = o.maxSteps;
    physics.calcMethod = o.calcMethod;
    sim.barriers = o.barrier ? BARRIER : [];
    sim.start(...startArgs(o));
    const primaries = sim.rocks.slice();
    const initialMass = new Map(primaries.map(r => [r.id, r.mass]));
    let it = 0;
    while (sim.isRunning && it++ < 400000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida debe terminar');
    return { sim, physics, rocks: sim.rocks, primaries, initialMass, randomCalls: ctx.__randomCalls, ctx };
}

const run = (o, baseline = false) => runIn(makeCtx(baseline), o);

const PHYS_FIELDS = ['x', 'y', 'vx', 'vy', 'angularVelocity', 'stopReason', 'bounces', 'mass',
    'finalX', 'finalY', 'rotation', 'generation', 'isCore', 'maxKineticEnergy', 'maxBounceHeight'];
const BETA_FIELDS = ['impactCount', 'maxImpactNormalSpeed', 'maxImpactSpeed', 'maxImpactContactSpeed',
    'maxImpactEnergy', 'maxFlightHeight', 'droppedImpactEvents'];
const CLOCK_FIELDS = ['elapsedTime', 'stepsTaken', 'maxDownhillAdvance'];

function sameBits(a, b, msg) {
    assert.ok(Object.is(a, b), `${msg}: ${a} !== ${b}`);
}

function compareRock(a, b, fields, label) {
    for (const f of fields) sameBits(a[f], b[f], `${label}.${f}`);
    assert.equal(a.trajectory.length, b.trajectory.length, `${label}: largo de trayectoria`);
    for (let k = 0; k < a.trajectory.length; k++) sameBits(a.trajectory[k], b.trajectory[k], `${label}.trajectory[${k}]`);
}

function byIdMap(rocks) {
    const m = new Map();
    for (const r of rocks) m.set(r.id, r);
    return m;
}

// --- I1 ---------------------------------------------------------------------

for (const calcMethod of METHODS) {
    for (const barrier of [false, true]) {
        test(`I1 sin fragmentación idéntico a P0.2-β: ${calcMethod}, barrera=${barrier}`, () => {
            const o = { calcMethod, barrier, fragmentation: false };
            const now = run(o);
            const old = run(o, true);
            assert.equal(now.rocks.length, old.rocks.length);
            assert.equal(now.randomCalls, old.randomCalls, 'mismos sorteos');
            for (let i = 0; i < now.rocks.length; i++) {
                const a = now.rocks[i];
                const b = old.rocks[i];
                compareRock(a, b, [...PHYS_FIELDS, ...BETA_FIELDS, ...CLOCK_FIELDS, 'id'], `roca[${i}]`);
                assert.deepEqual(JSON.parse(JSON.stringify(a.impactEvents)), JSON.parse(JSON.stringify(b.impactEvents)));
                assert.equal(a.parentId, null);
                assert.equal(a.rootId, a.id, 'primaria: rootId = id');
                assert.equal(a.fragmentKind, 'primary');
                assert.equal(a.bornAt, 0);
                assert.equal(a.discardedMass, 0);
            }
            if (barrier) {
                assert.ok(now.rocks.some(r => r.impactEvents.some(e => e.surface === 'barrier')),
                    'precondición: alguna roca toca la barrera');
            }
        });
    }
}

// --- I2 e I3 ----------------------------------------------------------------

for (const calcMethod of METHODS) {
    test(`I2/I3 con fragmentación a 500 J: sorteos y trayectorias como P0.2-β, ${calcMethod}`, () => {
        // maxDuration holgado: el reloj heredado no llega a cortar a nadie.
        const o = { calcMethod, fragmentation: true, fractureEnergy: 500, maxDuration: 300 };
        const now = run(o);
        const old = run(o, true);
        assert.ok(now.rocks.some(r => r.stopReason === 'fragmented'), 'precondición: hay fragmentación');
        assert.ok(now.rocks.every(r => r.stopReason !== 'maxTime' && r.stopReason !== 'maxSteps'),
            'precondición: el reloj heredado no corta');
        assert.equal(now.randomCalls, old.randomCalls, 'I2: misma cantidad de sorteos');
        assert.equal(now.rocks.length, old.rocks.length, 'mismo número de entidades');
        for (let i = 0; i < now.rocks.length; i++) {
            compareRock(now.rocks[i], old.rocks[i], [...PHYS_FIELDS, ...BETA_FIELDS], `entidad[${i}]`);
        }
        // Las primarias conservan además su reloj y su id.
        for (let i = 0; i < now.primaries.length; i++) {
            compareRock(now.rocks[i], old.rocks[i], ['elapsedTime', 'stepsTaken', 'id'], `primaria[${i}]`);
        }
    });
}

test('I2 con maxDuration corto: los sorteos de las primarias no cambian hasta su primer evento', () => {
    const o = { calcMethod: 'rigid-body', fragmentation: true, fractureEnergy: 500, maxDuration: 6 };
    const now = run(o);
    const old = run(o, true);
    for (let i = 0; i < now.primaries.length; i++) {
        compareRock(now.rocks[i], old.rocks[i], [...PHYS_FIELDS, ...BETA_FIELDS, ...CLOCK_FIELDS, 'id'], `primaria[${i}]`);
    }
});

// --- Unicidad y árbol -------------------------------------------------------

for (const calcMethod of ['rigid-body', 'lumped-mass']) {
    test(`unicidad y árbol a 500 J, ${calcMethod}`, () => {
        const { rocks, primaries, initialMass } = run({ calcMethod, fragmentation: true, fractureEnergy: 500 });
        const ids = new Set(rocks.map(r => r.id));
        assert.equal(ids.size, rocks.length, '0 id duplicados');
        assert.ok(rocks.some(r => r.fragmentKind === 'core'), 'precondición: hay núcleos de abrasión');
        assert.ok(rocks.some(r => r.fragmentKind === 'major'), 'precondición: hay principales de ruptura');
        const byId = byIdMap(rocks);
        const primaryIds = new Set(primaries.map(r => r.id));
        const leafMass = new Map();
        const discarded = new Map();
        for (const r of rocks) {
            assert.ok(Number.isInteger(r.id) && r.id >= 1);
            assert.ok(KINDS.includes(r.fragmentKind), `fragmentKind ${r.fragmentKind}`);
            assert.ok(Number.isFinite(r.discardedMass) && r.discardedMass >= 0);
            assert.ok(primaryIds.has(r.rootId), 'rootId es una primaria');
            if (r.fragmentKind === 'primary') {
                assert.equal(r.parentId, null);
                assert.equal(r.rootId, r.id);
                assert.equal(r.bornAt, 0);
                assert.equal(r.isCore, false);
                assert.equal(r.generation, 0);
            } else {
                const parent = byId.get(r.parentId);
                assert.ok(parent, `parentId ${r.parentId} existe`);
                assert.equal(parent.stopReason, 'fragmented');
                assert.equal(r.rootId, parent.rootId);
                assert.ok(parent.id < r.id, 'el padre se crea antes que el hijo');
                sameBits(r.bornAt, parent.elapsedTime, 'bornAt = elapsedTime del padre');
                assert.ok(r.elapsedTime >= r.bornAt && r.stepsTaken >= parent.stepsTaken, 'reloj heredado');
                if (r.downhillSign !== null) assert.ok(r.maxDownhillAdvance >= parent.maxDownhillAdvance, 'alcance heredado');
                if (r.fragmentKind === 'core') {
                    assert.equal(r.isCore, true);
                    assert.equal(r.generation, parent.generation);
                } else {
                    assert.equal(r.isCore, r.fragmentKind === 'major');
                    assert.equal(r.generation, parent.generation + 1);
                }
            }
            // Sin ciclos: se llega a la raíz en menos pasos que entidades.
            let cur = r;
            let hops = 0;
            while (cur.parentId !== null) {
                cur = byId.get(cur.parentId);
                assert.ok(cur && ++hops <= rocks.length, 'cadena de padres sin ciclos');
            }
            assert.equal(cur.id, r.rootId, 'la cadena termina en rootId');
            if (r.stopReason !== 'fragmented') {
                assert.equal(r.discardedMass, 0, 'solo descarta quien se fragmenta');
                leafMass.set(r.rootId, (leafMass.get(r.rootId) || 0) + r.mass);
            }
            discarded.set(r.rootId, (discarded.get(r.rootId) || 0) + r.discardedMass);
        }
        for (const [id, m0] of initialMass) {
            const total = (leafMass.get(id) || 0) + (discarded.get(id) || 0);
            assert.ok(Math.abs(total - m0) / m0 <= 1e-9, `árbol ${id}: masa ${total} vs ${m0}`);
        }
        if (calcMethod === 'rigid-body') {
            assert.ok(rocks.some(r => r.discardedMass > 0), 'precondición: algún evento descarta esquirlas');
        }
    });
}

// --- Reloj ------------------------------------------------------------------

test('herencia al nacer: reloj, alcance y linaje (abrasión y ruptura)', () => {
    for (const ratio of [1.2, 2.5, 4]) {
        const ctx = makeCtx(false);
        installRandom(ctx, 7);
        const engine = new ctx.SimRocas.PhysicsEngine();
        const grand = new ctx.SimRocas.Rock(0, 0, 0.8, 2700, 0, 0, 'sphere');
        const parent = new ctx.SimRocas.Rock(5, 1, 0.8, 2700, 0, 0, 'sphere');
        parent.vx = 3;
        parent.vy = 8;
        parent.parentId = grand.id;
        parent.rootId = grand.id;
        parent.elapsedTime = 1.235;
        parent._elapsedTimeCompensation = 1e-17;
        parent.stepsTaken = 247;
        parent.downhillSign = 1;
        parent.releaseX = 0;
        parent.maxDownhillAdvance = 42;
        const result = engine._fragmentRockProgressive(parent, { nx: 0, ny: 1 }, ratio);
        const pieces = result.core ? [...result.children, result.core] : result.children;
        assert.ok(pieces.length >= 2);
        const ids = new Set([grand.id, parent.id, ...pieces.map(p => p.id)]);
        assert.equal(ids.size, pieces.length + 2, `ratio ${ratio}: id únicos`);
        for (const p of pieces) {
            assert.equal(p.parentId, parent.id, `ratio ${ratio}: parentId = id del padre`);
            assert.equal(p.rootId, grand.id, `ratio ${ratio}: rootId de la raíz`);
            assert.equal(p.elapsedTime, 1.235);
            assert.equal(p._elapsedTimeCompensation, 1e-17);
            assert.equal(p.stepsTaken, 247);
            assert.equal(p.bornAt, 1.235);
            assert.equal(p.maxDownhillAdvance, 42);
            assert.equal(p.discardedMass, 0);
            assert.equal(p.impactCount, 0, 'los campos β se reinician');
        }
        if (result.core) assert.equal(result.core.fragmentKind, 'core');
        const kinds = result.children.map(p => p.fragmentKind);
        assert.ok(kinds.every(k => k === (ratio < 3 ? 'spall' : k === 'major' ? 'major' : 'spall')));
        if (ratio >= 3) assert.equal(kinds.filter(k => k === 'major').length, 2);
    }
});

test('reloj: con maxDuration corto ningún descendiente supera maxDuration desde la liberación', () => {
    const maxDuration = 6;
    const o = { calcMethod: 'rigid-body', fragmentation: true, fractureEnergy: 500, maxDuration };
    const { rocks, sim } = run(o);
    const old = run(o, true);
    const kids = rocks.filter(r => r.parentId !== null);
    assert.ok(kids.length > 0);
    assert.ok(old.rocks.some(r => r.generation > 0 && r.stopReason === 'maxTime'),
        'precondición: en P0.2-β algún hijo agota su presupuesto propio');
    for (const r of kids) {
        assert.ok(r.bornAt > 0 && r.elapsedTime >= r.bornAt, 'el reloj del hijo cuenta desde la liberación');
    }
    for (const r of rocks) {
        assert.ok(r.elapsedTime <= maxDuration + 1e-9, `elapsedTime ${r.elapsedTime}`);
        assert.ok(r.stepsTaken <= sim.maxStepsPerRock, `stepsTaken ${r.stepsTaken}`);
    }
    assert.ok(kids.some(r => r.stopReason === 'maxTime'), 'algún descendiente termina por maxTime');
});

// --- E1.2: nacimiento en el límite ------------------------------------------

test('E1.2: un hijo nacido con el reloj en maxDuration termina al nacer por maxTime, sin integrar', () => {
    for (const calcMethod of ['rigid-body', 'lumped-mass']) {
        const o = { calcMethod, fragmentation: true, fractureEnergy: 500, numRocks: 4 };
        const free = run(o);
        // Instantes exactos de rotura (reproductor de RVP04a): los tres primeros.
        const instants = [...new Set(free.rocks.filter(r => r.parentId !== null).map(r => r.bornAt))]
            .sort((x, y) => x - y).slice(0, 3);
        assert.ok(instants.length > 0, 'precondición: hay roturas');
        for (const maxDuration of instants) {
            const { rocks, sim } = run({ ...o, maxDuration });
            const byId = new Map(rocks.map(r => [r.id, r]));
            const label = `${calcMethod}, maxDuration ${maxDuration}`;
            // Un instante de rotura puede no caer en la malla de dt: una entidad puede cerrar
            // su último paso después del límite solo si lo empezó antes (regla previa de P0.2).
            for (const r of rocks) {
                assert.ok(r.elapsedTime <= maxDuration + 1e-9 || r.elapsedTime - sim.physics.dt < maxDuration - 1e-9,
                    `${label}: id ${r.id} integró un paso con el reloj agotado, elapsedTime ${r.elapsedTime}`);
                assert.ok(r.stepsTaken <= sim.maxStepsPerRock, `${label}: id ${r.id} stepsTaken ${r.stepsTaken}`);
            }
            const born = rocks.filter(r => r.parentId !== null && maxDuration - r.bornAt <= 1e-9);
            assert.ok(born.length > 0, `${label}: precondición, hay hijos nacidos en el límite`);
            for (const r of born) {
                const parent = byId.get(r.parentId);
                assert.equal(r.stopReason, 'maxTime', `${label}: id ${r.id}`);
                assert.equal(r.isResting, true, label);
                sameBits(r.elapsedTime, parent.elapsedTime, `${label}: reloj sin avanzar`);
                assert.equal(r.stepsTaken, parent.stepsTaken, `${label}: sin pasos propios`);
                sameBits(r.finalX, r.x, `${label}: finalX`);
                sameBits(r.finalY, r.y, `${label}: finalY`);
            }
            assert.equal(sim.activeRocks.length, 0, label);
            assert.equal(sim.finishedRocks.length, rocks.length, `${label}: todas terminadas una sola vez`);
            assert.equal(new Set(sim.finishedRocks).size, rocks.length, label);
        }
    }
});

test('E1.2: un hijo nacido con stepsTaken en maxSteps termina al nacer por maxSteps, sin integrar', () => {
    const o = { calcMethod: 'rigid-body', fragmentation: true, fractureEnergy: 500, numRocks: 4 };
    const free = run(o);
    const firstKid = free.rocks.filter(r => r.parentId !== null).sort((x, y) => x.bornAt - y.bornAt)[0];
    const maxSteps = free.rocks.find(r => r.id === firstKid.parentId).stepsTaken;
    const { rocks, sim } = run({ ...o, maxSteps });
    const byId = new Map(rocks.map(r => [r.id, r]));
    for (const r of rocks) assert.ok(r.stepsTaken <= maxSteps, `id ${r.id} stepsTaken ${r.stepsTaken} > ${maxSteps}`);
    const born = rocks.filter(r => r.parentId !== null && byId.get(r.parentId).stepsTaken >= maxSteps);
    assert.ok(born.length > 0, 'precondición: hay hijos nacidos en el límite de pasos');
    for (const r of born) {
        assert.equal(r.stopReason, 'maxSteps', `id ${r.id}`);
        assert.equal(r.stepsTaken, maxSteps);
        sameBits(r.elapsedTime, byId.get(r.parentId).elapsedTime, 'reloj sin avanzar');
    }
    assert.equal(sim.finishedRocks.length, rocks.length);
});

// --- Reinicio del contador y Worker ----------------------------------------

test('reinicio del contador: dos corridas seguidas asignan los mismos id', () => {
    const o = { calcMethod: 'rigid-body', fragmentation: true, fractureEnergy: 500 };
    const first = run(o);
    const firstIds = first.rocks.map(r => [r.id, r.parentId, r.rootId]);
    assert.equal(first.rocks[0].id, 1, 'la primera primaria tiene id 1');
    const second = runIn(first.ctx, o);
    assert.deepEqual(second.rocks.map(r => [r.id, r.parentId, r.rootId]), firstIds);
});

function runWorker(ctx, o, msgs) {
    installRandom(ctx, o.seed || SEED);
    msgs.length = 0;
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE);
    ctx.onmessage({
        data: {
            type: 'start', terrainJSON: terrain.toJSON(), simParams: simParams(o),
            physicsParams: { calcMethod: o.calcMethod }, barriers: [], startArgs: startArgs(o)
        }
    });
    const complete = msgs.find(m => m.type === 'complete');
    assert.ok(complete, 'mensaje complete');
    return complete.rocks;
}

test('Worker: serializeRocks real lleva el linaje y asigna los mismos id que el modo normal', () => {
    const o = { calcMethod: 'rigid-body', fragmentation: true, fractureEnergy: 500 };
    const main = run(o);
    const msgs = [];
    let ctx;
    ctx = createContext({
        env: 'worker',
        extra: {
            postMessage: m => msgs.push(m),
            importScripts: (...files) => files.forEach(f => runScript(ctx, 'js/' + f))
        }
    });
    runScript(ctx, 'js/worker.js');
    const LINEAGE = ['id', 'parentId', 'rootId', 'fragmentKind', 'bornAt', 'discardedMass',
        'generation', 'isCore', 'stopReason', 'elapsedTime', 'stepsTaken', 'maxDownhillAdvance', 'finalX'];
    for (const pass of [1, 2]) {
        const rocks = runWorker(ctx, o, msgs);
        assert.equal(rocks.length, main.rocks.length, `pasada ${pass}: mismo número de entidades`);
        for (let i = 0; i < rocks.length; i++) {
            for (const f of LINEAGE) {
                assert.ok(Object.hasOwn(rocks[i], f), `pasada ${pass}: falta ${f}`);
                sameBits(rocks[i][f], main.rocks[i][f], `pasada ${pass} roca[${i}].${f}`);
            }
        }
    }
});
