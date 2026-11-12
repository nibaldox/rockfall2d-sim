'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function fixture(workerMode = true) {
    const elements = new Map();
    const drawing = { fillRect() {}, fillText() {}, clearRect() {} };
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            id, value: '', checked: id === 'use-worker' && workerMode, textContent: '', style: {}, disabled: false,
            classList: { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, contains(name) { return this.values.has(name); } },
            listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
            click() { if (this.listeners.click) this.listeners.click(); },
            getContext() { return drawing; }, querySelectorAll() { return []; }, width: 100, height: 100
        });
        return elements.get(id);
    }
    const document = { getElementById: element, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return element('tab'); }, createElement() { return element('created'); } };
    const workers = [];
    class Worker { constructor() { workers.push(this); } postMessage() {} terminate() { this.terminated = true; } }
    const frames = [];
    const confirmation = { value: true };
    const ctx = loadScripts(['js/stats.js', 'js/app.js', 'js/app-worker.js'], { extra: {
        SimRocas: {}, document, Worker, alert() {}, confirm() { return confirmation.value; },
        requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
        setTimeout(fn) { frames.push(fn); }, Blob: class {}, URL: { createObjectURL() {}, revokeObjectURL() {} }
    } });
    const app = Object.create(ctx.SimRocas.App.prototype);
    app.terrain = { points: [{}, {}], getHeightAt() { return 0; }, toJSON() { return {}; } };
    app.releasePoint = { x: 0, y: 10 }; app.releaseMode = 'freefall'; app.multiReleaseEnabled = false;
    app.physics = {};
    app.simulation = {
        physics: {}, rocks: [], finishedRocks: [], frames: [], get frameCount() { return this.frames.length; }, simulatedCount: 0, totalRocks: 1,
        configure() {}, start() { this.isRunning = true; this.rocks = [{ isResting: false }]; this.frames = []; },
        stop() { this.isRunning = false; this.rocks.forEach(r => { r.isResting = true; r.stopReason = 'cancelled'; }); },
        reset() { this.isRunning = false; this.rocks = []; this.frames = []; }, step() { this.steps = (this.steps || 0) + 1; }
    };
    app.stats = { results: { old: true }, calls: 0, compute() { this.calls++; this.results = { status: 'completo', population: { rest: 1, sources: [0], directionResolved: true }, reachBounds: null, warnings: [] }; }, updateUI() {}, generateCSV() { this.exports = (this.exports || 0) + 1; }, generateReport() { this.exports = (this.exports || 0) + 1; } };
    app.renderer = { probabilityPercentiles: { old: true }, renderHistogram() {}, render() {}, renderResultsDashboard() {} };
    app.histogramCanvas = element('histogram'); app.canvas = element('canvas');
    app.getSimulationParams = () => ({ maxDuration: 30 }); app.hideTimeline = () => {}; app.activateTimeline = () => {}; app.render = () => {}; app._doRender = () => {};
    app.setupSimulationControls(); app.setupExportControls(); app.setupDashboardControls();
    app._renderWorkerFrame = () => {};
    return { app, element, workers, frames, confirmation, Stats: ctx.SimRocas.Stats };
}
const rock = reason => ({ stopReason: reason, releaseX: 0, releaseY: 1, sourceIndex: 0, downhillSign: 1, maxDownhillAdvance: 1, cullBoundary: reason === 'culled' ? 'maxX' : null, isResting: true, x: 1, y: 0, finalX: 1, finalY: 0,
    stepsTaken: 1, elapsedTime: 1, rotation: 0, radius: 1, bounces: 1,
    maxKineticEnergy: 1000, maxBounceHeight: 2, maxImpactVelocity: 3,
    impactCount: 0, maxImpactNormalSpeed: null, maxImpactSpeed: null, maxImpactContactSpeed: null,
    maxImpactEnergy: null, maxFlightHeight: null, impactEvents: [], droppedImpactEvents: 0,
    impactEnergies: [], trajectory: [], bouncePoints: [], shape: [{ x: 0, y: 0 }],
    parentId: null, id: 1, rootId: 1, fragmentKind: 'primary', bornAt: 0, discardedMass: 0, color: { r: 1, g: 2, b: 3 },
    getShapeVertices() { return this.shape; },
    _colorActive: '#ffffff', _colorResting: '#ffffff', _colorStroke: '#ffffff' });

