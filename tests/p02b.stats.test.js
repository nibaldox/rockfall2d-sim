'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function stats(document) {
    const ctx = loadScripts(['js/stats.js'], { extra: { SimRocas: {}, document } });
    return new ctx.SimRocas.Stats();
}
function compute(rocks, runInfo) { return stats().compute(rocks, null, runInfo); }
const plain = x => JSON.parse(JSON.stringify(x));

const IMPACT_HEADER = 'Roca,Motivo de término,Tiempo (s),X centro (m),Y centro (m),Superficie,Tramo o barrera,Velocidad normal (m/s),Rapidez (m/s),Rapidez del punto de contacto (m/s),Energía total (kJ),Coef. normal efectivo,Coef. tangencial efectivo,Altura de vuelo previa (m),Roca original,Tipo de pieza';
const TRUNCATED = 'Se alcanzó el tope de eventos de impacto exportables (200 por roca, 100 000 en total); los máximos y conteos por roca incluyen todos los eventos.';

function event(overrides = {}) {
    return { t: 1.5, x: 22, y: 18, surface: 'terrain', index: 2, vn: 3.2, speed: 4.1,
        contactSpeed: 4.4, energy: 1500, cnEff: 0.4, ctEff: 0.7, flightHeightBefore: 1.25, ...overrides };
}
// Fixture conforme al §2 del contrato: los 8 campos β con sus tipos.
function rock(overrides = {}) {
    return { id: 0, releaseX: 10, releaseY: 40, finalX: 30, finalY: 20, sourceIndex: 0,
        downhillSign: 1, maxDownhillAdvance: 20, cullBoundary: null, stopReason: 'rest',
        isResting: true, isCore: false, generation: 0, maxKineticEnergy: 1000,
        maxBounceHeight: 2, maxImpactVelocity: 4, bounces: 3, impactEnergies: [],
        impactCount: 0, maxImpactNormalSpeed: 0, maxImpactSpeed: 0, maxImpactContactSpeed: 0,
        maxImpactEnergy: 0, maxFlightHeight: 1.5, impactEvents: [], droppedImpactEvents: 0,
        ...overrides };
}
function withEvent(overrides = {}, eventOverrides = {}) {
    return rock({ impactCount: 1, maxImpactNormalSpeed: 3.2, maxImpactSpeed: 4.1,
        maxImpactContactSpeed: 4.4, maxImpactEnergy: 1500, maxFlightHeight: 1.25,
        impactEvents: [event(eventOverrides)], ...overrides });
}

test('agregados β: etiquetas y valores sobre la población en reposo', () => {
    const s = stats();
    s.compute([withEvent({ maxImpactEnergy: 1500 }, { energy: 1500 }), withEvent({ id: 1, maxImpactEnergy: 500 }, { energy: 500 })]);
    const rows = s.exportRows();
    const labels = ['Altura de vuelo del centro, máx. por roca (m)', 'Velocidad normal de impacto, máx. por roca (m/s)',
        'Rapidez de impacto, máx. por roca (m/s)', 'Energía de impacto (traslación + rotación), máx. por roca (kJ)',
        'Impactos por roca (vn ≥ 0.5 m/s)'];
    const expected = [['Altura de vuelo del centro, máx. por roca (m)', 1.25, 1.25, 1.25, 0],
        ['Velocidad normal de impacto, máx. por roca (m/s)', 3.2, 3.2, 3.2, 0],
        ['Rapidez de impacto, máx. por roca (m/s)', 4.1, 4.1, 4.1, 0],
        ['Energía de impacto (traslación + rotación), máx. por roca (kJ)', 0.5, 1, 1.5, 0.5],
        ['Impactos por roca (vn ≥ 0.5 m/s)', 1, 1, 1, 0]];
    for (const label of labels) assert.ok(rows.some(row => row[0] === label), label);
    for (const [label, min, mean, max, std] of expected) {
        const row = rows.find(item => item[0] === label);
        assert.deepEqual(plain(row.slice(0, 7)), [label, null, 2, min, mean, max, std], label);
    }
    const r = s.results;
    assert.equal(r.impactEnergy.max, 1.5);
    assert.equal(r.impactNormalSpeed.max, 3.2);
    assert.equal(r.impactCount.max, 1);
    assert.equal(r.flightHeight.mean, 1.25);
});

