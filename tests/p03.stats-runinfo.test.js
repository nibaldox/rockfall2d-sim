'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadScripts } = require('./helpers/load');

const BASELINE_DIR = process.env.P03_BASELINE_DIR ||
    path.join(os.homedir(), '.hermes', 'profiles', 'rocxkfall', 'reports', 'rockfall-p0', 'exec', 'W2-r2');
const UPDATE_BASELINE = process.env.P03_UPDATE_BASELINE === '1';

const DT_GRUESO_MESSAGE = 'Con dt > 0.02 s en cuerpo rígido o nonsmooth, algunas rocas pueden no alcanzar el reposo; use dt ≤ 0.02 s y revise el porcentaje censurado.';

function stats() {
    const ctx = loadScripts(['js/stats.js'], { extra: { SimRocas: {}, document: {} } });
    return new ctx.SimRocas.Stats();
}

function rock(overrides = {}) {
    return { releaseX: 10, releaseY: 40, finalX: 30, finalY: 20, sourceIndex: 0,
        downhillSign: 1, maxDownhillAdvance: 20, cullBoundary: null, stopReason: 'rest',
        isResting: true, isCore: false, generation: 0, maxKineticEnergy: 1000,
        maxBounceHeight: 2, maxImpactVelocity: 4, bounces: 3, impactEnergies: [], ...overrides };
}

function fixtureRocks() {
    return [
        rock(),
        rock({ finalX: 34, finalY: 18, maxDownhillAdvance: 24, maxKineticEnergy: 2200, bounces: 4 }),
        rock({ sourceIndex: 1, downhillSign: -1, finalX: -8, finalY: 22, maxDownhillAdvance: 18 }),
        rock({ stopReason: 'culled', cullBoundary: 'maxX', isResting: false, finalX: 500, finalY: 5, maxDownhillAdvance: 490 }),
        rock({ stopReason: 'maxTime', isResting: false, finalX: 120, finalY: 12, maxDownhillAdvance: 110 })
    ];
}

function blockedFragmentedRocks() {
    return [rock({ stopReason: 'fragmented', generation: 1 }), rock()];
}

function blockedInvalidRocks() {
    return [rock({ finalX: NaN })];
}

const plain = x => JSON.parse(JSON.stringify(x));
const codes = r => r.warnings.map(w => w.code);
const hasCode = (r, code) => codes(r).includes(code);
const strip = r => {
    const copy = JSON.parse(JSON.stringify(r));
    delete copy.warnings;
    delete copy.runInfo;
    return copy;
};

test('runInfo válido se publica como copia sanitizada', () => {
    const input = { timeStep: 0.005, calcMethod: 'rigid-body', extra: 'ignorado' };
    const r = stats().compute([rock()], null, input);
    assert.deepEqual(plain(r.runInfo), { timeStep: 0.005, calcMethod: 'rigid-body' });
    assert.notEqual(r.runInfo, input);
    r.runInfo.timeStep = 1;
    assert.equal(input.timeStep, 0.005);
});

test('compute sin tercer argumento deja runInfo con null', () => {
    const r = stats().compute([rock()]);
    assert.deepEqual(plain(r.runInfo), { timeStep: null, calcMethod: null });
    assert.equal(hasCode(r, 'dtGrueso'), false);
});

test('dt = 0.02 con rigid-body no advierte', () => {
    const r = stats().compute([rock()], null, { timeStep: 0.02, calcMethod: 'rigid-body' });
    assert.equal(hasCode(r, 'dtGrueso'), false);
    assert.equal(r.runInfo.timeStep, 0.02);
});

test('dt = 0.0200001 con rigid-body agrega dtGrueso', () => {
    const r = stats().compute([rock()], null, { timeStep: 0.0200001, calcMethod: 'rigid-body' });
    assert.equal(hasCode(r, 'dtGrueso'), true);
    const warning = r.warnings.find(w => w.code === 'dtGrueso');
    assert.equal(warning.message, DT_GRUESO_MESSAGE);
});

