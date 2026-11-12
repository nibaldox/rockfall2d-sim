'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { loadScripts } = require('./helpers/load');
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0].replace('postMessage() {}', 'postMessage(message) { this.message = message; }');
const { fixture } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture };')(createRequire(lifecycle), __dirname);
const parity = path.join(__dirname, 'worker.parity.test.js');
const workerSource = fs.readFileSync(parity, 'utf8').split('// --- Paridad (protocolo')[0];
const { runWorker, buildTerrainJSON } = new Function('require', '__dirname', workerSource + '\nreturn { runWorker, buildTerrainJSON };')(createRequire(parity), __dirname);

function payload() {
    const msg = runWorker({ type: 'start', terrainJSON: buildTerrainJSON(), simParams: { numRocks: 1, timeStep: 0.005, maxDuration: 0.005, downhillMode: '+x' }, physicsParams: {}, barriers: [], startArgs: [10, 130, 0.8, 2700, 2, 30, 0.005, true, 'sphere', 0.6, 'freefall', null] }).find(m => m.type === 'complete');
    assert.ok(msg);
    assert.equal(msg.status, 'completed');
    const rock = structuredClone(msg.rocks[0]);
    rock.stopReason = 'rest';
    rock.cullBoundary = null;
    return rock;
}

// Arranca la App con el motor simulado y los valores efectivos indicados.
function harness(worker, timeStep = 0.03, calcMethod = 'rigid-body') {
    const f = fixture(worker);
    f.app.stats = new f.Stats();
    f.app.simulation.physics = { dt: timeStep, calcMethod };
    f.app.runSimulation();
    return f;
}

function publish(f, worker, rocks) {
    if (worker) f.workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks } });
    else {
        rocks.forEach(r => { r.getShapeVertices = () => r.shape; });
        f.app.simulation.onComplete(rocks);
    }
}

function dtWarnings(results) {
    return results.warnings.filter(w => w.code === 'dtGrueso').length;
}

for (const worker of [true, false]) {
    const mode = worker ? 'Worker' : 'normal';

    test(`dt grueso publica advertencia, estado, CSV y reporte en ${mode}`, () => {
        const f = harness(worker);
        publish(f, worker, [payload()]);
        const results = f.app.stats.results;
        assert.equal(dtWarnings(results), 1);
        assert.equal(results.runInfo.timeStep, 0.03);
        assert.equal(results.runInfo.calcMethod, 'rigid-body');
        assert.match(f.element('simulation-status').textContent, /dt > 0\.02 s/);
        assert.match(f.element('stats-warnings').textContent, /dt > 0\.02 s/);
        const csv = f.app.stats.generateCSV();
        const report = f.app.stats.generateReport();
        assert.match(csv, /Advertencia dtGrueso/);
        assert.match(csv, /Paso de tiempo efectivo \(s\),0\.03/);
        assert.match(csv, /Método de cálculo,Cuerpo rígido/);
        assert.match(report, /Paso de tiempo efectivo \(s\): 0\.03/);
        assert.match(report, /Método de cálculo: Cuerpo rígido/);
    });

    test(`lumped-mass con dt grueso no advierte en ${mode}`, () => {
        const f = harness(worker, 0.03, 'lumped-mass');
        publish(f, worker, [payload()]);
        const results = f.app.stats.results;
        assert.equal(dtWarnings(results), 0);
        assert.equal(results.runInfo.calcMethod, 'lumped-mass');
        assert.doesNotMatch(f.element('simulation-status').textContent, /dt > 0\.02 s/);
    });

    test(`dt = 0.02 no advierte en ${mode}`, () => {
        const f = harness(worker, 0.02, 'rigid-body');
        publish(f, worker, [payload()]);
        const results = f.app.stats.results;
        assert.equal(dtWarnings(results), 0);
        assert.equal(results.runInfo.timeStep, 0.02);
    });

    test(`editar paso o método después de iniciar no altera la corrida en ${mode}`, () => {
        const f = harness(worker);
        f.element('time-step').value = '0.005';
        f.element('calc-method').value = 'lumped-mass';
        f.app.simulation.physics.dt = 0.005;
        f.app.simulation.physics.calcMethod = 'lumped-mass';
        publish(f, worker, [payload()]);
        const results = f.app.stats.results;
        assert.equal(dtWarnings(results), 1);
        assert.equal(results.runInfo.timeStep, 0.03);
        assert.equal(results.runInfo.calcMethod, 'rigid-body');
    });

    test(`callback de época vieja no publica corredores anteriores en ${mode}`, () => {
        const f = harness(worker);
        const stale = worker ? f.workers[0].onmessage : f.app.simulation.onComplete;
        f.app.stopSimulation();
        f.app.runSimulation();
        const current = f.app.stats.results;
        if (worker) stale({ data: { type: 'complete', status: 'completed', rocks: [payload()] } });
        else {
            const rock = payload();
            rock.getShapeVertices = () => rock.shape;
            stale([rock]);
        }
        assert.equal(f.app.stats.results, current);
        assert.equal(f.app._resultsValid, false);
    });

    test(`runInfo de otra época llega como null en ${mode}`, () => {
        const f = harness(worker);
        f.app._runInfo.epoch = f.app._runEpoch - 1;
        publish(f, worker, [payload()]);
        const results = f.app.stats.results;
        assert.equal(results.status, 'completo');
        assert.equal(results.runInfo.timeStep, null);
        assert.equal(results.runInfo.calcMethod, null);
        assert.equal(dtWarnings(results), 0);
    });
}

for (const worker of [true, false]) {
    const mode = worker ? 'Worker' : 'normal';
    test(`un cero válido de la UI llega al motor en ${mode}`, () => {
        const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser' });
        const f = fixture(worker);
        const terrain = new ctx.SimRocas.Terrain();
        terrain.setPoints([{ x: 0, y: 20 }, { x: 100, y: 0 }]);
        f.app.terrain = terrain;
        f.app.physics = new ctx.SimRocas.PhysicsEngine();
        f.app.simulation = new ctx.SimRocas.Simulation(terrain, f.app.physics);
        f.app.releasePoint = { x: 10, y: 50 };
        f.element('num-rocks').value = '1';
        f.element('cn-variability').value = '0';
        f.element('ct-variability').value = '0';
        delete f.app.getSimulationParams;
        f.app.runSimulation();
        assert.equal(f.app.simulation.physics.cnVariability, 0);
        assert.equal(f.app.simulation.physics.ctVariability, 0);
        if (worker) {
            assert.equal(f.workers[0].message.physicsParams.cnVariability, 0);
            assert.equal(f.workers[0].message.physicsParams.ctVariability, 0);
        }
    });
}
