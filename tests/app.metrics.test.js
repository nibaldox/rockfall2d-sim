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
    assert.ok(msg); assert.equal(msg.status, 'completed');
    const rock = structuredClone(msg.rocks[0]);
    // Sin relleno: los campos β llegan tal como los publica serializeRocks de js/worker.js.
    return rock;
}
function setup() { const f = fixture(); f.app.stats = new f.Stats(); f.app.runSimulation(); return f; }
function complete(f, rocks, status = 'completed') { f.workers[0].onmessage({ data: { type: 'complete', status, rocks } }); }
function rest() { const r = payload(); r.stopReason = 'rest'; r.cullBoundary = null; return r; }

test('downhillMode se entrega a Simulation en hilo y worker', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser' });
    for (const mode of [false, true]) {
        const f = fixture(mode); const terrain = new ctx.SimRocas.Terrain(); terrain.setPoints([{ x: 0, y: 20 }, { x: 100, y: 0 }]);
        f.app.terrain = terrain; f.app.physics = new ctx.SimRocas.PhysicsEngine(); f.app.simulation = new ctx.SimRocas.Simulation(terrain, f.app.physics);
        delete f.app.getSimulationParams; f.element('downhill-mode').value = '-x'; f.app.releasePoint = { x: 10, y: 50 };
        f.app.runSimulation();
        assert.equal(f.app.simulation.downhillMode, '-x');
        if (mode) { const message = f.workers[0].message; assert.equal(message.simParams.downhillMode, '-x'); message.simParams.numRocks = 1; message.simParams.maxDuration = 0.005; message.startArgs[6] = 0.005; const sent = runWorker(message); assert.equal(sent.find(m => m.type === 'complete').rocks[0].downhillSign, -1); }
    }
});
test('barrera recibe roca worker real y rechaza cada campo α inválido', () => {
    const valid = rest(); const f = setup(); complete(f, [valid]); assert.equal(f.app._resultsValid, true); assert.equal(f.app.stats.results.status, 'completo'); assert.equal(f.element('btn-export-csv').disabled, false); assert.ok(f.app.renderer.probabilityPercentiles.bands.every(b => b.exact));
    const mutations = [r => r.releaseX = NaN, r => r.releaseY = Infinity, r => r.sourceIndex = -1, r => r.sourceIndex = 0.5, r => r.downhillSign = 0, r => r.maxDownhillAdvance = null, r => r.downhillSign = null, r => r.cullBoundary = 'bad', r => r.cullBoundary = 'maxX', r => delete r.releaseX, r => delete r.releaseY, r => delete r.sourceIndex, r => delete r.downhillSign, r => delete r.maxDownhillAdvance, r => delete r.cullBoundary];
    for (const mutate of mutations) { const x = setup(); const bad = rest(); mutate(bad); complete(x, [bad]); assert.equal(x.app._resultsValid, false); assert.match(x.element('simulation-status').textContent, /incompatible/); }
});
test('parcial con censura publica cotas, conteos y exportaciones', () => {
    const f = setup(); const a = rest(), b = rest(); b.id = 2; b.rootId = 2; b.stopReason = 'culled'; b.cullBoundary = 'maxX'; complete(f, [a, b]);
    assert.equal(f.app.stats.results.status, 'parcial'); assert.equal(f.app._resultsValid, true); assert.equal(f.element('btn-export-csv').disabled, false);
    assert.match(f.element('simulation-status').textContent, /culled: 1/); assert.match(f.element('simulation-status').textContent, /censur/i);
    const map = f.app.renderer.probabilityPercentiles; assert.equal(map.originX, 0); assert.equal(map.sign, 1); assert.equal(map.bands.length, 4); assert.equal(map.bands[3].exact, false);
    f.app.showResultsDashboard(); assert.match(f.element('dash-stat-p95').textContent, /≥/);
});
test('fragmentación bloquea; cancelled y safetyLimit invalidan', () => {
    for (const reason of ['fragmented', 'cancelled', 'safetyLimit']) { const f = setup(), r = rest(); r.stopReason = reason; const rocks = [r];
        // P0.4 E1.3: un `fragmented` publicado lleva al menos un hijo coherente (physics.js: `major` es núcleo y suma 1 generación).
        if (reason === 'fragmented') { const kid = rest(); kid.id = r.id + 1; kid.parentId = r.id; kid.rootId = r.rootId; kid.fragmentKind = 'major'; kid.isCore = true; kid.generation = 1; kid.bornAt = r.elapsedTime; kid.discardedMass = 0; rocks.push(kid); }
        complete(f, rocks); assert.equal(f.app._resultsValid, false); assert.equal(f.element('btn-export-csv').disabled, true); assert.match(f.element('simulation-status').textContent, new RegExp(reason === 'fragmented' ? 'fragmentaci' : reason, 'i')); }
});
test('mapa ausente para varias fuentes o dirección ambigua, dashboard null', () => {
    for (const multiple of [true, false]) { const f = setup(); const a = rest(), b = rest(); b.id = 2; b.rootId = 2; if (multiple) b.sourceIndex = 1; else { a.downhillSign = null; a.maxDownhillAdvance = null; b.downhillSign = null; b.maxDownhillAdvance = null; } complete(f, [a, b]); assert.equal(f.app._resultsValid, true); assert.equal(f.app.renderer.probabilityPercentiles, null); assert.match(f.element('simulation-status').textContent, /mapa/i); if (!multiple) { f.app.showResultsDashboard(); assert.equal(f.element('dash-stat-max-runout').textContent, '—'); assert.equal(f.element('dash-stat-p95').textContent, '—'); } }
});
test('contador se reinicia y progresa en worker', () => {
    const f = setup(); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 0'); f.workers[0].onmessage({ data: { type: 'progress', data: { progress: 0.5, simulatedCount: 3, totalRocks: 6 } } }); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 3'); f.app.stopSimulation(); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 0');
});

