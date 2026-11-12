'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadScripts } = require('./helpers/load');

const BASELINE_DIR = process.env.P03_BASELINE_DIR ||
    path.join(os.homedir(), '.hermes', 'profiles', 'rocxkfall', 'reports', 'rockfall-p0', 'exec', 'W2-r2');

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
// P0.2-β §3: runInfo se amplía a cinco campos; sin datos β, los tres nuevos son null.
const info = (timeStep, calcMethod) => ({ timeStep, calcMethod, cnVariability: null, ctVariability: null, segments: null });
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
    assert.deepEqual(plain(r.runInfo), info(0.005, 'rigid-body'));
    assert.notEqual(r.runInfo, input);
    r.runInfo.timeStep = 1;
    assert.equal(input.timeStep, 0.005);
});

test('compute sin tercer argumento deja runInfo con null', () => {
    const r = stats().compute([rock()]);
    assert.deepEqual(plain(r.runInfo), info(null, null));
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
        assert.deepEqual(plain(r.runInfo), info(timeStep, calcMethod), label);
        assert.equal(hasCode(r, 'dtGrueso'), false, label);
    }
});

test('runInfo parcial conserva solo el dato válido', () => {
    const r = stats().compute([rock()], null, { timeStep: 0.5 });
    assert.deepEqual(plain(r.runInfo), info(0.5, null));
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
    assert.deepEqual(plain(fragmented.runInfo), info(runInfo.timeStep, runInfo.calcMethod));
    assert.equal(hasCode(fragmented, 'dtGrueso'), true);
    const invalid = stats().compute(blockedInvalidRocks(), null, runInfo);
    assert.equal(invalid.blockedReason, 'esquemaInvalido');
    assert.deepEqual(plain(invalid.runInfo), info(runInfo.timeStep, runInfo.calcMethod));
    assert.equal(hasCode(invalid, 'dtGrueso'), true);
    const empty = stats().compute([], null, runInfo);
    assert.equal(empty.blockedReason, 'sinRocas');
    assert.deepEqual(plain(empty.runInfo), info(runInfo.timeStep, runInfo.calcMethod));
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

// P0.2-β §3: la referencia de P0.3 no se regenera. La salida esperada es esa
// referencia con los cambios de β enumerados aquí, y nada más:
//   1. sale la fila «Altura del centro al contacto (m)» (bounceHeight);
//   2. en su lugar entran los cinco agregados β, vacíos porque el fixture no trae campos β;
//   3. antes de «Convenciones» entran la versión del contrato y el tope de eventos.
const BETA_LABELS = ['Altura de vuelo del centro, máx. por roca (m)', 'Velocidad normal de impacto, máx. por roca (m/s)',
    'Rapidez de impacto, máx. por roca (m/s)', 'Energía de impacto (traslación + rotación), máx. por roca (kJ)',
    'Impactos por roca (vn ≥ 0.5 m/s)'];
const BETA_TAIL = [['Versión del contrato de resultados', 'P0.2-beta'], ['Tope de eventos de impacto por roca', '200']];
const NO_DATA = ['N', 'mínimo', 'media', 'máximo', 'desviación', 'P10', 'P50', 'P83', 'P95'].map(k => `${k}=No disponible`).join('; ');
const csvCell = label => (label.includes(',') ? `"${label}"` : label);
const BETA_FORMAT = {
    'baseline.csv': { aggregate: label => csvCell(label) + ','.repeat(14), tail: ([k, v]) => `${k},${v}` + ','.repeat(13),
        removed: 'Altura del centro al contacto (m),', conventions: 'Convenciones,' },
    'baseline.txt': { aggregate: label => `${label}: ${NO_DATA}`, tail: ([k, v]) => `${k}: ${v}`,
        removed: 'Altura del centro al contacto (m):', conventions: 'Convenciones:' }
};

function expectedBeta(name, reference) {
    const format = BETA_FORMAT[name];
    const lines = reference.split('\n');
    const removed = lines.findIndex(line => line.startsWith(format.removed));
    assert.ok(removed >= 0, `${name}: la referencia de P0.3 trae la fila de bounceHeight`);
    lines.splice(removed, 1, ...BETA_LABELS.map(format.aggregate));
    const conventions = lines.findIndex(line => line.startsWith(format.conventions));
    assert.ok(conventions > removed, `${name}: la referencia trae la fila de convenciones`);
    lines.splice(conventions, 0, ...BETA_TAIL.map(format.tail));
    return lines.join('\n');
}

test('sin runInfo, CSV y reporte son la referencia de P0.3 con los cambios enumerados de β', () => {
    const s = stats();
    s.compute(fixtureRocks());
    const outputs = { 'baseline.csv': s.generateCSV(), 'baseline.txt': s.generateReport() };
    for (const [name, text] of Object.entries(outputs)) {
        const file = path.join(BASELINE_DIR, name);
        if (!fs.existsSync(file)) assert.fail(`falta la referencia de P0.3 ${file}`);
        assert.equal(text, expectedBeta(name, fs.readFileSync(file, 'utf8')), name);
    }
});
