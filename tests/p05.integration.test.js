'use strict';
// P0.5 (I8): integración de punta a punta. App real -> motor real -> serialización
// (Worker) -> Stats real -> CSV, en ambos caminos, y cobertura del §5 del contrato
// (árbol con fragmentación en nonsmooth y con barrera).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { ROOT, loadScripts } = require('./helpers/load');

const alerts = [];
globalThis.__p05Alerts = alerts;
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0]
    .replace('postMessage() {}', 'postMessage(message) { this.message = message; }')
    .replace('alert() {}', 'alert(m) { globalThis.__p05Alerts.push(String(m)); }');
const { fixture } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture };')(createRequire(lifecycle), __dirname);
const parity = path.join(__dirname, 'worker.parity.test.js');
const workerSource = fs.readFileSync(parity, 'utf8').split('// --- Paridad (protocolo')[0];
const { runWorker } = new Function('require', '__dirname', workerSource + '\nreturn { runWorker };')(createRequire(parity), __dirname);

const PROFILE = [{ x: 0, y: 120 }, { x: 40, y: 100 }, { x: 80, y: 70 }, { x: 120, y: 45 },
    { x: 160, y: 25 }, { x: 200, y: 15 }, { x: 260, y: 10 }, { x: 350, y: 8 }, { x: 450, y: 8 }];

// App con el motor real (Terrain, PhysicsEngine y Simulation) y Stats espiado.
function realApp(worker, seedText, setup) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser' });
    const f = fixture(worker);
    f.global = f.app.runSimulation.constructor('return globalThis')();
    f.global.SimRocas.RNG_ALGORITHM = ctx.SimRocas.RNG_ALGORITHM;
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE.map(p => ({ ...p })));
    f.app.terrain = terrain;
    f.app.physics = new ctx.SimRocas.PhysicsEngine();
    f.app.simulation = new ctx.SimRocas.Simulation(terrain, f.app.physics);
    f.app.releasePoint = { x: 10, y: 130 };
    f.element('num-rocks').value = '3';
    f.element('max-duration').value = '5';
    f.element('rock-shape').value = 'polygon';
    f.element('sim-seed').value = seedText;
    delete f.app.getSimulationParams;
    f.app.stats.compute = function (rocks, releasePoint, info) {
        this.calls++;
        this.info = info;
        this.results = { status: 'completo', population: { rest: 1, sources: [0], directionResolved: true }, reachBounds: null, warnings: [] };
    };
    if (setup) setup(f);
    return f;
}

function print(rocks) {
    return JSON.stringify(rocks.map(r => [r.id, r.parentId, r.x, r.y, r.finalX, r.finalY, r.rotation, r.bounces,
        r.maxKineticEnergy, r.stepsTaken, r.color, r.shape, r.trajectory.length]));
}

// Ejecuta una corrida completa por el camino indicado y devuelve su huella.
function run(worker, seedText, setup) {
    const f = realApp(worker, seedText, setup);
    alerts.length = 0;
    f.app.runSimulation();
    assert.deepEqual(alerts, []);
    let rocks;
    if (worker) {
        assert.equal(f.workers.length, 1);
        f.message = f.workers[0].message;
        const done = runWorker(JSON.parse(JSON.stringify(f.message))).find(m => m.type === 'complete');
        assert.ok(done);
        rocks = done.rocks;
        f.workers[0].onmessage({ data: done });
    } else {
        let guard = 0;
        while (f.app.simulation.isRunning && guard++ < 200000) f.app.simulation.step();
        assert.equal(f.app.simulation.isRunning, false);
        rocks = f.app.simulation.rocks;
    }
    assert.ok(rocks.length >= 3);
    f.print = print(rocks);
    return f;
}

// --- 1. Reproducibilidad con semilla, de punta a punta -------------------------
const realStats = f => { f.app.stats = new f.Stats(); };
function chain(worker, seedText, correlated) {
    const f = run(worker, seedText, g => {
        realStats(g);
        if (correlated) g.app.physics.correlatedParams = true;
    });
    assert.equal(f.app._resultsValid, true, 'la App publica');
    const results = f.app.stats.results;
    assert.ok(results && results.status !== 'bloqueado', 'Stats real publica');
    return { f, results, json: JSON.stringify(results), csv: f.app.stats.generateCSV(),
        impacts: f.app.stats.generateImpactCSV() };
}
const row = (csv, label) => {
    const lines = csv.split('\n').filter(line => line.startsWith(label + ','));
    assert.equal(lines.length, 1, `fila única: ${label}`);
    return lines[0].split(',')[1];
};