test('cancelar worker no publica rocas locales fantasma', () => {
    const { app } = fixture(); app.runSimulation(); app.stopSimulation();
    assert.equal(app.stats.calls, 0); assert.equal(app.simulation.rocks.length, 0);
});
test('iniciar invalida estadísticas y bloquea todos los accesos de exportación', () => {
    const { app, element } = fixture(); app.runSimulation();
    assert.equal(app.stats.results, null);
    for (const id of ['btn-export-csv', 'btn-export-report', 'btn-dashboard-csv', 'btn-dashboard-report']) element(id).click();
    assert.equal(app.stats.exports || 0, 0);
});
test('worker anterior no modifica corrida nueva con progress frame complete o error', () => {
    const { app, workers, element } = fixture(); app.runSimulation(); const old = workers[0]; app.stopSimulation(); app.runSimulation();
    const before = element('simulation-status').textContent;
    old.onmessage({ data: { type: 'progress', data: { progress: 1, simulatedCount: 9, totalRocks: 9 } } });
    old.onmessage({ data: { type: 'frame', frame: [rock('rest')] } });
    old.onmessage({ data: { type: 'complete', status: 'completed', rocks: [rock('rest')] } });
    old.onerror({});
    assert.equal(element('simulation-status').textContent, before); assert.equal(app.stats.calls, 0); assert.equal(app.simulation.frames.length, 0); assert.equal(app._workerActive, true);
});
test('censura publicable y seguridad conservan motivos', () => {
    for (const [status, reason] of [['completed', 'culled'], ['completed', 'maxTime'],
        ['completed', 'maxSteps'], ['completed', 'cancelled'], ['completed', 'safetyLimit'],
        ['safetyLimit', 'safetyLimit'], ['completed', undefined], [undefined, 'rest']]) {
        const { app, workers, element } = fixture(); app.runSimulation();
        workers[0].onmessage({ data: { type: 'complete', status, rocks: [rock(reason)] } });
        const publishable = status === 'completed' && ['culled', 'maxTime', 'maxSteps'].includes(reason);
        assert.equal(app.stats.calls, publishable ? 1 : 0); assert.equal(app.simulation.rocks[0].stopReason, reason);
        assert.match(element('simulation-status').textContent, publishable ? /culled|maxTime|maxSteps/ : /incomplet|censur|incompatible/i);
    }
});
test('final natural válido publica resultados', () => {
    const { app, workers } = fixture(); app.runSimulation(); workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [rock('rest')] } });
    assert.equal(app.stats.calls, 1);
});
test('un RAF de corrida normal anterior no avanza corrida nueva', () => {
    const { app, frames } = fixture(false); app.runSimulation(); const old = frames[0]; app.stopSimulation(); app.runSimulation();
    const before = app.simulation.steps; old(); assert.equal(app.simulation.steps, before);
});

test('protocolo sin lista de rocas o con lista vacía nunca publica agregados', () => {
    for (const rocks of [null, []]) {
        const { app, workers, element } = fixture();
        app.runSimulation();
        workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks } });
        assert.equal(app.stats.calls, 0);
        assert.match(element('simulation-status').textContent, /incompatible/i);
    }
});

test('cancelación normal conserva motivo sin agregados y callbacks previos se ignoran', () => {
    const { app, element } = fixture(false);
    app.runSimulation();
    const complete = app.simulation.onComplete;
    const update = app.simulation.onUpdate;
    app.stopSimulation();
    assert.equal(app.simulation.rocks[0].stopReason, 'cancelled');
    assert.match(element('simulation-status').textContent, /incompleta.*cancelled: 1/i);
    assert.equal(app.stats.calls, 0);
    app.runSimulation();
    const status = element('simulation-status').textContent;
    complete([rock('rest')]);
    update({ progress: 1 });
    assert.equal(app.stats.calls, 0);
    assert.equal(element('simulation-status').textContent, status);
});

