'use strict';

/**
 * P0.5 (W5c): Stats con las filas X3 y la advertencia de métricas no finitas.
 * - X3: `contractVersion` 'P0.5' y las filas «Semilla», «Generador pseudoaleatorio»,
 *   «Versión del motor» y «Parámetros correlacionados» tras la versión del contrato.
 * - Ítem 27: `metricasNoFinitas` con conteos por métrica; sin no finitos no cambia nada.
 * - I4 con X1 → X3: sin fragmentación, todo es idéntico a bc8649b0 salvo X3.
 * La base se lee con `git show bc8649b0:js/stats.js` (solo lectura), sin checkout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadScripts } = require('./helpers/load');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'bc8649b0049bb534cbb38c4d5c1036c4b5c2c198';
const METHODS = ['rigid-body', 'lumped-mass', 'nonsmooth'];
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
const X3_LABELS = ['Semilla', 'Generador pseudoaleatorio', 'Versión del motor', 'Parámetros correlacionados'];
const X3_KEYS = ['seed', 'rngAlgorithm', 'engineVersion', 'correlatedParams'];
const VERSION_LABEL = 'Versión del contrato de resultados';
const plain = x => JSON.parse(JSON.stringify(x));

function stats() {
    const ctx = loadScripts(['js/stats.js'], { extra: { SimRocas: {}, document: undefined } });
    return new ctx.SimRocas.Stats();
}
let baseSource = null;
function baseStats() {
    if (baseSource === null) {
        baseSource = execFileSync('git', ['show', `${BASE}:js/stats.js`], { cwd: ROOT, encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
    }
    const ctx = vm.createContext({ SimRocas: {} });
    vm.runInContext(baseSource, ctx, { filename: 'stats.bc8649b0.js' });
    return new ctx.SimRocas.Stats();
}

function engine(o) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: o.seed });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE.map(p => ({ ...p })));
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    sim.configure({ numRocks: 4, animationSpeed: 1, timeStep: 0.005, maxDuration: 30,
        fragmentationEnabled: false, fractureEnergy: 25000, downhillMode: '+x' });
    physics.calcMethod = o.calcMethod;
    sim.barriers = [];
    sim.start(10, 51, 0.5, 2700, 0, 0, 30, false, 'polygon', 1, 'freefall', null);
    let it = 0;
    while (sim.isRunning && it++ < 2000000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida debe terminar');
    return sim.rocks.slice();
}

const RUN_INFO = { timeStep: 0.005, calcMethod: 'rigid-body', cnVariability: 0, ctVariability: 0,
    segments: [{ index: 0, x0: 0, x1: 60, type: 'rock', label: 'Roca', cn: 0.35, ct: 0.85, roughness: 0 },
        { index: 1, x0: 60, x1: 120, type: 'rock', label: 'Roca', cn: 0.35, ct: 0.85, roughness: 0 }] };
const X3_INFO = { seed: 123456789, rngAlgorithm: 'mulberry32', engineVersion: 11, correlatedParams: true };

function rock(id, over = {}) {
    return { id, sourceIndex: 0, releaseX: 0, releaseY: 50, finalX: 20 + id, finalY: 10, stopReason: 'rest',
        cullBoundary: null, downhillSign: 1, maxDownhillAdvance: 20 + id, maxKineticEnergy: 5000 + id,
        maxBounceHeight: 1, maxImpactVelocity: 12, bounces: 3, maxFlightHeight: 2, maxImpactNormalSpeed: 6,
        maxImpactSpeed: 9, maxImpactEnergy: 4000, impactCount: 2, impactEnergies: [1000, 2000], impactEvents: [],
        ...over };
}
const rocks = () => [rock(0), rock(1), rock(2)];
const labels = s => s.exportRows().map(row => row[0]);

// --- 1. X3 -------------------------------------------------------------------
test('X3: contractVersion es P0.5', () => {
    const s = stats();
    assert.equal(s.compute(rocks(), null, RUN_INFO).contractVersion, 'P0.5');
    assert.equal(s.compute([], null, null).contractVersion, 'P0.5');
});

test('X3: las cuatro filas van justo después de la versión del contrato, con sus valores', () => {
    const s = stats();
    s.compute(rocks(), null, { ...RUN_INFO, ...X3_INFO });
    const rows = s.exportRows(), at = rows.findIndex(row => row[0] === VERSION_LABEL);
    assert.deepEqual(plain(rows.slice(at, at + 5)), [[VERSION_LABEL, 'P0.5'], ['Semilla', 123456789],
        ['Generador pseudoaleatorio', 'mulberry32'], ['Versión del motor', 11], ['Parámetros correlacionados', 'Sí']]);
    for (const row of rows.slice(at + 1, at + 5)) assert.notEqual(row.length, 14);
    const csv = s.generateCSV().split('\n'), report = s.generateReport().split('\n');
    const c = csv.indexOf(`${VERSION_LABEL},P0.5${','.repeat(13)}`);
    assert.deepEqual(csv.slice(c + 1, c + 5), ['Semilla,123456789', 'Generador pseudoaleatorio,mulberry32',
        'Versión del motor,11', 'Parámetros correlacionados,Sí'].map(line => line + ','.repeat(13)));
    const p = report.indexOf(`${VERSION_LABEL}: P0.5`);
    assert.deepEqual(report.slice(p + 1, p + 5), ['Semilla: 123456789', 'Generador pseudoaleatorio: mulberry32',
        'Versión del motor: 11', 'Parámetros correlacionados: Sí']);
    s.compute(rocks(), null, { ...RUN_INFO, ...X3_INFO, seed: 0, correlatedParams: false });
    assert.match(s.generateCSV(), /\nSemilla,0,/);
    assert.match(s.generateReport(), /\nSemilla: 0\n[^\n]*\n[^\n]*\nParámetros correlacionados: No\n/);
});

test('X3: los campos ausentes o inválidos van vacíos, nunca undefined', () => {
    const invalid = { seed: NaN, rngAlgorithm: 7, engineVersion: Infinity, correlatedParams: 'x' };
    for (const info of [null, RUN_INFO, { ...RUN_INFO, seed: undefined, rngAlgorithm: null }, { ...RUN_INFO, ...invalid }]) {
        const s = stats();
        s.compute(rocks(), null, info);
        const rows = s.exportRows(), at = rows.findIndex(row => row[0] === VERSION_LABEL);
        assert.deepEqual(plain(rows.slice(at + 1, at + 5)), X3_LABELS.map(label => [label, '']));
        const csv = s.generateCSV(), report = s.generateReport();
        for (const label of X3_LABELS) {
            assert.ok(csv.includes(`\n${label}${','.repeat(14)}\n`), label);
            assert.ok(report.includes(`\n${label}: \n`), label);
        }
        assert.doesNotMatch(csv + report + JSON.stringify(s.results), /undefined|NaN|Infinity/);
    }
});

test('X3: el bloqueo también publica las filas', () => {
    const s = stats();
    s.compute([], null, X3_INFO);
    assert.equal(s.results.status, 'bloqueado');
    const all = labels(s), at = all.indexOf(VERSION_LABEL);
    assert.deepEqual(plain(all.slice(at + 1, at + 5)), X3_LABELS);
    assert.match(s.generateCSV(), /\nSemilla,123456789,/);
});

// --- 2. No finitos -------------------------------------------------------------
test('no finitos: una métrica NaN o Infinity genera metricasNoFinitas con conteos', () => {
    const s = stats();
    const list = [rock(0, { maxKineticEnergy: NaN }), rock(1, { maxKineticEnergy: Infinity, maxFlightHeight: -Infinity }),
        rock(2, { impactEnergies: [1000, NaN, Infinity] })];
    const r = s.compute(list, null, RUN_INFO);
    const found = r.warnings.filter(w => w.code === 'metricasNoFinitas');
    assert.equal(found.length, 1);
    assert.equal(r.warnings[r.warnings.length - 1], found[0], 'va al final de las advertencias');
    assert.deepEqual(plain(found[0].counts), { kineticEnergy: 2, flightHeight: 1, impactEnergies: 2 });
    assert.match(found[0].message, /energía cinética máxima: 2/);
    assert.match(found[0].message, /altura de vuelo: 1/);
    assert.equal(r.kineticEnergy.n, 1);
    assert.equal(r.flightHeight.n, 2);
    const rows = s.exportRows(), tail = plain(rows.slice(-3));
    assert.deepEqual(tail.map(row => row[1]), [2, 1, 2]);
    for (const row of tail) assert.match(row[0], /^Valores no finitos descartados: /);
    for (const row of rows.slice(-3)) assert.equal(row.length, 2);
    const csv = s.generateCSV().trimEnd().split('\n'), report = s.generateReport().trimEnd().split('\n');
    assert.match(csv[csv.length - 1], /^Valores no finitos descartados: [^,]+,2,/);
    assert.match(report[report.length - 1], /^Valores no finitos descartados: .+: 2$/);
    assert.ok(csv.some(line => line.startsWith('Advertencia metricasNoFinitas,')));
    assert.ok(report.some(line => line.startsWith('Advertencia metricasNoFinitas: ')));
    assert.doesNotMatch(csv.join('\n') + report.join('\n'), /undefined|NaN|Infinity/);
});

test('no finitos: los eventos de impacto con campos no finitos también se cuentan', () => {
    const s = stats();
    const event = { t: 1, x: 5, y: 40, surface: 'terrain', index: 0, vn: NaN, speed: 3, contactSpeed: 3,
        energy: Infinity, cnEff: 0.3, ctEff: 0.8, flightHeightBefore: 1 };
    const r = s.compute([rock(0, { impactEvents: [event] }), rock(1)], null, RUN_INFO);
    const found = r.warnings.find(w => w.code === 'metricasNoFinitas');
    assert.deepEqual(plain(found.counts), { impactEvents: 2 });
});

test('no finitos: sin valores no finitos no hay advertencia, filas ni claves nuevas', () => {
    const s = stats();
    // Los campos ausentes (undefined o null) no son «no finitos»: siguen sin contarse.
    const r = s.compute([rock(0), rock(1, { maxFlightHeight: undefined, maxImpactEnergy: null })], null, RUN_INFO);
    assert.equal(r.warnings.some(w => w.code === 'metricasNoFinitas'), false);
    assert.equal(labels(s).some(label => /no finitos/.test(label)), false);
    assert.doesNotMatch(s.generateCSV() + s.generateReport(), /no finitos|metricasNoFinitas/);
    assert.deepEqual(Object.keys(r), Object.keys(baseStats().compute([rock(0)], null, RUN_INFO)));
});

// --- 3. I4 con X1 → X3 -----------------------------------------------------------
test('I4: sin fragmentación, results, CSV, impactos y reporte son los de bc8649b0 salvo X3', () => {
    for (const seed of [12345, 777]) for (const calcMethod of METHODS) for (const withX3 of [false, true]) {
        const tag = `${calcMethod}/${seed}/${withX3 ? 'con' : 'sin'} X3`;
        const list = engine({ calcMethod, seed });
        assert.equal(list.some(r => r.stopReason === 'fragmented' || r.parentId !== null), false, tag);
        const info = { ...RUN_INFO, calcMethod, ...(withX3 ? X3_INFO : {}) };
        const now = stats(), old = baseStats();
        const a = now.compute(list, { x: 10, y: 51 }, info), b = old.compute(list, { x: 10, y: 51 }, info);
        assert.notEqual(b.status, 'bloqueado', tag);
        assert.equal(b.contractVersion, 'P0.4', tag);
        assert.equal(a.contractVersion, 'P0.5', tag);
        assert.equal(a.warnings.some(w => w.code === 'metricasNoFinitas'), false, tag);
        // X3 en `results`: solo contractVersion y, si llegan, las cuatro claves de runInfo al final.
        assert.deepEqual(Object.keys(a), Object.keys(b), tag);
        assert.deepEqual(Object.keys(a.runInfo), [...Object.keys(b.runInfo), ...(withX3 ? X3_KEYS : [])], tag);
        if (withX3) assert.deepEqual(plain(X3_KEYS.map(key => a.runInfo[key])), [123456789, 'mulberry32', 11, true], tag);
        const strip = r => JSON.stringify({ ...r, contractVersion: undefined,
            runInfo: Object.fromEntries(Object.entries(r.runInfo).filter(([key]) => !X3_KEYS.includes(key))) });
        assert.equal(strip(a), strip(b), tag);
        assert.equal(now.generateImpactCSV(), old.generateImpactCSV(), tag);
        const values = withX3 ? ['123456789', 'mulberry32', '11', 'Sí'] : ['', '', '', ''];
        const csvA = now.generateCSV().split('\n'), csvB = old.generateCSV().split('\n');
        const at = csvB.indexOf(`${VERSION_LABEL},P0.4${','.repeat(13)}`);
        assert.ok(at > 0, tag);
        const expectedCsv = csvB.slice();
        expectedCsv.splice(at, 1, `${VERSION_LABEL},P0.5${','.repeat(13)}`,
            ...X3_LABELS.map((label, i) => `${label},${values[i]}${','.repeat(13)}`));
        assert.deepEqual(csvA, expectedCsv, tag);
        const repA = now.generateReport().split('\n'), repB = old.generateReport().split('\n');
        const expectedReport = repB.slice();
        expectedReport.splice(repB.indexOf(`${VERSION_LABEL}: P0.4`), 1, `${VERSION_LABEL}: P0.5`,
            ...X3_LABELS.map((label, i) => `${label}: ${values[i]}`));
        assert.deepEqual(repA, expectedReport, tag);
    }
});