test('misma semilla: resultados, CSV general y CSV de impactos idénticos en los tres cruces', () => {
    const n1 = chain(false, '20261112'), n2 = chain(false, '20261112');
    const w1 = chain(true, '20261112'), w2 = chain(true, '20261112');
    assert.ok(n1.results.impactEvents.length > 0, 'no vacuo: hay eventos de impacto');
    assert.ok(n1.impacts.trimEnd().split('\n').length > 1, 'no vacuo: el CSV de impactos tiene filas');
    for (const [label, a, b] of [['normal↔normal', n1, n2], ['Worker↔Worker', w1, w2], ['normal↔Worker', n1, w1]]) {
        assert.equal(a.f.print, b.f.print, `${label}: rocas`);
        assert.equal(a.json, b.json, `${label}: resultados de Stats`);
        assert.equal(a.csv, b.csv, `${label}: CSV general`);
        assert.equal(a.impacts, b.impacts, `${label}: CSV de impactos`);
    }
    for (const worker of [false, true]) {
        const other = chain(worker, '20261113');
        const base = worker ? w1 : n1;
        assert.notEqual(other.f.print, base.f.print, 'semilla distinta: otras rocas');
        assert.notEqual(other.csv, base.csv, 'semilla distinta: otro CSV general');
        assert.notEqual(other.impacts, base.impacts, 'semilla distinta: otro CSV de impactos');
    }
});

test('las filas X3 del CSV traen la semilla usada, también cuando se sortea', () => {
    for (const worker of [false, true]) {
        const typed = chain(worker, '4242');
        assert.equal(row(typed.csv, 'Semilla'), '4242');
        assert.equal(typed.results.runInfo.seed, 4242);
        assert.equal(row(typed.csv, 'Generador pseudoaleatorio'), 'mulberry32');
        assert.equal(row(typed.csv, 'Versión del motor'), '11');
        assert.equal(row(typed.csv, 'Parámetros correlacionados'), 'No');
        assert.equal(typed.results.runInfo.correlatedParams, false);
        assert.equal(row(typed.csv, 'Versión del contrato de resultados'), 'P0.5');
        const labels = typed.csv.split('\n').map(line => line.split(',')[0]);
        const at = labels.indexOf('Versión del contrato de resultados');
        assert.deepEqual(labels.slice(at + 1, at + 5),
            ['Semilla', 'Generador pseudoaleatorio', 'Versión del motor', 'Parámetros correlacionados']);
        assert.match(typed.f.app.stats.generateReport(), /^Semilla: 4242$/m);
        // Campo vacío: la semilla sorteada queda en el CSV y, escrita, reproduce la corrida.
        const drawn = chain(worker, '');
        const seed = drawn.results.runInfo.seed;
        assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 4294967295);
        assert.equal(row(drawn.csv, 'Semilla'), String(seed));
        const again = chain(worker, String(seed));
        assert.equal(again.csv, drawn.csv);
        assert.equal(again.impacts, drawn.impacts);
    }
});

test('con la correlación activa, el CSV dice «Sí» y runInfo.correlatedParams es true', () => {
    const out = [];
    for (const worker of [false, true]) {
        const on = chain(worker, '99', true);
        assert.equal(on.results.runInfo.correlatedParams, true);
        assert.equal(row(on.csv, 'Parámetros correlacionados'), 'Sí');
        assert.match(on.f.app.stats.generateReport(), /^Parámetros correlacionados: Sí$/m);
        if (worker) assert.equal(on.f.message.physicsParams.correlatedParams, true, 'el control viaja al Worker');
        out.push(on);
    }
    assert.equal(out[0].csv, out[1].csv, 'normal↔Worker con correlación');
    assert.equal(out[0].impacts, out[1].impacts);
});

// --- 2. Cobertura del §5: árbol con fragmentación en nonsmooth y con barrera ----
const SLOPE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
const BARRIER = [{ x1: 40, y1: 18, x2: 40, y2: 26, cn: 0.3, ct: 0.5, thickness: 0.2 }];