test('nonsmooth con dt grueso advierte', () => {
    const r = stats().compute(fixtureRocks(), null, { timeStep: 0.05, calcMethod: 'nonsmooth' });
    assert.equal(hasCode(r, 'dtGrueso'), true);
});

test('lumped-mass con dt grueso no advierte', () => {
    const r = stats().compute(fixtureRocks(), null, { timeStep: 0.05, calcMethod: 'lumped-mass' });
    assert.equal(hasCode(r, 'dtGrueso'), false);
});

test('runInfo inválido o ausente no advierte y deja null', () => {
    const cases = [
        ['no objeto', 'rigid-body', null, null], ['número', 7, null, null],
        ['array', [{ timeStep: 0.5, calcMethod: 'rigid-body' }], null, null], ['sin campos', {}, null, null],
        ['dt cero', { timeStep: 0, calcMethod: 'rigid-body' }, null, 'rigid-body'],
        ['dt negativo', { timeStep: -0.5, calcMethod: 'rigid-body' }, null, 'rigid-body'],
        ['dt NaN', { timeStep: NaN, calcMethod: 'rigid-body' }, null, 'rigid-body'],
        ['dt Infinity', { timeStep: Infinity, calcMethod: 'rigid-body' }, null, 'rigid-body'],
        ['dt string', { timeStep: '0.5', calcMethod: 'rigid-body' }, null, 'rigid-body'],
        ['método desconocido', { timeStep: 0.5, calcMethod: 'nbody' }, 0.5, null],
        ['método null', { timeStep: 0.5, calcMethod: null }, 0.5, null]
    ];
    for (const [label, runInfo, timeStep, calcMethod] of cases) {
        const r = stats().compute([rock()], null, runInfo);
        assert.deepEqual(plain(r.runInfo), { timeStep, calcMethod }, label);
        assert.equal(hasCode(r, 'dtGrueso'), false, label);
    }
});

test('runInfo parcial conserva solo el dato válido', () => {
    const r = stats().compute([rock()], null, { timeStep: 0.5 });
    assert.deepEqual(plain(r.runInfo), { timeStep: 0.5, calcMethod: null });
    assert.equal(hasCode(r, 'dtGrueso'), false);
});

test('la advertencia dtGrueso se agrega después de las existentes', () => {
    const r = stats().compute(fixtureRocks(), null, { timeStep: 0.05, calcMethod: 'rigid-body' });
    const list = codes(r);
    assert.equal(list[list.length - 1], 'dtGrueso');
    assert.ok(list.length > 1);
});

test('mismos datos con y sin runInfo dan resultados idénticos salvo warnings y runInfo', () => {
    for (const runInfo of [{ timeStep: 0.05, calcMethod: 'nonsmooth' }, { timeStep: 0.01, calcMethod: 'lumped-mass' }]) {
        const base = stats().compute(fixtureRocks());
        const withInfo = stats().compute(fixtureRocks(), null, runInfo);
        assert.deepEqual(strip(withInfo), strip(base));
        assert.equal(withInfo.status, base.status);
    }
});

test('los resultados bloqueados incluyen runInfo y dtGrueso', () => {
    const runInfo = { timeStep: 0.05, calcMethod: 'rigid-body' };
    const fragmented = stats().compute(blockedFragmentedRocks(), null, runInfo);
    assert.equal(fragmented.status, 'bloqueado');
    assert.deepEqual(plain(fragmented.runInfo), runInfo);
    assert.equal(hasCode(fragmented, 'dtGrueso'), true);
    const invalid = stats().compute(blockedInvalidRocks(), null, runInfo);
    assert.equal(invalid.blockedReason, 'esquemaInvalido');
    assert.deepEqual(plain(invalid.runInfo), runInfo);
    assert.equal(hasCode(invalid, 'dtGrueso'), true);
    const empty = stats().compute([], null, runInfo);
    assert.equal(empty.blockedReason, 'sinRocas');
    assert.deepEqual(plain(empty.runInfo), runInfo);
    assert.equal(hasCode(empty, 'dtGrueso'), true);
});

