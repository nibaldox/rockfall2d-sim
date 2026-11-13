'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { loadScripts } = require('./helpers/load');
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0]
    .replace('postMessage() {}', 'postMessage(message) { this.message = message; }');
const { fixture, rock } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture, rock };')(createRequire(lifecycle), __dirname);

const ROOT = path.join(__dirname, '..');
const realPresets = loadScripts(['js/terrain.js'], { env: 'browser' }).SimRocas.TerrainPresets;
const indexPath = path.join(ROOT, 'index.html');

// Stats falso con la firma del §3 (WB2 implementa el real en paralelo).
class FakeStats {
    constructor(impactAvailable = true) {
        this.results = null;
        this.runs = [];
        this.impactAvailable = impactAvailable;
    }
    compute(rocks, releasePoint, runInfo) {
        this.runs.push(runInfo);
        this.results = {
            status: 'completo',
            population: { rest: rocks.length, sources: [0], directionResolved: true },
            reachBounds: null, warnings: [], runInfo,
            impactExportAvailable: this.impactAvailable,
            kineticEnergy: { max: 100 }, flightHeight: { max: 7 },
            impactNormalSpeed: { max: 5 }, impactEnergy: { max: 3 }, impactCount: { max: 4 }
        };
    }
    updateUI() {}
    generateCSV() { return 'Parámetro,Valor'; }
    generateReport() { return 'REPORTE'; }
    generateImpactCSV() {
        this.impactCalls = (this.impactCalls || 0) + 1;
        return this.results && this.results.impactExportAvailable ? 'Roca,Motivo de término\n1,rest' : null;
    }
}

function terrainStub() {
    return {
        points: [{ x: 0, y: 30 }, { x: 100, y: 10 }, { x: 200, y: 0 }],
        segments: [{ type: 'roca-dura', cn: 0.8, ct: 0.2, roughness: 2 },
            { type: 'suelo', cn: 0.4, ct: 0.4, roughness: 5 }],
        scale: 2, getHeightAt() { return 0; }, toJSON() { return '{"points":[]}'; }
    };
}

function setup(worker, impactAvailable = true) {
    const f = fixture(worker);
    // El fixture carga solo stats/app/app-worker: se le dan los presets reales.
    f.Stats.constructor('return SimRocas')().TerrainPresets = realPresets;
    f.app.stats = new FakeStats(impactAvailable);
    f.app.simulation.physics = { dt: 0.005, calcMethod: 'rigid-body', cnVariability: 10, ctVariability: 10 };
    f.app.terrain = terrainStub();
    f.app.runSimulation();
    return f;
}

function publish(f, worker, rocks) {
    if (worker) f.workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks } });
    else f.app.simulation.onComplete(rocks);
}

// Roca que cumple el §2 completo.
function beta(overrides = {}) {
    return {
        ...rock('rest'),
        impactCount: 2,
        maxImpactNormalSpeed: 4.5,
        maxImpactSpeed: 5,
        maxImpactContactSpeed: 6,
        maxImpactEnergy: 1200,
        maxFlightHeight: 3.2,
        impactEvents: [
            { t: 0.5, x: 10, y: 1, surface: 'terrain', index: 1, vn: 4, speed: 5, contactSpeed: 6, energy: 1200, cnEff: 0.8, ctEff: 0.2, flightHeightBefore: 3.2 },
            { t: 0.8, x: 20, y: 1, surface: 'barrier', index: 0, vn: 2, speed: 3, contactSpeed: null, energy: 500, cnEff: 0.6, ctEff: 0.4, flightHeightBefore: null }
        ],
        droppedImpactEvents: 0,
        ...overrides
    };
}

function rejected(worker, mutate, label) {
    const f = setup(worker);
    const bad = beta();
    mutate(bad);
    publish(f, worker, [bad]);
    assert.equal(f.app._resultsValid, false, label);
    assert.match(f.element('simulation-status').textContent, /incompatible/, label);
    assert.equal(f.element('btn-export-impacts').disabled, true, label);
}

const eventKey = key => e => { delete e[key]; };
const setKey = (key, value) => e => { e[key] = value; };