test('agregados β: null cuando faltan datos y cero conservado', () => {
    const missing = compute([rock({ maxFlightHeight: null, maxImpactNormalSpeed: null, maxImpactSpeed: null, maxImpactEnergy: null })]);
    assert.equal(missing.flightHeight, null);
    assert.equal(missing.impactNormalSpeed, null);
    assert.equal(missing.impactSpeed, null);
    assert.equal(missing.impactEnergy, null);
    const zero = compute([rock({ impactCount: 0, maxImpactNormalSpeed: 0, maxImpactSpeed: 0, maxImpactEnergy: 0, maxFlightHeight: 0 })]);
    assert.equal(zero.flightHeight.mean, 0);
    assert.equal(zero.impactNormalSpeed.mean, 0);
    assert.equal(zero.impactSpeed.mean, 0);
    assert.equal(zero.impactEnergy.mean, 0);
    assert.equal(zero.impactCount.mean, 0);
});

test('agregados β: población rest, las censuradas no entran', () => {
    const r = compute([withEvent({ id: 0, maxFlightHeight: 1 }), withEvent({ id: 1, stopReason: 'maxTime', isResting: false, maxFlightHeight: 99 })]);
    assert.equal(r.flightHeight.n, 1);
    assert.equal(r.flightHeight.max, 1);
});

test('impactEvents: filas planas de rest, culled, maxTime y maxSteps con rockId y stopReason', () => {
    const r = compute([
        withEvent({ id: 7 }),
        withEvent({ id: 8, stopReason: 'culled', cullBoundary: 'maxX', isResting: false }),
        withEvent({ id: 9, stopReason: 'maxTime', isResting: false }),
        withEvent({ id: 10, stopReason: 'maxSteps', isResting: false })
    ]);
    assert.equal(r.blockedReason, null);
    assert.equal(r.impactExportAvailable, true);
    assert.equal(r.impactEvents.length, 4);
    assert.deepEqual(plain(r.impactEvents.map(e => [e.rockId, e.stopReason])), [[7, 'rest'], [8, 'culled'], [9, 'maxTime'], [10, 'maxSteps']]);
    assert.deepEqual(Object.keys(r.impactEvents[0]).sort(), ['cnEff', 'contactSpeed', 'ctEff', 'energy', 'flightHeightBefore',
        'fragmentKind', 'index', 'rockId', 'rootId', 'speed', 'stopReason', 'surface', 't', 'vn', 'x', 'y']);
    for (const e of r.impactEvents) for (const v of Object.values(e)) {
        if (typeof v === 'number') assert.ok(Number.isFinite(v));
    }
});

test('impactEvents: blockedReason deja arreglo vacío y sin exportación', () => {
    for (const rocks of [
        [withEvent(), rock({ stopReason: 'fragmented' })],
        [withEvent(), rock({ stopReason: 'cancelled' })],
        [withEvent(), rock({ stopReason: 'safetyLimit' })],
        [withEvent({ finalX: NaN })],
        []
    ]) {
        const s = stats();
        const r = s.compute(rocks);
        assert.ok(r.blockedReason, String(rocks.length));
        assert.deepEqual(plain(r.impactEvents), []);
        assert.equal(r.impactExportAvailable, false);
        assert.equal(s.generateImpactCSV(), null);
    }
});

test('impactEvents: tope global de 100 000 filas con advertencia', () => {
    const rocks = [];
    for (let i = 0; i < 501; i++) {
        const events = [];
        for (let j = 0; j < 200; j++) events.push(event({ t: j, x: i, y: j }));
        rocks.push(rock({ id: i, impactCount: 200, maxImpactNormalSpeed: 3, maxImpactSpeed: 4, maxImpactEnergy: 900,
            impactEvents: events, droppedImpactEvents: 0 }));
    }
    const s = stats();
    const r = s.compute(rocks);
    assert.equal(r.blockedReason, null);
    assert.equal(r.impactEvents.length, 100000);
    const warning = r.warnings.find(w => w.code === 'impactosTruncados');
    assert.ok(warning);
    assert.equal(warning.message, TRUNCATED);
});