test('fin normal censurado conserva roca y publica resultados', () => {
    const { app, element } = fixture(false);
    app.runSimulation();
    const rocks = [rock('maxSteps'), { ...rock('rest'), id: 2, rootId: 2 }];
    app.simulation.rocks = rocks;
    app.simulation.onComplete(rocks);
    assert.equal(app.stats.calls, 1);
    assert.match(element('simulation-status').textContent, /maxSteps: 1/);
    assert.equal(app.simulation.rocks[0].stopReason, 'maxSteps');
    app.showResultsTab();
    assert.equal(element('results-sidebar-content').style.display, 'block');
});

test('error worker elimina rocas y callbacks antiguos después de reiniciar', () => {
    const { app, workers, element } = fixture();
    app.runSimulation();
    const old = workers[0];
    old.onerror({});
    assert.equal(app.simulation.rocks.length, 0);
    assert.equal(app.stats.results, null);
    app.runSimulation();
    const status = element('simulation-status').textContent;
    old.onmessage({ data: { type: 'complete', status: 'completed', rocks: [rock('rest')] } });
    old.onerror({});
    assert.equal(element('simulation-status').textContent, status);
    assert.equal(app.stats.calls, 0);
});

test('reset durante corrida devuelve el botón flotante a estado inactivo', () => {
    const { workers, element } = fixture();
    element('btn-run').click();
    element('btn-reset').click();
    assert.equal(workers[0].terminated, true);
    assert.equal(element('fab-run').classList.contains('running'), false);
    assert.equal(element('fab-run').textContent, '▶');
});

test('error worker devuelve el botón flotante a estado inactivo', () => {
    const { app, workers, element } = fixture();
    element('btn-run').click();
    assert.equal(element('fab-run').classList.contains('running'), true);
    workers[0].onerror({});
    assert.equal(element('fab-run').classList.contains('running'), false);
    assert.equal(element('fab-run').textContent, '▶');
});

test('cancelación worker después de frame descarta frame y roca local', () => {
    const { app, workers, element } = fixture();
    element('btn-run').click();
    workers[0].onmessage({ data: { type: 'frame', frame: [rock('rest')] } });
    assert.equal(app.simulation.frames.length, 1);
    element('btn-stop').click();
    assert.equal(app.simulation.frames.length, 0);
    assert.equal(app.simulation.rocks.length, 0);
    assert.equal(app.stats.calls, 0);
});

test('reset invalida callbacks del worker anterior aunque arranque otro', () => {
    const { app, workers, element } = fixture();
    app.runSimulation();
    const old = workers[0];
    app.resetSimulation();
    app.runSimulation();
    const status = element('simulation-status').textContent;
    old.onmessage({ data: { type: 'progress', data: { progress: 1, simulatedCount: 1, totalRocks: 1 } } });
    old.onmessage({ data: { type: 'frame', frame: [rock('rest')] } });
    old.onmessage({ data: { type: 'complete', status: 'completed', rocks: [rock('rest')] } });
    assert.equal(app.stats.calls, 0);
    assert.equal(app.simulation.frames.length, 0);
    assert.equal(element('simulation-status').textContent, status);
});

test('dashboard programado antes de reiniciar no renderiza resultados obsoletos', () => {
    const { app, workers, frames, Stats } = fixture();
    app.stats = new Stats();
    const result = { ...rock('rest'), maxKineticEnergy: 1000, maxBounceHeight: 2,
        maxImpactVelocity: 3, bounces: 1, impactEnergies: [] };
    app.runSimulation();
    workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [result] } });
    let renders = 0;
    app.renderer.renderResultsDashboard = () => { renders++; };
    app.showResultsDashboard();
    const oldRender = frames[0];
    app.runSimulation();
    oldRender();
    assert.equal(renders, 0);
});