for (const worker of [true, false]) {
    const mode = worker ? 'Worker' : 'normal';

    test(`barrera β acepta una roca válida y rechaza cada variante en ${mode}`, () => {
        const f = setup(worker);
        publish(f, worker, [beta()]);
        assert.equal(f.app._resultsValid, true);
        assert.equal(f.app.stats.results.status, 'completo');
        assert.equal(f.element('btn-export-impacts').disabled, false);

        const cases = [
            ['impactCount ausente', r => delete r.impactCount],
            ['impactCount tipo inválido', r => r.impactCount = '2'],
            ['impactCount no entero', r => r.impactCount = 1.5],
            ['maxImpactNormalSpeed ausente', r => delete r.maxImpactNormalSpeed],
            ['maxImpactNormalSpeed tipo inválido', r => r.maxImpactNormalSpeed = 'x'],
            ['maxImpactSpeed negativo', r => r.maxImpactSpeed = -1],
            ['maxImpactContactSpeed ausente', r => delete r.maxImpactContactSpeed],
            ['maxImpactEnergy tipo inválido', r => r.maxImpactEnergy = {}],
            ['maxFlightHeight tipo inválido', r => r.maxFlightHeight = '3'],
            ['impactEvents ausente', r => delete r.impactEvents],
            ['impactEvents no arreglo', r => r.impactEvents = {}],
            ['evento con clave extra', r => r.impactEvents[0].extra = 1],
            ['evento con clave faltante', r => eventKey('cnEff')(r.impactEvents[1])],
            ['evento sin flightHeightBefore', r => eventKey('flightHeightBefore')(r.impactEvents[0])],
            ['surface inválida', r => r.impactEvents[0].surface = 'aire'],
            ['index no entero', r => r.impactEvents[1].index = 0.5],
            ['index negativo', r => r.impactEvents[0].index = -1],
            ['vn infinita', r => r.impactEvents[0].vn = Infinity],
            ['contactSpeed inválida', r => r.impactEvents[1].contactSpeed = 'x'],
            ['201 eventos', r => { r.impactEvents = Array.from({ length: 201 }, () => beta().impactEvents[0]); r.impactCount = 201; }],
            ['droppedImpactEvents incoherente', r => r.droppedImpactEvents = 3],
            ['droppedImpactEvents ausente', r => delete r.droppedImpactEvents],
            ['droppedImpactEvents no entero', r => r.droppedImpactEvents = 0.5]
        ];
        for (const [label, mutate] of cases) rejected(worker, mutate, label);
    });

    // RVBb-2: un test por campo; ningún valor negativo pasa la barrera.
    for (const key of ['vn', 'speed', 'contactSpeed', 'energy']) {
        test(`barrera β rechaza ${key} negativo en un evento en ${mode}`, () => {
            const f = setup(worker);
            publish(f, worker, [beta({ impactEvents: beta().impactEvents.map((e, i) => (i === 0 ? { ...e, [key]: 0 } : e)) })]);
            assert.equal(f.app._resultsValid, true, 'cero se acepta');
            rejected(worker, r => { r.impactEvents[0][key] = -1; }, `${key} = -1`);
            rejected(worker, r => { r.impactEvents[0][key] = -1e-9; }, `${key} = -1e-9`);
        });
    }
    for (const key of ['maxImpactNormalSpeed', 'maxImpactSpeed', 'maxImpactContactSpeed', 'maxImpactEnergy']) {
        test(`barrera β rechaza ${key} negativo en ${mode}`, () => {
            const f = setup(worker);
            publish(f, worker, [beta({ [key]: 0 })]);
            assert.equal(f.app._resultsValid, true, 'cero se acepta');
            rejected(worker, r => { r[key] = -1; }, `${key} = -1`);
            rejected(worker, r => { r[key] = -1e-9; }, `${key} = -1e-9`);
        });
    }

    test(`runInfo captura variabilidades y tramos como copias en ${mode}`, () => {
        const f = setup(worker);
        const segments = f.app._runInfo.segments;
        f.app.terrain.segments[0].cn = 0.99;
        f.app.terrain.points[0].x = -50;
        f.app.simulation.physics.cnVariability = 49;
        f.app.simulation.physics.ctVariability = 49;
        publish(f, worker, [beta()]);
        const info = f.app.stats.runs[0];
        assert.equal(info.cnVariability, 10);
        assert.equal(info.ctVariability, 10);
        assert.equal(info.timeStep, 0.005);
        assert.equal(info.calcMethod, 'rigid-body');
        assert.equal(info.segments.length, 2);
        assert.deepEqual(Object.keys(info.segments[0]), ['index', 'x0', 'x1', 'type', 'label', 'cn', 'ct', 'roughness']);
        assert.equal(info.segments[0].cn, 0.8);
        assert.equal(info.segments[0].ct, 0.2);
        assert.equal(info.segments[0].x0, 0);
        assert.equal(info.segments[0].x1, 100);
        assert.equal(info.segments[0].type, 'roca-dura');
        assert.equal(info.segments[0].label, 'Roca Dura');
        assert.equal(info.segments[0].roughness, 2);
        assert.equal(info.segments[1].index, 1);
        assert.equal(info.segments[1].x1, 200);
        assert.notEqual(info.segments, segments);
        assert.notEqual(info.segments[0], segments[0]);
        assert.equal(info.segments[0].cn, 0.8);
    });
}