test('impactEvents: droppedImpactEvents mayor que cero advierte', () => {
    const r = compute([rock({ impactCount: 200, droppedImpactEvents: 5, impactEvents: [event()] })]);
    const warning = r.warnings.find(w => w.code === 'impactosTruncados');
    assert.ok(warning);
    assert.equal(warning.message, TRUNCATED);
    const clean = compute([withEvent()]);
    assert.equal(clean.warnings.some(w => w.code === 'impactosTruncados'), false);
});

const OFF_PROFILE = 'Hay impactos sobre la prolongación horizontal del perfil, más allá de sus extremos; se usa el material del tramo extremo.';
const RUN_SEGMENTS = [
    { index: 0, x0: 0, x1: 10, type: 'suelo', label: 'Suelo', cn: 0.5, ct: 0.6, roughness: 12 },
    { index: 1, x0: 10, x1: 25.5, type: 'roca', label: 'Roca', cn: 0.8, ct: 0.9, roughness: 30 }
];
const offProfile = (rocks, runInfo) => compute(rocks, runInfo).warnings.filter(w => w.code === 'fueraDelPerfil');
test('fueraDelPerfil: advierte con el texto exacto si un evento de terreno sale de los tramos', () => {
    const runInfo = { timeStep: 0.01, calcMethod: 'rigid-body', segments: RUN_SEGMENTS };
    for (const x of [25.6, -0.1]) {
        const found = offProfile([withEvent({}, { x: 22 }), withEvent({ id: 1 }, { x, index: 1 })], runInfo);
        assert.equal(found.length, 1, `x=${x}`);
        assert.equal(found[0].message, OFF_PROFILE);
    }
    const censored = offProfile([withEvent({ stopReason: 'culled', cullBoundary: 'maxX', isResting: false }, { x: 60 })], runInfo);
    assert.equal(censored.length, 1, 'las rocas censuradas también cuentan');
    const s = stats();
    s.compute([withEvent({}, { x: 30 })], null, runInfo);
    assert.deepEqual(plain(s.exportRows().find(row => row[0] === 'Advertencia fueraDelPerfil').slice(0, 2)),
        ['Advertencia fueraDelPerfil', OFF_PROFILE]);
});

test('fueraDelPerfil: no advierte dentro del perfil, en barreras ni sin runInfo válido', () => {
    const runInfo = { timeStep: 0.01, calcMethod: 'rigid-body', segments: RUN_SEGMENTS };
    assert.equal(offProfile([withEvent({}, { x: 0 }), withEvent({ id: 1 }, { x: 25.5 })], runInfo).length, 0, 'extremos incluidos');
    assert.equal(offProfile([withEvent({}, { x: 30, surface: 'barrier', index: 0, contactSpeed: null })], runInfo).length, 0, 'barrera');
    assert.equal(offProfile([rock()], runInfo).length, 0, 'sin eventos');
    assert.equal(offProfile([withEvent({}, { x: 30 })], undefined).length, 0, 'sin runInfo');
    assert.equal(offProfile([withEvent({}, { x: 30 })], { timeStep: 0.01, calcMethod: 'rigid-body' }).length, 0, 'sin tramos');
    assert.equal(offProfile([withEvent({}, { x: 30 })], { timeStep: 0.01, calcMethod: 'rigid-body', segments: [] }).length, 0, 'tramos vacíos');
    assert.equal(offProfile([withEvent({}, { x: 30 })], { segments: 'x' }).length, 0, 'tramos inválidos');
});

function impactLines(s) {
    const text = s.generateImpactCSV();
    return text.trimEnd().split('\n');
}
test('generateImpactCSV: encabezado exacto, superficie en español y energía en kJ', () => {
    const s = stats();
    s.compute([withEvent({ id: 5 }, { surface: 'terrain', index: 3, energy: 1500 }),
        withEvent({ id: 6 }, { surface: 'barrier', index: 1, energy: 250, contactSpeed: null })]);
    const lines = impactLines(s);
    assert.equal(lines[0], IMPACT_HEADER);
    assert.equal(s.generateImpactCSV().endsWith('\n'), true);
    const terrain = lines[1].split(',');
    assert.equal(terrain.length, 16);
    assert.deepEqual(terrain.slice(0, 14), ['5', 'reposo', '1.5', '22', '18', 'Terreno', '3', '3.2', '4.1', '4.4', '1.5', '0.4', '0.7', '1.25']);
    const barrier = lines[2].split(',');
    assert.equal(barrier.length, 16);
    assert.equal(barrier[5], 'Barrera');
    assert.equal(barrier[9], '');
    assert.equal(barrier[10], '0.25');
});