function fragmentRun(seed) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser' });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(SLOPE.map(p => ({ ...p })));
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    const params = { numRocks: 3, animationSpeed: 1, timeStep: 0.005, maxDuration: 30,
        fragmentationEnabled: true, fractureEnergy: 500, downhillMode: '+x', seed };
    const args = [10, 51, 0.5, 2700, 0, 0, 30, false, 'polygon', 1, 'freefall', null];
    sim.configure(params);
    physics.calcMethod = 'nonsmooth';
    sim.barriers = BARRIER.map(b => ({ ...b }));
    sim.start(...args);
    let guard = 0;
    while (sim.isRunning && guard++ < 400000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida normal termina');
    const complete = runWorker({ type: 'start', terrainJSON: terrain.toJSON(), simParams: params,
        physicsParams: { calcMethod: 'nonsmooth' }, barriers: BARRIER.map(b => ({ ...b })), startArgs: args })
        .find(m => m.type === 'complete');
    assert.ok(complete, 'el Worker real completa');
    return { terrain, physics, sim, rocks: sim.rocks.slice(), complete };
}

test('§5: fragmentación en nonsmooth con barrera conserva la masa, con id únicos y conjunto válido', () => {
    const r = fragmentRun(12345);
    for (const worker of [false, true]) {
        const label = worker ? 'Worker' : 'normal';
        const rocks = worker ? structuredClone(r.complete.rocks) : r.rocks;
        // No vacuo: si la configuración no fragmenta o no toca la barrera, el test falla.
        const parents = rocks.filter(x => x.stopReason === 'fragmented');
        assert.ok(parents.length > 0, `${label}: hubo fragmentación`);
        assert.ok(rocks.length > 3, `${label}: hay descendientes`);
        assert.ok(rocks.some(x => x.impactEvents.some(e => e.surface === 'barrier')), `${label}: la barrera recibe impactos`);
        assert.ok(rocks.every(x => x.calcMethod === undefined || x.calcMethod === 'nonsmooth'), label);
        const ids = rocks.map(x => x.id);
        assert.equal(new Set(ids).size, ids.length, `${label}: id únicos`);
        const byId = new Map(rocks.map(x => [x.id, x]));
        const kids = new Map();
        for (const x of rocks) {
            if (x.parentId === null) continue;
            assert.ok(byId.has(x.parentId), `${label}: parentId existente (${x.id})`);
            assert.equal(byId.get(x.parentId).stopReason, 'fragmented', `${label}: padre fragmentado (${x.id})`);
            kids.set(x.parentId, (kids.get(x.parentId) || []).concat(x));
        }
        const roots = rocks.filter(x => x.parentId === null);
        assert.equal(roots.length, 3, `${label}: primarias`);
        let reached = 0;
        for (const root of roots) {
            let leaves = 0, discarded = 0;
            const stack = [root];
            while (stack.length) {
                const x = stack.pop();
                reached++;
                assert.equal(x.rootId, root.id, `${label}: rootId de ${x.id}`);
                discarded += x.discardedMass;
                if (x.stopReason === 'fragmented') assert.ok((kids.get(x.id) || []).length > 0, `${label}: fragmentado con hijos`);
                else leaves += x.mass;
                stack.push(...(kids.get(x.id) || []));
            }
            const original = root.mass;
            assert.ok(Number.isFinite(original) && original > 0, `${label}: masa original`);
            assert.ok(Math.abs(leaves + discarded - original) / original <= 1e-9,
                `${label}: masa de ${root.id}: hojas ${leaves} + descartada ${discarded} != original ${original}`);
        }
        assert.equal(reached, rocks.length, `${label}: todas las entidades cuelgan de una primaria`);
        // Validación de conjunto de la App real, con el Stats real.
        const f = fixture(false);
        f.app.terrain = r.terrain;
        f.app.physics = r.physics;
        f.app.simulation = r.sim;
        f.app.releasePoint = { x: 10, y: 51 };
        f.app.stats = new f.Stats();
        f.app._completeRun(rocks, 'completed', worker);
        assert.equal(f.app._resultsValid, true, `${label}: conjunto aprobado`);
        assert.equal(f.app.simulation.rocks.length, rocks.length, `${label}: conjunto completo`);
        assert.doesNotMatch(f.element('simulation-status').textContent, /incompatible|bloquead/i, label);
        assert.equal(f.app.stats.results.blockedReason, null, label);
        assert.equal(f.app.stats.results.totalRocks, 3, `${label}: N = primarias`);
    }
    assert.equal(JSON.stringify(r.complete.rocks.map(x => [x.id, x.parentId, x.mass, x.finalX])),
        JSON.stringify(r.rocks.map(x => [x.id, x.parentId, x.mass, x.finalX])), 'normal↔Worker con semilla');
});