test('controles Cn/Ct deshabilitados con aviso exacto y etiqueta de masa concentrada', () => {
    const html = fs.readFileSync(indexPath, 'utf8');
    const tag = id => {
        const found = html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`));
        assert.ok(found, id);
        return found[0];
    };
    const block = id => {
        const start = html.indexOf(`<div id="${id}"`);
        assert.notEqual(start, -1, id);
        const next = html.indexOf('-controls"', start + id.length + 10);
        return html.slice(start, next === -1 ? undefined : next);
    };
    const notice = 'Los coeficientes Cn/Ct se definen por tramo en la pestaña Perfil; la variabilidad se aplica al valor de cada tramo.';
    // Globales medidos inertes con perfil de 2 o más puntos (exec/CB2a/probe.log).
    for (const id of ['cn-range', 'ct-range', 'cn-range-ns', 'mu-range']) assert.match(tag(id), /\sdisabled\b/, id);
    // Variabilidades y Kn/Kt siguen editables.
    for (const id of ['cn-variability', 'ct-variability', 'kn-range', 'kt-range']) assert.doesNotMatch(tag(id), /\sdisabled\b/, id);
    // El aviso exacto acompaña a los controles deshabilitados de cada método.
    for (const [id, inputs] of [['rigid-body-controls', ['cn-range', 'ct-range']], ['nonsmooth-controls', ['cn-range-ns', 'mu-range']]]) {
        const text = block(id);
        assert.ok(text.includes(notice), id);
        for (const input of inputs) assert.ok(text.includes(`id="${input}"`), input);
    }
    assert.ok(!block('lumped-mass-controls').includes(notice));
    assert.equal(html.split(notice).length - 1, 2);
    // Ningún JS deshabilita las variabilidades.
    for (const file of ['app.js', 'app-modes.js']) {
        const full = path.join(ROOT, 'js', file);
        if (!fs.existsSync(full)) continue;
        assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /(cn|ct)-variability'\)\.disabled\s*=\s*true/, file);
    }

    const f = fixture(true);
    const helpers = f.Stats.constructor('return SimRocas')();
    f.element('calc-method').value = 'lumped-mass';
    helpers.syncVariabilityLabels();
    assert.match(f.element('cn-variability-label').textContent, /^Variabilidad Cn \(%\) \(se aplica a Kn\/Kt\)$/);
    assert.match(f.element('ct-variability-label').textContent, /^Variabilidad Ct \(%\) \(se aplica a Kn\/Kt\)$/);
    f.element('calc-method').value = 'rigid-body';
    helpers.syncVariabilityLabels();
    assert.doesNotMatch(f.element('cn-variability-label').textContent, /Kn\/Kt/);
    assert.doesNotMatch(f.element('ct-variability-label').textContent, /Kn\/Kt/);
});

test('exportación de impactos se habilita, invalida y descarga con nombre exacto', () => {
    const f = setup(true, true);
    assert.equal(f.element('btn-export-impacts').disabled, true);
    const created = f.element('created');
    f.element('btn-export-impacts').click();
    assert.equal(f.app.stats.impactCalls || 0, 0);
    assert.equal(created.download, undefined);

    publish(f, true, [beta()]);
    assert.equal(f.element('btn-export-impacts').disabled, false);
    f.element('btn-export-impacts').click();
    assert.equal(f.app.stats.impactCalls, 1);
    assert.equal(created.download, 'simrocas_impactos.csv');

    f.app._invalidateResults();
    assert.equal(f.element('btn-export-impacts').disabled, true);

    const g = setup(true, false);
    publish(g, true, [beta()]);
    assert.equal(g.app._resultsValid, true);
    assert.equal(g.element('btn-export-impacts').disabled, true);
    g.element('btn-export-impacts').click();
    assert.equal(g.app.stats.impactCalls || 0, 0);
});

test('dashboard usa flightHeight y las etiquetas β', () => {
    const f = setup(true);
    publish(f, true, [beta()]);
    f.app.showResultsDashboard();
    assert.equal(f.element('dash-stat-max-bounce').textContent, '7.0');
    const html = fs.readFileSync(indexPath, 'utf8');
    assert.match(html, /Altura de vuelo del centro, máx\. \(m\)/);
    assert.match(html, /id="stat-max-impact-vn"/);
    assert.match(html, /id="stat-max-impact-energy"/);
    assert.match(html, /id="stat-max-impacts"/);
    assert.match(html, /Energía cinética máx\. de trayectoria \(kJ\)/);
    assert.match(html, /<h4>Altura de vuelo del centro vs X final<\/h4>/);
    assert.match(html, /<h4>Velocidad normal de impacto, máx\. vs X final<\/h4>/);
});

test('P03-6: numRocks se redondea, se acota a [1, 10000] y el input muestra el valor efectivo', () => {
    const cases = [['2.5', 3], ['0.4', 1], ['10000.6', 10000], ['1.4', 1], ['9999.5', 10000], ['0', 1], ['-7', 1], ['25000', 10000]];
    for (const worker of [true, false]) for (const [raw, expected] of cases) {
        const mode = `${worker ? 'Worker' : 'normal'} ${raw}`;
        const f = fixture(worker);
        f.app.terrain = terrainStub();
        f.element('num-rocks').value = raw;
        let configured = null;
        f.app.simulation.configure = params => { configured = params; };
        delete f.app.getSimulationParams;
        f.app.runSimulation();
        if (worker) assert.equal(f.workers[0].message.simParams.numRocks, expected, mode);
        else assert.equal(configured.numRocks, expected, mode);
        assert.equal(f.element('num-rocks').value, String(expected), mode);
    }
});

test('las variabilidades Cn/Ct se editan en la UI y llegan al motor en ambos modos', () => {
    const engine = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { env: 'browser' }).SimRocas;
    for (const worker of [true, false]) for (const [cnVar, ctVar] of [['25', '0'], ['0', '37']]) {
        const mode = `${worker ? 'Worker' : 'normal'} ${cnVar}/${ctVar}`;
        const f = fixture(worker);
        const terrain = new engine.Terrain();
        terrain.setPoints([{ x: 0, y: 20 }, { x: 100, y: 0 }]);
        f.app.terrain = terrain;
        f.app.physics = new engine.PhysicsEngine();
        f.app.simulation = new engine.Simulation(terrain, f.app.physics);
        delete f.app.getSimulationParams;
        f.app.releasePoint = { x: 10, y: 50 };
        assert.equal(f.element('cn-variability').disabled, false, mode);
        assert.equal(f.element('ct-variability').disabled, false, mode);
        f.element('cn-variability').value = cnVar;
        f.element('ct-variability').value = ctVar;
        f.app.runSimulation();
        let physics = f.app.physics;
        if (worker) {
            const params = f.workers[0].message.simParams;
            assert.equal(params.cnVariability, Number(cnVar), mode);
            assert.equal(params.ctVariability, Number(ctVar), mode);
            // El Worker configura su motor con el mismo mensaje.
            physics = new engine.PhysicsEngine();
            new engine.Simulation(terrain, physics).configure(params);
        }
        assert.equal(physics.cnVariability, Number(cnVar), mode);
        assert.equal(physics.ctVariability, Number(ctVar), mode);
        assert.equal(f.app._runInfo.cnVariability, Number(cnVar), mode);
        assert.equal(f.app._runInfo.ctVariability, Number(ctVar), mode);
        assert.equal(f.element('cn-variability').disabled, false, mode);
        assert.equal(f.element('ct-variability').disabled, false, mode);
    }
});

test('versionado del §4 coincide y ningún otro ?v= cambia', () => {
    const versions = source => Object.fromEntries([...source.matchAll(/(js\/[\w.\-]+\.js)\?v=(\d+)/g)]
        .map(m => [m[1], Number(m[2])]));
    const current = versions(fs.readFileSync(indexPath, 'utf8'));
    const head = versions(execFileSync('git', ['show', '67b34e52:index.html'],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } }));
    assert.equal(current['js/physics.js'], 14);
    assert.equal(current['js/simulation.js'], 13);
    assert.equal(current['js/stats.js'], 11);
    assert.equal(current['js/renderer.js'], 7);
    assert.equal(current['js/app.js'], 19); // P1.1
    assert.equal(current['js/app-worker.js'], 11); // P1.1: WORKER_VERSION 12
    const changed = ['js/physics.js', 'js/simulation.js', 'js/stats.js', 'js/renderer.js', 'js/app.js', 'js/app-worker.js',
        'js/terrain.js', 'js/app-stl.js', 'js/app-profile3d.js']; // P1.1: terrain 9, app-stl 3 y app-profile3d 3
    assert.equal(Object.keys(current).length, Object.keys(head).length + 1); // P1.1: script nuevo js/bench-profile.js?v=1
    assert.deepEqual([current['js/bench-profile.js'], current['js/terrain.js'], current['js/app-stl.js'], current['js/app-profile3d.js']], [1, 9, 3, 3]);
    for (const [file, version] of Object.entries(head)) {
        if (changed.includes(file)) continue;
        assert.equal(current[file], version, file);
    }
    const worker = fs.readFileSync(path.join(ROOT, 'js', 'app-worker.js'), 'utf8');
    assert.match(worker, /const WORKER_VERSION = 12;/); // P1.1
});