test('CSV y reporte exportan la advertencia y los parámetros efectivos', () => {
    const s = stats();
    s.compute(fixtureRocks(), null, { timeStep: 0.05, calcMethod: 'nonsmooth' });
    const csv = s.generateCSV(), report = s.generateReport();
    assert.match(csv, /Advertencia dtGrueso,/);
    assert.match(csv, /Paso de tiempo efectivo \(s\),0\.05,/);
    assert.match(csv, /Método de cálculo,Nonsmooth Dynamics \(NSD\)/);
    assert.match(report, /Advertencia dtGrueso: Con dt > 0\.02 s/);
    assert.match(report, /Paso de tiempo efectivo \(s\): 0\.05/);
    assert.match(report, /Método de cálculo: Nonsmooth Dynamics \(NSD\)/);
    const rows = s.exportRows();
    const warningIndex = rows.findIndex(row => row[0] === 'Advertencia dtGrueso');
    const dtIndex = rows.findIndex(row => row[0] === 'Paso de tiempo efectivo (s)');
    const methodIndex = rows.findIndex(row => row[0] === 'Método de cálculo');
    const conventionsIndex = rows.findIndex(row => row[0] === 'Convenciones');
    assert.ok(warningIndex < dtIndex && dtIndex < methodIndex && methodIndex < conventionsIndex);
    assert.deepEqual(plain(rows[dtIndex].slice(0, 2)), ['Paso de tiempo efectivo (s)', 0.05]);
    assert.deepEqual(plain(rows[methodIndex].slice(0, 2)), ['Método de cálculo', 'Nonsmooth Dynamics (NSD)']);
});

test('etiquetas de método de cálculo', () => {
    const labels = { 'rigid-body': 'Cuerpo rígido', 'lumped-mass': 'Lumped Mass (2DLM)', 'nonsmooth': 'Nonsmooth Dynamics (NSD)' };
    for (const [method, label] of Object.entries(labels)) {
        const s = stats();
        s.compute([rock()], null, { timeStep: 0.01, calcMethod: method });
        const row = s.exportRows().find(item => item[0] === 'Método de cálculo');
        assert.equal(row[1], label);
    }
});

test('el CSV conserva sus 15 columnas', () => {
    const s = stats();
    s.compute(fixtureRocks(), null, { timeStep: 0.05, calcMethod: 'rigid-body' });
    const cells = line => {
        const out = [];
        let value = '', quoted = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (quoted) {
                if (char === '"' && line[i + 1] === '"') { value += '"'; i++; }
                else if (char === '"') quoted = false;
                else value += char;
            } else if (char === '"') quoted = true;
            else if (char === ',') { out.push(value); value = ''; }
            else value += char;
        }
        out.push(value);
        return out;
    };
    const lines = s.generateCSV().trim().split('\n');
    assert.ok(lines.length > 5);
    for (const line of lines) assert.equal(cells(line).length, 15, line);
});

test('sin runInfo no se agregan filas de parámetros efectivos', () => {
    const s = stats();
    s.compute(fixtureRocks());
    const rows = s.exportRows();
    assert.equal(rows.some(row => row[0] === 'Paso de tiempo efectivo (s)'), false);
    assert.equal(rows.some(row => row[0] === 'Método de cálculo'), false);
});

test('sin runInfo, CSV y reporte son idénticos a la salida de referencia', () => {
    const s = stats();
    s.compute(fixtureRocks());
    const outputs = { 'baseline.csv': s.generateCSV(), 'baseline.txt': s.generateReport() };
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    for (const [name, text] of Object.entries(outputs)) {
        const file = path.join(BASELINE_DIR, name);
        if (UPDATE_BASELINE) fs.writeFileSync(file, text);
        if (!fs.existsSync(file)) {
            assert.fail(`falta la referencia ${file}; ejecute con P03_UPDATE_BASELINE=1 sobre el código actual`);
        }
        assert.equal(text, fs.readFileSync(file, 'utf8'), name);
    }
});