test('Stats real se publica en fin válido y se invalida al reiniciar', () => {
    const { app, workers, element, Stats } = fixture();
    app.stats = new Stats();
    app.runSimulation();
    const result = { ...rock('rest'), maxKineticEnergy: 1000, maxBounceHeight: 2,
        maxImpactVelocity: 3, bounces: 1, impactEnergies: [] };
    workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [result] } });
    assert.equal(app.stats.results.population.rest, 1);
    assert.equal(element('stat-max-ke').textContent, '1.0');
    assert.equal(element('btn-export-csv').disabled, false);
    assert.equal(element('results-sidebar-content').style.display, 'block');
    app.runSimulation();
    assert.equal(app.stats.results, null);
    assert.equal(element('stat-max-ke').textContent, '-');
    assert.equal(element('btn-export-csv').disabled, true);
    assert.equal(app.renderer.probabilityPercentiles, null);
});

test('rechazar el ajuste de liberación no interrumpe corrida anterior', () => {
    const { app, workers, confirmation } = fixture();
    app.runSimulation();
    app.terrain.getHeightAt = () => 8;
    confirmation.value = false;
    app.runSimulation();
    assert.equal(workers[0].terminated, undefined);
    assert.equal(app._workerActive, true);
});

test('una roca ausente en complete se trata como protocolo incompatible', () => {
    const { app, workers, element } = fixture();
    app.runSimulation();
    workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [null] } });
    assert.equal(app.stats.calls, 0);
    assert.match(element('simulation-status').textContent, /incompatible/i);
});


test('cancelación worker con Simulation real limpia estado y permite reiniciar', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser', seed: 1234 });
    const { app, workers, element } = fixture();
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    app.terrain = terrain; app.physics = new ctx.SimRocas.PhysicsEngine();
    app.simulation = new ctx.SimRocas.Simulation(terrain, app.physics);
    app.runSimulation();
    const old = workers[0];
    old.onmessage({ data: { type: 'frame', frame: [] } });
    app.stats.results = { old: true }; app.renderer.probabilityPercentiles = { old: true };
    app.stopSimulation();
    assert.equal(old.terminated, true); assert.equal(app.simulation.rocks.length, 0);
    assert.equal(app.simulation.finishedRocks.length, 0); assert.equal(app.simulation.frameCount, 0);
    assert.equal(app.stats.results, null); assert.equal(app.renderer.probabilityPercentiles, null);
    assert.equal(element('results-sidebar-content').style.display, 'none');
    assert.equal(element('results-dashboard').classList.contains('hidden'), true);
    assert.equal(element('btn-run').disabled, false); assert.equal(element('btn-stop').disabled, true);
    assert.equal(element('fab-run').textContent, '▶'); assert.match(element('simulation-status').textContent, /cancelada/);
    app.runSimulation(); const status = element('simulation-status').textContent;
    old.onmessage({ data: { type: 'complete', status: 'completed', rocks: [rock('rest')] } });
    old.onmessage({ data: { type: 'frame', frame: [] } }); old.onerror({});
    assert.equal(element('simulation-status').textContent, status); assert.equal(app.simulation.frameCount, 0);
    assert.equal(app._workerActive, true); assert.equal(workers.length, 2);
});

test('complete incompatible se rechaza antes de Stats y render en ambos modos', () => {
    const invalids = [r => { delete r.finalX; }, r => { r.x = NaN; }, r => { r.elapsedTime = Infinity; },
        r => { r.maxImpactVelocity = null; }, r => { r.bounces = '1'; }, r => { r.shape = null; },
        r => { r.trajectory = [0, 1]; }, r => { r.bouncePoints = [null]; }, r => { r.impactEnergies = [NaN]; }];
    for (const worker of [true, false]) for (const mutate of invalids) {
        const { app, workers, element, Stats } = fixture(worker);
        app.stats = new Stats(); app.runSimulation();
        const bad = rock('rest'); mutate(bad);
        if (worker) workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [bad] } });
        else { app.simulation.rocks = [bad]; app.simulation.onComplete([bad]); }
        assert.equal(app.stats.results, null); assert.equal(app._resultsValid, false);
        assert.equal(app.simulation.rocks.length, 0); assert.equal(element('btn-run').disabled, false);
        assert.equal(element('btn-stop').disabled, true); assert.equal(element('btn-export-csv').disabled, true);
        assert.match(element('simulation-status').textContent, /incompatible/i);
    }
});

