'use strict';
// P0.5 (W5b): campo «Semilla» de la App 2D, paso al motor en modo normal y
// Worker, campos nuevos de runInfo y versionado. Usa el motor real.
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

for (const worker of [false, true]) {
    const mode = worker ? 'Worker' : 'normal';

    test(`la misma semilla escrita reproduce runInfo.seed y resultados en ${mode}`, () => {
        const a = run(worker, '12345');
        const b = run(worker, ' 12345 ');
        const c = run(worker, '54321');
        assert.equal(a.app._runInfo.seed, 12345);
        assert.equal(b.app._runInfo.seed, 12345);
        assert.equal(a.app.stats.info.seed, 12345);
        assert.equal(a.app.simulation.seed, 12345);
        if (worker) assert.equal(a.message.simParams.seed, 12345);
        assert.equal(a.print, b.print);
        assert.notEqual(a.print, c.print);
        assert.equal(a.element('sim-seed').value, '12345');
        assert.match(a.element('seed-used').textContent, /usada: 12345/);
    });

    test(`campo vacío: la semilla resuelta queda registrada y repetirla reproduce en ${mode}`, () => {
        const a = run(worker, '');
        const seed = a.app._runInfo.seed;
        assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 4294967295);
        assert.equal(a.app.stats.info.seed, seed);
        assert.equal(a.element('sim-seed').value, '');
        assert.equal(a.element('sim-seed').placeholder, `usada: ${seed}`);
        assert.match(a.element('seed-used').textContent, new RegExp(`usada: ${seed}\\b`));
        if (worker) assert.equal(a.message.simParams.seed, seed);
        const b = run(worker, String(seed));
        assert.equal(b.app._runInfo.seed, seed);
        assert.equal(a.print, b.print);
    });

    test(`semilla inválida: alert en español y la corrida no arranca en ${mode}`, () => {
        for (const bad of ['-1', '1.5', 'abc', '4294967296', '1e3', '0x10', '12 3']) {
            const f = realApp(worker, bad);
            let started = 0;
            const start = f.app.simulation.start;
            f.app.simulation.start = function (...args) { started++; return start.apply(this, args); };
            alerts.length = 0;
            f.app.runSimulation();
            assert.equal(alerts.length, 1, bad);
            assert.match(alerts[0], /Semilla inválida/);
            assert.match(alerts[0], /entero entre 0 y 4294967295/);
            assert.equal(started, 0, bad);
            assert.equal(f.workers.length, 0, bad);
            assert.equal(f.app._runEpoch || 0, 0, bad);
            assert.equal(f.app._runInfo, undefined, bad);
            assert.equal(f.element('sim-seed').value, bad);
            assert.deepEqual(f.app.stats.results, { old: true });
        }
    });

    test(`los límites 0 y 2^32-1 son semillas válidas en ${mode}`, () => {
        for (const ok of ['0', '4294967295']) {
            const f = realApp(worker, ok);
            alerts.length = 0;
            f.app.runSimulation();
            assert.deepEqual(alerts, []);
            assert.equal(f.app._runInfo.seed, Number(ok));
        }
    });

    test(`runInfo trae seed, rngAlgorithm, engineVersion y correlatedParams en ${mode}`, () => {
        const a = run(worker, '7');
        const b = run(worker, '7', f => { f.app.physics.correlatedParams = true; });
        for (const info of [a.app._runInfo, a.app.stats.info]) {
            assert.equal(info.seed, 7);
            assert.equal(info.rngAlgorithm, 'mulberry32');
            assert.equal(info.engineVersion, 12); // P1.1: WORKER_VERSION 11→12
            assert.equal(info.correlatedParams, false);
            assert.equal(typeof info.timeStep, 'number');
        }
        assert.equal(b.app._runInfo.correlatedParams, true);
        assert.equal(b.app.stats.info.correlatedParams, true);
        assert.equal(a.app._runInfo.epoch, a.app._runEpoch);
    });

    test(`cada corrida con campo vacío sortea una semilla nueva con crypto en ${mode}`, () => {
        const f = realApp(worker, '');
        const draws = [111, 222];
        f.global.crypto = { getRandomValues(a) { a[0] = draws.shift(); return a; } };
        f.global.Math.random = () => { throw new Error('no debe usarse Math.random'); };
        f.app.runSimulation();
        assert.equal(f.app._runInfo.seed, 111);
        if (worker) f.workers[0].onmessage({ data: { type: 'progress', data: { progress: 0.5, simulatedCount: 1, totalRocks: 3 } } });
        assert.match(f.element('simulation-status').textContent, /semilla 111$/);
        f.app.stopSimulation();
        f.app.runSimulation();
        assert.equal(f.app._runInfo.seed, 222);
        assert.equal(f.app.simulation.seed, 222);
    });
}

test('I3 del producto: misma semilla, mismos resultados entre normal y Worker', () => {
    const normal = run(false, '2024');
    const worker = run(true, '2024');
    assert.equal(normal.app._runInfo.seed, worker.app._runInfo.seed);
    assert.equal(normal.print, worker.print);
});

test('sin crypto, el respaldo usa Math.random y da un entero de 32 bits', () => {
    const f = realApp(false, '');
    f.global.Math.random = () => 0.5;
    f.app.runSimulation();
    assert.equal(f.app._runInfo.seed, 2147483648);
});

test('runInfo de otra época no publica la semilla', () => {
    const f = realApp(true, '9');
    f.app.runSimulation();
    f.app._runInfo.epoch = f.app._runEpoch - 1;
    const done = runWorker(JSON.parse(JSON.stringify(f.workers[0].message))).find(m => m.type === 'complete');
    f.workers[0].onmessage({ data: done });
    assert.equal(f.app.stats.calls, 1);
    assert.equal(f.app.stats.info, null);
});

test('versionado P0.5 y campo «Semilla» en index.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const versions = Object.fromEntries([...html.matchAll(/js\/([\w-]+)\.js\?v=(\d+)/g)].map(m => [m[1], Number(m[2])]));
    assert.deepEqual({ physics: versions.physics, simulation: versions.simulation, stats: versions.stats,
        app: versions.app, 'app-worker': versions['app-worker'] },
    { physics: 14, simulation: 13, stats: 11, app: 19, 'app-worker': 11 }); // P1.1: app 18→19 y app-worker 10→11 (WORKER_VERSION 12)
    assert.deepEqual({ terrain: versions.terrain, renderer: versions.renderer, stl: versions.stl,
        'app-stl': versions['app-stl'], 'app-modes': versions['app-modes'], 'app-import': versions['app-import'] },
    { terrain: 9, renderer: 7, stl: 7, 'app-stl': 3, 'app-modes': 2, 'app-import': 4 }); // P1.1: terrain 8→9 y app-stl 2→3
    assert.match(fs.readFileSync(path.join(ROOT, 'js/app-worker.js'), 'utf8'), /^const WORKER_VERSION = 12;$/m); // P1.1: el Worker carga terrain.js con su ?v=
    assert.match(html, /<label[^>]*>Semilla:<\/label>\s*<input type="text" id="sim-seed"/);
    assert.match(html, /id="seed-used"[^>]*>Vacía = aleatoria; se muestra la usada</);
});