test('invalidar limpia los campos α y advertencias anteriores', () => {
    const f = setup(); const a = rest(), b = rest(); b.id = 2; b.rootId = 2; b.stopReason = 'culled'; b.cullBoundary = 'maxX'; complete(f, [a, b]);
    assert.notEqual(f.element('stat-n-rest').textContent, ''); assert.notEqual(f.element('stats-warnings').textContent, '');
    f.app._invalidateResults();
    for (const id of ['stat-n-rest', 'stat-pct-leaving', 'stat-reach-p95']) assert.equal(f.element(id).textContent, '—');
    assert.equal(f.element('stats-warnings').textContent, '');
});
test('histograma y dashboard reciben resultados reales de Stats', () => {
    const f = setup(), calls = []; f.app.renderer.renderHistogram = (...args) => calls.push(['hist', ...args]); f.app.renderer.renderResultsDashboard = (...args) => calls.push(['dash', ...args]);
    complete(f, [rest()]); assert.equal(calls[0][1], f.app.histogramCanvas); assert.equal(calls[0][2], f.app.stats.results);
    f.app.showResultsDashboard(); f.frames[0](); assert.equal(calls[1][1], f.app.stats.results); assert.equal(calls[1][2], f.app.terrain); assert.equal(calls[1].length, 3);
});
test('barrera α rechaza cada campo por el callback del hilo real', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser', seed: 1234 });
    const mutations = [r => {}, r => r.releaseX = NaN, r => r.releaseY = Infinity, r => r.sourceIndex = -1,
        r => r.downhillSign = 0, r => r.maxDownhillAdvance = null, r => r.cullBoundary = 'maxX'];
    for (const [index, mutate] of mutations.entries()) {
        const f = fixture(false); f.app.stats = new f.Stats(); const terrain = new ctx.SimRocas.Terrain(); terrain.setPoints([{ x: 0, y: 20 }, { x: 100, y: 0 }]);
        f.app.terrain = terrain; f.app.physics = new ctx.SimRocas.PhysicsEngine(); f.app.simulation = new ctx.SimRocas.Simulation(terrain, f.app.physics); f.app.releasePoint = { x: 10, y: 50 };
        f.app.getSimulationParams = () => ({ numRocks: 1, timeStep: 0.005, maxDuration: 0.005, animationSpeed: 1, downhillMode: '+x' }); f.app.runSimulation();
        const callback = f.app.simulation.onComplete; f.app.simulation.onComplete = () => {}; while (f.app.simulation.isRunning) f.app.simulation.step(); const r = f.app.simulation.rocks[0];
        mutate(r); callback([r]); assert.equal(f.app._resultsValid, index === 0);
    }
});
test('el contador del hilo refleja progreso y reset', () => {
    const f = fixture(false); f.app.runSimulation(); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 0');
    f.app.simulation.simulatedCount = 4; f.app.simulation.onUpdate({ progress: 0.5 }); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 4');
    f.app.resetSimulation(); assert.equal(f.element('rock-count-display').textContent, 'Rocas: 0');
});
test('mapa usa origen nominal de una fuente única multifuente', () => {
    const f = fixture(); f.app.stats = new f.Stats(); f.app.multiReleaseEnabled = true; f.app.multiReleasePoints = [{ x: 17, y: 30 }, { x: 58, y: 20 }]; f.app.runSimulation();
    const r = rest(); r.sourceIndex = 1; complete(f, [r]); assert.equal(f.app.renderer.probabilityPercentiles.originX, 58);
});