test('generateImpactCSV: un solo escapado CSV compartido con generateCSV', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/stats.js'), 'utf8');
    const escaper = 'replace(/"' + '/g, ' + "'\"\"')";
    assert.equal(src.split(escaper).length - 1, 1, 'el escapado CSV debe estar definido una sola vez');
    const s = stats();
    s.compute([withEvent()], null, { timeStep: 0.01, calcMethod: 'rigid-body', cnVariability: 5, ctVariability: 5,
        segments: [{ index: 0, x0: 0, x1: 10, type: 'suelo', label: 'Suelo, "residual"', cn: 0.5, ct: 0.6, roughness: 12 }] });
    assert.match(s.generateCSV(), /Tramo 0 \(0–10 m\),"Suelo, ""residual"": Cn 0\.5, Ct 0\.6, rugosidad 12°"/);
});

test('runInfo ampliado: entradas hostiles se sanean sin lanzar', () => {
    const hostile = { timeStep: NaN, calcMethod: 'rigid-body', cnVariability: 'x', ctVariability: Infinity, segments: 'no' };
    const r = compute([rock()], hostile);
    assert.deepEqual(plain(r.runInfo), { timeStep: null, calcMethod: 'rigid-body', cnVariability: null, ctVariability: null, segments: null });
    const throwing = {};
    Object.defineProperty(throwing, 'timeStep', { get() { throw new Error('boom'); } });
    Object.defineProperty(throwing, 'segments', { get() { throw new Error('boom'); } });
    const safe = compute([rock()], throwing);
    assert.deepEqual(plain(safe.runInfo), { timeStep: null, calcMethod: null, cnVariability: null, ctVariability: null, segments: null });
    const partial = compute([rock()], { timeStep: 0.005, cnVariability: 3, segments: [null, { index: 'x' }, 'nada'] });
    assert.deepEqual(plain(partial.runInfo), { timeStep: 0.005, calcMethod: null, cnVariability: 3, ctVariability: null, segments: [] });
    const none = compute([rock()]);
    assert.deepEqual(plain(none.runInfo), { timeStep: null, calcMethod: null, cnVariability: null, ctVariability: null, segments: null });
});

test('runInfo: una fila por tramo con el formato exacto', () => {
    const s = stats();
    s.compute([rock()], null, { timeStep: 0.01, calcMethod: 'nonsmooth', cnVariability: 4, ctVariability: 6, segments: [
        { index: 0, x0: 0, x1: 10, type: 'suelo', label: 'Suelo', cn: 0.5, ct: 0.6, roughness: 12 },
        { index: 1, x0: 10, x1: 25.5, type: 'roca', label: 'Roca', cn: 0.8, ct: 0.9, roughness: 30 }
    ] });
    const rows = s.exportRows();
    const first = rows.find(row => row[0] === 'Tramo 0 (0–10 m)');
    assert.deepEqual(plain(first.slice(0, 2)), ['Tramo 0 (0–10 m)', 'Suelo: Cn 0.5, Ct 0.6, rugosidad 12°']);
    const second = rows.find(row => row[0] === 'Tramo 1 (10–25.5 m)');
    assert.deepEqual(plain(second.slice(0, 2)), ['Tramo 1 (10–25.5 m)', 'Roca: Cn 0.8, Ct 0.9, rugosidad 30°']);
    assert.deepEqual(plain(rows.find(row => row[0] === 'Variabilidad de Cn/Ct aplicada a cada tramo (%)').slice(0, 2)),
        ['Variabilidad de Cn/Ct aplicada a cada tramo (%)', 'Cn 4, Ct 6']);
    assert.deepEqual(plain(rows.find(row => row[0] === 'Tope de eventos de impacto por roca').slice(0, 2)),
        ['Tope de eventos de impacto por roca', 200]);
});