test('complete real del worker se publica con Stats real y acepta cero y negativos', () => {
    const fs = require('node:fs'); const path = require('node:path'); const { createRequire } = require('node:module');
    const file = path.join(__dirname, 'worker.parity.test.js');
    const source = fs.readFileSync(file, 'utf8').split('// --- Paridad (protocolo')[0];
    const { runWorker, buildTerrainJSON } = new Function('require', '__dirname', source + '\nreturn {runWorker, buildTerrainJSON};')(createRequire(file), __dirname);
    const params = { numRocks: 1, animationSpeed: 1, timeStep: 0.005, maxDuration: 0.005, fragmentationEnabled: false };
    const message = structuredClone(runWorker({ type: 'start', terrainJSON: buildTerrainJSON(), simParams: params,
        physicsParams: {}, barriers: [], startArgs: [10, 130, 0.8, 2700, 2, 30, 0.005, true, 'sphere', 0.6, 'freefall', null] }).find(m => m.type === 'complete'));
    assert.ok(message); assert.equal(message.status, 'completed');
    const original = structuredClone(message);
    const raw = fixture(); raw.app.stats = new raw.Stats(); raw.app.runSimulation();
    raw.workers[0].onmessage({ data: original });
    assert.doesNotMatch(raw.element('simulation-status').textContent, /incompatible/i);
    if (['culled', 'maxTime', 'maxSteps'].includes(original.rocks[0].stopReason)) assert.equal(raw.app._resultsValid, true);
    // Solo el motivo se cambia sintéticamente: el resto es emitido por el worker real.
    message.rocks[0].stopReason = 'rest'; message.rocks[0].cullBoundary = null;
    const negative = structuredClone(message);
    const { app, workers, Stats } = fixture(); app.stats = new Stats(); app.runSimulation();
    workers[0].onmessage({ data: message }); assert.equal(app._resultsValid, true);
    const f = fixture(); f.app.stats = new f.Stats(); f.app.runSimulation(); negative.rocks[0].x = -1; negative.rocks[0].finalX = -1;
    negative.rocks[0].y = 0; negative.rocks[0].finalY = 0;
    f.workers[0].onmessage({ data: negative }); assert.equal(f.app._resultsValid, true);
});


for (const [name, mutate] of [['isResting falso', r => { r.isResting = false; }],
    ['shape dispersa', r => { r.shape = Array(2); }], ['trayectoria dispersa', r => { r.trajectory = Array(3); }],
    ['rebotes dispersos', r => { r.bouncePoints = Array(1); }], ['energías dispersas', r => { r.impactEnergies = Array(1); }]]) {
    test(`complete rechaza ${name} sin publicar`, () => {
        const { app, workers, element, Stats } = fixture(); app.stats = new Stats(); app.runSimulation();
        const bad = rock('rest'); mutate(bad);
        workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [bad] } });
        assert.equal(app._resultsValid, false); assert.equal(app.stats.results, null);
        assert.equal(app.simulation.rocks.length, 0); assert.match(element('simulation-status').textContent, /incompatible/);
    });
}