test('estado explica el motivo concreto de mapa no disponible', () => {
    for (const multiple of [true, false]) {
        const f = setup(), a = rest(), b = rest(); b.id = 2; b.rootId = 2;
        if (multiple) b.sourceIndex = 1; else { a.downhillSign = b.downhillSign = null; a.maxDownhillAdvance = b.maxDownhillAdvance = null; }
        complete(f, [a, b]); assert.match(f.element('simulation-status').textContent, multiple ? /mapa[^.]*varias fuentes/i : /mapa[^.]*sentido ambiguo/i);
    }
});

function runOriginFixture(worker, points = null) {
    const f = fixture(worker); f.app.stats = new f.Stats(); f.app.releasePoint = { x: 10, y: 130 };
    f.app.multiReleaseEnabled = points !== null; f.app.multiReleasePoints = points || [];
    const start = f.app.simulation.start; f.app.simulation.start = function (...args) { f.startArgs = args; return start.apply(this, args); };
    f.app.runSimulation(); return f;
}
function publishOrigin(f, worker, index = 0) {
    const r = rest(); r.sourceIndex = index;
    if (worker) complete(f, [r]);
    else { r.getShapeVertices = () => r.shape; f.app.simulation.onComplete([r]); }
}
for (const worker of [true, false]) {
    const mode = worker ? 'Worker' : 'hilo';
    test(`origen congelado fuente única durante edición en ${mode}`, () => {
        const f = runOriginFixture(worker);
        assert.equal(f.startArgs[0], 10);
        if (worker) assert.equal(f.workers[0].message.startArgs[0], 10);
        f.element('release-x').value = '50'; f.element('release-y').value = '130'; f.app.updateReleasePoint();
        assert.equal(f.app.releasePoint.x, 50); publishOrigin(f, worker);
        const map = f.app.renderer.probabilityPercentiles; assert.equal(map.originX, 10); assert.equal(map.sign, 1);
        assert.ok(map.bands.every(b => Number.isFinite(b.value) && b.exact));
    });
    test(`multifuente congelada y selección enviada en ${mode}`, () => {
        const points = [{ x: 17, y: -1 }, { x: 58, y: 20 }]; const f = runOriginFixture(worker, points);
        assert.equal(f.startArgs[11][1].x, 58); assert.equal(f.startArgs[11][0].y, 5);
        if (worker) { assert.equal(f.workers[0].message.startArgs[11][1].x, 58); assert.equal(f.workers[0].message.startArgs[11][0].y, 5); }
        points[1].x = 99; points.splice(0, 1); f.app.multiReleaseEnabled = false; f.app.multiReleasePoints = [{ x: 80, y: 30 }];
        publishOrigin(f, worker, 1); assert.equal(f.app.renderer.probabilityPercentiles.originX, 58);
    });
    test(`activar multifuente tarde no cambia origen en ${mode}`, () => {
        for (const initial of [null, []]) {
            const f = runOriginFixture(worker, initial); assert.equal(f.startArgs[11], null);
            f.app.multiReleaseEnabled = true; f.app.multiReleasePoints = [{ x: 90, y: 30 }];
            publishOrigin(f, worker); assert.equal(f.app.renderer.probabilityPercentiles.originX, 10);
        }
    });
    test(`índice fuera de rango no publica mapa en ${mode}`, () => {
        for (const points of [null, [{ x: 17, y: 30 }]]) {
            const f = runOriginFixture(worker, points); publishOrigin(f, worker, 1);
            assert.equal(f.app.renderer.probabilityPercentiles, null); assert.match(f.element('simulation-status').textContent, /origen nominal no disponible/i);
        }
    });
    test(`fuente no finita no publica mapa en ${mode}`, () => {
        const f = runOriginFixture(worker, [{ x: NaN, y: 30 }]); publishOrigin(f, worker);
        assert.equal(f.app.renderer.probabilityPercentiles, null); assert.match(f.element('simulation-status').textContent, /origen nominal no disponible/i);
    });
}