test('runInfo: la fila de variabilidad cambia en masa concentrada', () => {
    const s = stats();
    s.compute([rock()], null, { timeStep: 0.01, calcMethod: 'lumped-mass', cnVariability: 4, ctVariability: 6, segments: [] });
    const rows = s.exportRows();
    assert.equal(rows.some(row => row[0] === 'Variabilidad de Cn/Ct aplicada a cada tramo (%)'), false);
    const row = rows.find(item => item[0] === 'Variabilidad aplicada a Kn/Kt (%)');
    assert.deepEqual(plain(row.slice(0, 2)), ['Variabilidad aplicada a Kn/Kt (%)', 'Kn 4, Kt 6']);
});

test('sin runInfo no aparecen filas de tramo ni de variabilidad', () => {
    const s = stats();
    s.compute([rock()]);
    const rows = s.exportRows();
    assert.equal(rows.some(row => /^Tramo \d/.test(String(row[0]))), false);
    assert.equal(rows.some(row => /^Variabilidad/.test(String(row[0]))), false);
});

test('versión del contrato P0.2-beta y sin fila de altura al contacto', () => {
    const s = stats();
    s.compute([rock()]);
    assert.equal(s.results.contractVersion, 'P0.4');
    const rows = s.exportRows();
    assert.deepEqual(plain(rows.find(row => row[0] === 'Versión del contrato de resultados').slice(0, 2)),
        ['Versión del contrato de resultados', 'P0.4']);
    assert.equal(rows.some(row => row[0] === 'Altura del centro al contacto (m)'), false);
    const csv = s.generateCSV();
    assert.doesNotMatch(csv, /Altura del centro al contacto/);
    assert.match(csv, /Versión del contrato de resultados,P0\.4,/);
    assert.doesNotMatch(s.generateReport(), /Altura del centro al contacto/);
});

test('las filas nuevas van después de las de P0.3 y antes de Convenciones', () => {
    const s = stats();
    s.compute([rock()], null, { timeStep: 0.01, calcMethod: 'rigid-body', cnVariability: 1, ctVariability: 1,
        segments: [{ index: 0, x0: 0, x1: 10, type: 'suelo', label: 'Suelo', cn: 0.5, ct: 0.6, roughness: 3 }] });
    const rows = s.exportRows();
    const index = name => rows.findIndex(row => row[0] === name);
    const method = index('Método de cálculo');
    for (const name of ['Versión del contrato de resultados', 'Variabilidad de Cn/Ct aplicada a cada tramo (%)', 'Tramo 0 (0–10 m)', 'Tope de eventos de impacto por roca']) {
        assert.ok(method < index(name), name);
        assert.ok(index(name) < index('Convenciones'), name);
    }
    assert.ok(index('Versión del contrato de resultados') < index('Tope de eventos de impacto por roca'));
});

test('el bloque de bounceHeight sigue en results pero no en las exportaciones', () => {
    const s = stats();
    s.compute([rock({ maxBounceHeight: 3 })]);
    assert.equal(s.results.bounceHeight.max, 3);
    assert.equal(s.exportRows().some(row => row[0] === 'Altura del centro al contacto (m)'), false);
});

test('updateUI escribe los ids nuevos y flightHeight en stat-max-bounce', () => {
    const elements = {};
    const s = stats({ getElementById(id) { return elements[id] ||= { textContent: '' }; } });
    s.compute([withEvent({ impactCount: 3, maxImpactNormalSpeed: 3.2, maxImpactEnergy: 1500, maxFlightHeight: 1.25 })]);
    s.updateUI();
    assert.equal(elements['stat-max-bounce'].textContent, '1.3');
    assert.equal(elements['stat-max-impact-vn'].textContent, '3.2');
    assert.equal(elements['stat-max-impact-energy'].textContent, '1.5');
    assert.equal(elements['stat-max-impacts'].textContent, '3');
    const empty = {};
    const e = stats({ getElementById(id) { return empty[id] ||= { textContent: '' }; } });
    e.compute([rock({ maxFlightHeight: null, maxImpactNormalSpeed: null, maxImpactEnergy: null })]);
    e.updateUI();
    assert.equal(empty['stat-max-bounce'].textContent, '—');
    assert.equal(empty['stat-max-impact-vn'].textContent, '—');
    assert.equal(empty['stat-max-impact-energy'].textContent, '—');
});

