'use strict';

/**
 * P1.3 (paquete B): Stats con envolventes P50/P95/P99 por colector y el CSV de cruces.
 * - I-A / I-F: sin `runInfo.collectors` válido, `results`, el CSV general, el de impactos, el de
 *   destinos y el reporte son idénticos byte a byte a 9232d1fe (base leída con `git show`).
 * - Con colectores: `results.collectors`, la sección «COLECTORES» al final y `generateCrossingsCSV()`.
 * Las rocas son DOBLES con `rock.crossings` según la firma del §3 del contrato.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadScripts } = require('./helpers/load');

const ROOT = path.resolve(__dirname, '..');
const BASE = '9232d1feac442a56a551e569ccd0fdab0cadcd3a';
const TITLE = 'COLECTORES';
const BENCH_TITLE = 'RETENCIÓN POR BANCO';
const CROSSINGS_HEADER = 'Colector,X colector,Roca,Raíz,Tipo de pieza,Ordinal,Sentido,Por corrección,t (s),Y (m),' +
    'Altura centro (m),Altura tope (m),Vx,Vy,Velocidad (m/s),Omega (rad/s),E traslación (kJ),E rotación (kJ),E total (kJ),Masa (kg)';
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];

const retentionSource = fs.readFileSync(path.join(ROOT, 'js/bench-retention.js'), 'utf8');
let baseSource = null;
function make(source, filename) {
    const ctx = vm.createContext({ SimRocas: {} });
    vm.runInContext(retentionSource, ctx, { filename: 'bench-retention.js' });
    vm.runInContext(source, ctx, { filename });
    return new ctx.SimRocas.Stats();
}
function baseStats() {
    if (baseSource === null) {
        baseSource = execFileSync('git', ['show', `${BASE}:js/stats.js`], { cwd: ROOT, encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
    }
    return make(baseSource, 'stats.9232d1fe.js');
}
const stats = () => make(fs.readFileSync(path.join(ROOT, 'js/stats.js'), 'utf8'), 'js/stats.js');

function engine(o) {
    const ctx = loadScripts(['js/terrain.js', 'js/physics.js', 'js/simulation.js'], { seed: o.seed });
    const terrain = new ctx.SimRocas.Terrain();
    terrain.setPoints(PROFILE.map(p => ({ ...p })));
    const physics = new ctx.SimRocas.PhysicsEngine();
    const sim = new ctx.SimRocas.Simulation(terrain, physics);
    sim.configure({ numRocks: 4, animationSpeed: 1, timeStep: 0.005, maxDuration: 30,
        fragmentationEnabled: !!o.fractureEnergy, fractureEnergy: o.fractureEnergy || 25000, downhillMode: '+x' });
    physics.calcMethod = 'rigid-body';
    sim.barriers = [];
    sim.start(10, 51, 0.5, 2700, 0, 0, 30, false, 'polygon', 1, 'freefall', null);
    let it = 0;
    while (sim.isRunning && it++ < 2000000) sim.step();
    assert.equal(sim.isRunning, false, 'la corrida debe terminar');
    return sim.rocks.slice();
}

const RUN_INFO = { timeStep: 0.005, calcMethod: 'rigid-body', cnVariability: 0, ctVariability: 0,
    segments: [{ index: 0, x0: 0, x1: 60, type: 'rock', label: 'Roca', cn: 0.35, ct: 0.85, roughness: 0 },
        { index: 1, x0: 60, x1: 120, type: 'rock', label: 'Roca', cn: 0.35, ct: 0.85, roughness: 0 }],
    seed: 123456789, rngAlgorithm: 'mulberry32', engineVersion: 13, correlatedParams: true };
const GEOMETRY = () => ({ source: 'generado', schemaVersion: 'bench-profile.v1', downhillSign: 1,
    benchMeta: [{ index: 1, crestX: 10, crestY: 40, toeX: 20, toeY: 20 }, { index: 2, crestX: 30, crestY: 20, toeX: 40, toeY: 0 }],
    thresholds: null, profileMinX: 0, profileMaxX: 100, pointsKey: '[{"x":0,"y":40}]' });
const COLLECTORS = () => [{ id: 'c1', x: 30, label: 'Pie del talud' }];
const withCollectors = (list = COLLECTORS(), over = {}) => ({ ...RUN_INFO, ...over, collectors: list });

function rock(id, over = {}) {
    return { id, rootId: id, parentId: null, fragmentKind: 'primary', generation: 0, mass: 100 + id, discardedMass: 0,
        sourceIndex: 0, releaseX: 5, releaseY: 50, finalX: 40 + id / 10, finalY: 10, stopReason: 'rest',
        cullBoundary: null, downhillSign: 1, maxDownhillAdvance: 35 + id / 10, maxKineticEnergy: 5000 + id,
        maxBounceHeight: 1, maxImpactVelocity: 12, bounces: 3, maxFlightHeight: 2, maxImpactNormalSpeed: 6,
        maxImpactSpeed: 9, maxImpactEnergy: 4000, impactCount: 2, impactEnergies: [1000, 2000], impactEvents: [],
        ...over };
}
// Cruce con la firma del §3: `v` fija altura, tope (v + 0.5), rapidez (2v) y energía (1000v J).
function cross(v, over = {}) {
    return { collector: 'c1', x: 30, y: 30 + v, t: 1 + v / 100, height: v, top: v + 0.5, vx: 2 * v, vy: 0, speed: 2 * v,
        omega: 0.25, energyTrans: 750 * v, energyRot: 250 * v, energy: 1000 * v, mass: 100, direction: 1, ordinal: 1,
        byCorrection: false, ...over };
}
// n rocas en reposo, cada una con un cruce de bajada de valor 1…n (en orden barajado).
const vector = n => Array.from({ length: n }, (_, i) => rock(i, { crossings: [cross(((i * 37) % n) + 1)] }));
const plainRocks = () => [rock(0, { finalX: 15 }), rock(1, { finalX: 20 }), rock(2, { finalX: 35 }), rock(3, { finalX: 70 }),
    rock(4, { finalX: 500, stopReason: 'culled', cullBoundary: 'maxX', maxDownhillAdvance: 495 }),
    rock(5, { finalX: 50, stopReason: 'maxTime' })];
const treeRocks = () => [rock(0, { stopReason: 'fragmented', mass: 100, discardedMass: 1, finalX: 12 }),
    rock(1, { rootId: 0, parentId: 0, fragmentKind: 'core', isCore: true, generation: 1, mass: 60, finalX: 25, maxDownhillAdvance: 20 }),
    rock(2, { rootId: 0, parentId: 0, fragmentKind: 'major', generation: 1, mass: 39, finalX: 80, maxDownhillAdvance: 75 }),
    rock(3, { finalX: 15, maxDownhillAdvance: 10 })];
const FIXTURES = {
    sinRocas: () => [],
    simples: plainRocks,
    arbol: treeRocks,
    conCruces: () => vector(30),
    cancelada: () => [rock(0), rock(1, { stopReason: 'cancelled' })],
    linajeInvalido: () => [rock(0, { stopReason: 'fragmented' })],
    noFinitos: () => [rock(0, { maxKineticEnergy: NaN }), rock(1)],
    motor: () => engine({ seed: 4242 }),
    motorFragmentado: () => engine({ seed: 4242, fractureEnergy: 500 })
};
const snapshot = s => ({ keys: Object.keys(s.results), runInfoKeys: Object.keys(s.results.runInfo),
    json: JSON.stringify(s.results), csv: s.generateCSV(), impacts: s.generateImpactCSV(),
    destinations: s.generateDestinationsCSV(), report: s.generateReport() });
const section = s => { const rows = s.exportRows(); const i = rows.findIndex(row => row[0] === TITLE); return i < 0 ? [] : rows.slice(i); };
// `results.collectors` se copia al realm del test (JSON) para que deepEqual no falle por prototipos del vm.
const run = (rocks, info = withCollectors()) => {
    const s = stats();
    s.compute(rocks, null, info);
    if (Object.hasOwn(s.results, 'collectors')) s.results.collectors = JSON.parse(JSON.stringify(s.results.collectors));
    return s;
};

test('I-A / I-F: sin colectores válidos todo es idéntico byte a byte a 9232d1fe', () => {
    const fragmentedRun = FIXTURES.motorFragmentado();
    assert.ok(fragmentedRun.some(r => r.stopReason === 'fragmented'), 'el fixture del motor debe fragmentar');
    const infos = [['sin runInfo', null], ['runInfo', RUN_INFO], ['bancos', { ...RUN_INFO, benchGeometry: GEOMETRY() }],
        ['undefined', { ...RUN_INFO, collectors: undefined }], ['null', { ...RUN_INFO, collectors: null }],
        ['vacío', { ...RUN_INFO, collectors: [] }], ['vacío con bancos', { ...RUN_INFO, benchGeometry: GEOMETRY(), collectors: [] }],
        ['no es lista', { ...RUN_INFO, collectors: 'c1' }],
        ['todos inválidos', { ...RUN_INFO, collectors: [null, { id: 'a', x: NaN }, { id: '', x: 3 }, { x: 4 }, [1]] }]];
    for (const [name, build] of Object.entries(FIXTURES)) {
        for (const [tag, info] of infos) {
            const input = name === 'motorFragmentado' ? fragmentedRun : build();
            const a = stats(), b = baseStats();
            const ra = a.compute(input, null, info), rb = b.compute(input, null, info);
            assert.deepEqual(snapshot(a), snapshot(b), `${name} / ${tag}`);
            assert.deepEqual(Object.keys(ra), Object.keys(rb), `${name} / ${tag}`);
            assert.equal(Object.hasOwn(ra, 'collectors'), false, `${name} / ${tag}`);
            assert.equal(a.generateCrossingsCSV(), null, `${name} / ${tag}: sin CSV de cruces`);
        }
    }
    assert.match(snapshot(run(plainRocks(), { ...RUN_INFO, benchGeometry: GEOMETRY() })).report, new RegExp(BENCH_TITLE));
    assert.equal(new (stats().constructor)().generateCrossingsCSV(), null, 'sin resultados');
});

test('I-F: con colectores, lo ajeno no cambia y solo se agrega `collectors`', () => {
    for (const name of ['simples', 'arbol', 'conCruces', 'noFinitos']) {
        const a = run(FIXTURES[name]()), b = baseStats();
        b.compute(FIXTURES[name](), null, RUN_INFO);
        const { collectors, ...rest } = a.results;
        assert.ok(Array.isArray(collectors) && collectors.length === 1, name);
        assert.equal(JSON.stringify(rest), JSON.stringify(b.results), name);
        assert.deepEqual(Object.keys(a.results), [...Object.keys(b.results), 'collectors'], name);
        assert.equal(a.results.contractVersion, 'P0.5');
        assert.equal(a.generateImpactCSV(), b.generateImpactCSV(), name);
        assert.equal(a.generateDestinationsCSV(), b.generateDestinationsCSV(), name);
        const rows = a.exportRows(), start = rows.findIndex(row => row[0] === TITLE);
        assert.equal(JSON.stringify(rows.slice(0, start)), JSON.stringify(b.exportRows()), `${name}: las filas previas no cambian`);
        assert.ok(a.generateCSV().startsWith(b.generateCSV()), name);
        assert.ok(a.generateReport().startsWith(b.generateReport()), name);
        assert.ok(a.generateCSV().split('\n').slice(0, -1).every(line => line.split(',').length >= 15), 'CSV general de 15 columnas');
    }
    assert.equal(JSON.stringify(stats().statsForArray([3, 1, 2])), JSON.stringify(baseStats().statsForArray([3, 1, 2])));
});

test('oráculo: el vector 1…101 da P50 = 51, P95 = 96 y P99 = 100 (tipo 7)', () => {
    const c = run(vector(101)).results.collectors[0];
    assert.equal(c.id, 'c1');
    assert.equal(c.label, 'Pie del talud');
    assert.equal(c.x, 30);
    assert.equal(c.sample, 'first-downhill-per-piece');
    assert.equal(c.n, 101);
    assert.deepEqual(Object.keys(c), ['id', 'label', 'x', 'sample', 'n', 'envelopes', 'counts', 'definition']);
    assert.deepEqual(Object.keys(c.envelopes), ['height', 'top', 'speed', 'energy']);
    const none = { p95: false, p99: false };
    assert.deepEqual(c.envelopes.height, { p50: 51, p95: 96, p99: 100, n: 101, insufficient: none });
    assert.deepEqual(c.envelopes.top, { p50: 51.5, p95: 96.5, p99: 100.5, n: 101, insufficient: none });
    assert.deepEqual(c.envelopes.speed, { p50: 102, p95: 192, p99: 200, n: 101, insufficient: none });
    assert.deepEqual(c.envelopes.energy, { p50: 51, p95: 96, p99: 100, n: 101, insufficient: none }, 'energía en kJ');
    assert.match(c.definition, /tipo 7/);
    assert.match(c.definition, /Hyndman/);
    assert.match(c.definition, /primer cruce de bajada de cada pieza/);
    assert.deepEqual(Object.keys(c.counts), ['crossingsTotal', 'piecesCrossing', 'rootsCrossing', 'released', 'restBeforeLine',
        'censoredWithoutCrossing', 'byCorrection', 'upward', 'dropped']);
    assert.deepEqual(c.counts, { crossingsTotal: 101, piecesCrossing: 101, rootsCrossing: 101, released: 101, restBeforeLine: 0,
        censoredWithoutCrossing: { culled: 0, maxTime: 0, maxSteps: 0 }, byCorrection: 0, upward: 0, dropped: 0 });
});

test('I-D: n = 1, 19 y 99 marcan «insuficiente» y nunca publican el número', () => {
    for (const [n, p95, p99] of [[1, true, true], [19, true, true], [20, false, true], [99, false, true], [100, false, false]]) {
        const s = run(vector(n)), c = s.results.collectors[0];
        for (const key of ['height', 'top', 'speed', 'energy']) {
            const e = c.envelopes[key];
            assert.equal(e.n, n, `${key} n=${n}`);
            assert.deepEqual(e.insufficient, { p95, p99 }, `${key} n=${n}`);
            assert.equal(Number.isFinite(e.p50), true, `${key} n=${n}: P50`);
            assert.equal(e.p95 === null, p95, `${key} n=${n}: P95`);
            assert.equal(e.p99 === null, p99, `${key} n=${n}: P99`);
        }
        const text = section(s).map(row => row[1]).join('\n');
        assert.equal(text.includes(`P95 = insuficiente (n = ${n})`), p95, `n=${n}`);
        assert.equal(text.includes(`P99 = insuficiente (n = ${n})`), p99, `n=${n}`);
    }
    assert.equal(run(vector(1)).results.collectors[0].envelopes.height.p50, 1);
    const empty = run(plainRocks()), c = empty.results.collectors[0];
    assert.equal(c.n, 0);
    assert.deepEqual(c.envelopes.height, { p50: null, p95: null, p99: null, n: 0, insufficient: { p95: true, p99: true } });
    assert.match(section(empty).map(row => row[1]).join('\n'), /P50 = insuficiente \(n = 0\)/);
});

test('muestra: primer cruce de bajada por pieza; con sentido nulo, el primero en cualquier sentido, declarado', () => {
    const rocks = () => [
        rock(0, { crossings: [cross(9, { direction: -1 }), cross(4, { ordinal: 2 }), cross(7, { ordinal: 3 })] }),
        rock(1, { crossings: [cross(8, { collector: 'otro' }), cross(2, { byCorrection: true })], crossingsDropped: 3 }),
        rock(2, { crossings: [cross(6, { direction: -1 })] }),
        rock(3, { crossings: [null, 'x', cross(NaN)] }),
        rock(4)];
    const c = run(rocks()).results.collectors[0];
    assert.equal(c.sample, 'first-downhill-per-piece');
    assert.equal(c.n, 3);
    assert.equal(c.envelopes.height.n, 2, 'el cruce no finito no entra en la envolvente');
    assert.equal(c.envelopes.height.p50, 3);
    assert.deepEqual(c.counts, { crossingsTotal: 6, piecesCrossing: 4, rootsCrossing: 3, released: 5, restBeforeLine: 2,
        censoredWithoutCrossing: { culled: 0, maxTime: 0, maxSteps: 0 }, byCorrection: 1, upward: 2, dropped: 3 });
    // Hacia −x: el cruce de bajada es el de `direction: -1`.
    const left = run(rocks().map(r => ({ ...r, downhillSign: -1, maxDownhillAdvance: 1 }))).results.collectors[0];
    assert.equal(left.n, 2);
    assert.equal(left.envelopes.height.p50, 7.5);
    assert.equal(left.counts.upward, 4);
    // Sentido no resuelto: fallback declarado.
    const s = run(rocks().map(r => ({ ...r, downhillSign: null, maxDownhillAdvance: null })));
    const any = s.results.collectors[0];
    assert.equal(any.sample, 'first-any-per-piece');
    assert.equal(any.n, 4);
    assert.equal(any.envelopes.height.p50, 6);
    assert.equal(any.counts.upward, null);
    assert.match(any.definition, /primer cruce en cualquier sentido de cada pieza/);
    assert.match(any.definition, /sentido de bajada no está resuelto/);
    assert.match(section(s).map(row => row.join(': ')).join('\n'), /cualquier sentido/);
});

test('conteos: raíces, piezas, reposo antes de la línea y censuradas sin cruce, con fragmentación', () => {
    const rocks = [
        // Árbol 0: el padre cruza antes de fragmentarse; el núcleo no cruza; la pieza principal cruza otro colector.
        rock(0, { stopReason: 'fragmented', mass: 100, discardedMass: 1, finalX: 32, crossings: [cross(5)] }),
        rock(1, { rootId: 0, parentId: 0, fragmentKind: 'core', isCore: true, generation: 1, mass: 60, finalX: 45, maxDownhillAdvance: 40, crossings: [] }),
        rock(2, { rootId: 0, parentId: 0, fragmentKind: 'major', generation: 1, mass: 39, finalX: 80, maxDownhillAdvance: 75,
            crossings: [cross(3, { collector: 'c2', x: 60 })] }),
        // Árbol 3: solo cruzan las dos hijas.
        rock(3, { stopReason: 'fragmented', mass: 100, discardedMass: 0, finalX: 20 }),
        rock(4, { rootId: 3, parentId: 3, fragmentKind: 'core', isCore: true, generation: 1, mass: 70, finalX: 50, maxDownhillAdvance: 45, crossings: [cross(1)] }),
        rock(5, { rootId: 3, parentId: 3, fragmentKind: 'spall', generation: 1, mass: 30, finalX: 55, maxDownhillAdvance: 50, crossings: [cross(2)] }),
        rock(6, { finalX: 15, maxDownhillAdvance: 10 }),
        rock(7, { finalX: -60, stopReason: 'culled', cullBoundary: 'minX', maxDownhillAdvance: 0 }),
        rock(8, { finalX: 22, stopReason: 'maxTime', maxDownhillAdvance: 17 }),
        rock(9, { finalX: 23, stopReason: 'maxSteps', maxDownhillAdvance: 18 }),
        rock(10, { finalX: 500, stopReason: 'culled', cullBoundary: 'maxX', maxDownhillAdvance: 495, crossings: [cross(4)] })];
    const s = run(rocks, withCollectors([{ id: 'c1', x: 30, label: 'Pie' }, { id: 'c2', x: 60, label: 'Camino' }]));
    const [c1, c2] = s.results.collectors;
    assert.equal(s.results.population.released, 7);
    assert.equal(c1.n, 4);
    assert.deepEqual(c1.counts, { crossingsTotal: 4, piecesCrossing: 4, rootsCrossing: 3, released: 7, restBeforeLine: 1,
        censoredWithoutCrossing: { culled: 1, maxTime: 1, maxSteps: 1 }, byCorrection: 0, upward: 0, dropped: 0 });
    assert.equal(c2.id, 'c2');
    assert.equal(c2.n, 1);
    assert.equal(c2.counts.rootsCrossing, 1);
    assert.equal(c2.counts.restBeforeLine, 2);
    for (const c of [c1, c2]) {
        const k = c.counts, w = k.censoredWithoutCrossing;
        assert.equal(k.rootsCrossing + k.restBeforeLine + w.culled + w.maxTime + w.maxSteps, k.released, 'cierre sobre N lanzadas');
    }
});

test('reporte: la sección COLECTORES va al final, después de la retención, con filas de 2 elementos', () => {
    const s = run(vector(21), withCollectors([{ id: 'c1', x: 30, label: 'Pie, "norte"' }], { benchGeometry: GEOMETRY() }));
    const rows = s.exportRows(), start = rows.findIndex(row => row[0] === TITLE);
    const bench = rows.findIndex(row => String(row[0]).startsWith(BENCH_TITLE));
    assert.ok(bench >= 0 && start > bench, 'después de la retención');
    assert.equal(rows.slice(start).some(row => String(row[0]).startsWith('Retención')), false, 'nada después de la sección');
    const own = rows.slice(start);
    assert.ok(own.every(row => row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string'));
    const text = own.map(row => row.join(': ')).join('\n');
    for (const piece of ['Pie, "norte"', 'X = 30 m', 'altura del centro (m)', 'altura del tope (m)', 'velocidad (m/s)', 'energía total (kJ)',
        'P50 = 11; P95 = 20; P99 = insuficiente (n = 21); n = 21', 'P50 = 22; P95 = 40;', 'raíces que cruzan 21 de 21 lanzadas',
        'tipo 7', 'en reposo sin cruzar 0', 'salida del dominio 0', 'tiempo máximo 0', 'pasos máximos 0']) {
        assert.ok(text.includes(piece), `falta «${piece}» en:\n${text}`);
    }
    assert.ok(s.generateReport().endsWith(own.map(row => `${row[0]}: ${row[1]}`).join('\n') + '\n'));
    const lines = s.generateCSV().trimEnd().split('\n');
    assert.ok(lines.at(-own.length).startsWith(`${TITLE},`));
    assert.match(s.generateCSV(), /"Colector Pie, ""norte"" \(X = 30 m\): /);
});

test('saneo de runInfo.collectors: copia campo por campo, descarta inválidos y duplicados', () => {
    const hostile = { get id() { throw new Error('x'); }, x: 1 };
    const list = [{ id: 'c1', x: 30, label: 'Pie', extra: 1 }, { id: 'c1', x: 40, label: 'Duplicado' }, hostile,
        { id: 'b', x: Infinity }, { id: 7, x: 60 }, { id: 'c3', x: 10, label: '' }, { id: 'c4', x: '12' }];
    const frozen = JSON.stringify(list.filter(item => item !== hostile));
    const s = run(vector(3), withCollectors(list));
    assert.deepEqual(s.results.collectors.map(c => [c.id, c.label, c.x]), [['c1', 'Pie', 30], [7, 'Colector 7', 60], ['c3', 'Colector c3', 10]]);
    assert.equal(JSON.stringify(list.filter(item => item !== hostile)), frozen, 'no muta la entrada');
    assert.equal(Object.hasOwn(s.results.collectors[0], 'extra'), false);
    const proxy = new Proxy({}, { get() { throw new Error('x'); } });
    const b = baseStats(), a = stats();
    a.compute(vector(3), null, { ...RUN_INFO, get collectors() { throw new Error('x'); } });
    b.compute(vector(3), null, RUN_INFO);
    assert.equal(JSON.stringify(a.results), JSON.stringify(b.results));
    assert.doesNotThrow(() => stats().compute(vector(3), null, { ...RUN_INFO, collectors: proxy }));
});

test('generateCrossingsCSV: cabecera exacta, una fila por cruce y null si no aplica', () => {
    const rocks = [
        rock(0, { crossings: [cross(9, { direction: -1, byCorrection: true }), cross(4, { ordinal: 2 })] }),
        rock(1, { stopReason: 'fragmented', mass: 100, discardedMass: 0, crossings: [cross(2, { collector: 'c2', x: 60 })] }),
        rock(2, { rootId: 1, parentId: 1, fragmentKind: 'core', isCore: true, generation: 1, mass: 100,
            crossings: [cross(1, { collector: 'zz' }), cross(3, { collector: 'c2', x: 60, energy: NaN })] })];
    const s = run(rocks, withCollectors([{ id: 'c1', x: 30, label: 'Pie' }, { id: 'c2', x: 60, label: 'Camino' }]));
    const lines = s.generateCrossingsCSV().split('\n');
    assert.equal(lines[0], CROSSINGS_HEADER);
    assert.equal(lines.at(-1), '');
    assert.deepEqual(lines.slice(1, -1), [
        'c1,30,0,0,primaria,1,subida,Sí,1.09,39,9,9.5,18,0,18,0.25,6.75,2.25,9,100',
        'c1,30,0,0,primaria,2,bajada,No,1.04,34,4,4.5,8,0,8,0.25,3,1,4,100',
        'c2,60,1,1,primaria,1,bajada,No,1.02,32,2,2.5,4,0,4,0.25,1.5,0.5,2,100',
        'c2,60,2,1,núcleo,1,bajada,No,1.03,33,3,3.5,6,0,6,0.25,2.25,0.75,,100']);
    assert.ok(lines.slice(0, -1).every(line => line.split(',').length === 20));
    assert.equal(Object.keys(s.results).includes('crossingRows'), false, 'las filas no son enumerables');
    // Sentido no resuelto: se rotula por el signo en X.
    const any = run([rock(0, { downhillSign: null, maxDownhillAdvance: null, crossings: [cross(1), cross(2, { direction: -1 })] })]);
    assert.deepEqual(any.generateCrossingsCSV().split('\n').slice(1, -1).map(line => line.split(',')[6]), ['+X', '-X']);
    // Corrida bloqueada: ni envolventes ni CSV.
    const blocked = run([rock(0, { crossings: [cross(1)] }), rock(1, { stopReason: 'cancelled' })]);
    assert.equal(blocked.results.status, 'bloqueado');
    assert.equal(Object.hasOwn(blocked.results, 'collectors'), false);
    assert.equal(blocked.generateCrossingsCSV(), null);
    assert.equal(section(blocked).length, 0);
    assert.equal(run(vector(2), RUN_INFO).generateCrossingsCSV(), null);
});