test('complete mixto conserva solo rocas seguras y renderer real no falla', () => {
    const { app, workers, element, Stats } = fixture(); app.stats = new Stats(); app.runSimulation();
    const good = rock('rest'); const bad = rock('rest'); bad.shape = [null];
    workers[0].onmessage({ data: { type: 'frame', frame: [] } });
    workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [good, bad] } });
    assert.equal(app._resultsValid, false); assert.equal(app.simulation.rocks.length, 1);
    assert.equal(app.simulation.rocks[0], good); assert.equal(app.simulation.frames.length, 0);
    assert.match(element('simulation-status').textContent, /incompatible/);
    const ctx = loadScripts(['js/renderer.js'], { extra: { SimRocas: {} } });
    const renderer = Object.create(ctx.SimRocas.Renderer.prototype);
    renderer.ctx = new Proxy({}, { get: () => () => {} });
    renderer.terrain = { scale: 1, offsetX: 0, offsetY: 0 }; renderer.canvas = { width: 100, height: 100 };
    assert.doesNotThrow(() => { renderer.drawRocks(app.simulation.rocks); renderer.drawTrajectories(app.simulation.rocks); renderer.drawBouncePoints(app.simulation.rocks); });
});


test('normal descarta roca sin método de dibujo al terminar', () => {
    const { app, element, Stats } = fixture(false); app.stats = new Stats(); app.runSimulation();
    const bad = rock('rest'); delete bad.getShapeVertices;
    app.simulation.rocks = [bad]; app.simulation.onComplete([bad]);
    assert.equal(app.stats.results, null); assert.equal(app.simulation.rocks.length, 0);
    assert.match(element('simulation-status').textContent, /incompatible/);
});

test('complete normal sin lista no deja datos peligrosos en el modelo', () => {
    const { app, element, Stats } = fixture(false); app.stats = new Stats(); app.runSimulation();
    app.simulation.rocks = [null]; app.simulation.frames = [[]]; app.simulation.onComplete(null);
    assert.equal(app.stats.results, null); assert.equal(app.simulation.rocks.length, 0);
    assert.equal(app.simulation.frames.length, 0); assert.match(element('simulation-status').textContent, /incompatible/);
});


test('finalización normal con motor real conserva censura compatible', () => {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser', seed: 1234 });
    const { app, element, Stats } = fixture(false); app.stats = new Stats();
    const terrain = new ctx.SimRocas.Terrain(); terrain.setPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    app.terrain = terrain; app.physics = new ctx.SimRocas.PhysicsEngine();
    app.simulation = new ctx.SimRocas.Simulation(terrain, app.physics);
    app.getSimulationParams = () => ({ numRocks: 1, timeStep: 0.005, maxDuration: 0.005, animationSpeed: 1, fragmentationEnabled: false });
    app.runSimulation();
    while (app.simulation.isRunning) app.simulation.step();
    assert.ok(app.simulation.rocks.length > 0);
    assert.doesNotMatch(element('simulation-status').textContent, /incompatible/i);
    assert.match(element('simulation-status').textContent, /parcial/i);
    assert.equal(app.stats.results.status, 'parcial');
});

test('campos numéricos incompatibles se rechazan en ambos caminos', () => {
    const names = ['x', 'y', 'finalX', 'finalY', 'rotation', 'radius', 'stepsTaken', 'elapsedTime',
        'bounces', 'maxKineticEnergy', 'maxBounceHeight', 'maxImpactVelocity'];
    for (const worker of [true, false]) for (const name of names) for (const value of [undefined, null, NaN, Infinity, '1']) {
        const { app, workers, element, Stats } = fixture(worker); app.stats = new Stats(); app.runSimulation();
        const bad = rock('rest'); bad[name] = value;
        if (worker) workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [bad] } });
        else { app.simulation.rocks = [bad]; app.simulation.onComplete([bad]); }
        assert.equal(app.stats.results, null, `${name}: ${String(value)}`);
        assert.equal(app.simulation.rocks.length, 0); assert.match(element('simulation-status').textContent, /incompatible/);
    }
});


test('sin frames seguros no se activa timeline vacía después de complete incompatible', () => {
    const { app, workers } = fixture(); let activations = 0;
    app.activateTimeline = () => { activations++; };
    app.runSimulation();
    workers[0].onmessage({ data: { type: 'frame', frame: [] } });
    const bad = rock('rest'); bad.shape = null;
    workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks: [bad] } });
    assert.equal(app.simulation.frameCount, 0); assert.equal(activations, 0);
});