// --- CB2b: RVBa-3 -------------------------------------------------------------

const OFF_PROFILE_LUMPED = 'Hay impactos sobre la prolongación horizontal del perfil, más allá de sus extremos; en masa concentrada se usan Kn/Kt globales.';

test('RVBa-3a: un tramo sin type no se descarta, lleva «sin tipo» y cuenta para los extremos', () => {
    const segments = [
        { index: 0, x0: 0, x1: 80, type: 'suelo', label: 'Suelo', cn: 0.4, ct: 0.7, roughness: 0 },
        { index: 1, x0: 80, x1: 200, cn: 0.5, ct: 0.5, roughness: 0 }
    ];
    const runInfo = { timeStep: 0.01, calcMethod: 'rigid-body', segments };
    assert.equal(offProfile([withEvent({}, { x: 100, index: 1 })], runInfo).length, 0, 'x=100 está dentro del perfil 0–200');
    assert.equal(offProfile([withEvent({}, { x: 200.5, index: 1 })], runInfo).length, 1, 'x=200.5 está fuera');
    const s = stats();
    const r = s.compute([withEvent({}, { x: 100, index: 1 })], null, runInfo);
    assert.equal(r.runInfo.segments.length, 2, 'el tramo sin type se conserva');
    assert.equal(r.runInfo.segments[1].label, 'sin tipo');
    const row = s.exportRows().find(item => item[0] === 'Tramo 1 (80–200 m)');
    assert.ok(row, 'fila del tramo sin type');
    assert.deepEqual(plain(row.slice(0, 2)), ['Tramo 1 (80–200 m)', 'sin tipo: Cn 0.5, Ct 0.5, rugosidad 0°']);
    // Primer tramo sin type: el extremo izquierdo sigue siendo su x0.
    const leading = { timeStep: 0.01, calcMethod: 'nonsmooth', segments: [
        { index: 0, x0: -40, x1: 0, type: '', cn: 0.5, ct: 0.5, roughness: 0 }, segments[0]] };
    assert.equal(offProfile([withEvent({}, { x: -20, index: 0 })], leading).length, 0, 'x=-20 está dentro');
    assert.equal(offProfile([withEvent({}, { x: -41, index: 0 })], leading).length, 1, 'x=-41 está fuera');
});

test('RVBa-3a: los extremos usan todos los tramos con geometría válida, aunque su material no lo sea', () => {
    const runInfo = { timeStep: 0.01, calcMethod: 'rigid-body', segments: [
        { index: 0, x0: 0, x1: 80, type: 'suelo', label: 'Suelo', cn: 0.4, ct: 0.7, roughness: 0 },
        { index: 1, x0: 80, x1: 200, type: 'roca', label: 'Roca', cn: NaN, ct: 0.5, roughness: 0 }
    ] };
    const r = compute([withEvent({}, { x: 100, index: 1 })], runInfo);
    assert.equal(r.runInfo.segments.length, 1, 'el tramo con material inválido no tiene fila');
    assert.equal(r.warnings.filter(w => w.code === 'fueraDelPerfil').length, 0, 'x=100 está dentro del perfil 0–200');
    assert.equal(offProfile([withEvent({}, { x: 201, index: 1 })], runInfo).length, 1);
});

test('RVBa-3b: en masa concentrada fueraDelPerfil usa su texto propio', () => {
    const runInfo = { timeStep: 0.01, calcMethod: 'lumped-mass', segments: RUN_SEGMENTS };
    const found = offProfile([withEvent({}, { x: 30, index: 1, contactSpeed: null })], runInfo);
    assert.equal(found.length, 1);
    assert.equal(found[0].message, OFF_PROFILE_LUMPED);
    for (const calcMethod of ['rigid-body', 'nonsmooth']) {
        const other = offProfile([withEvent({}, { x: 30, index: 1 })], { timeStep: 0.01, calcMethod, segments: RUN_SEGMENTS });
        assert.equal(other[0].message, OFF_PROFILE, calcMethod);
    }
});
