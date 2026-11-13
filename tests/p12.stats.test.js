'use strict';

/**
 * P1.2 (paquete B): Stats con la sección condicional «Retención por banco» y el CSV de destinos.
 * - I-A: sin `runInfo.benchGeometry`, `results`, CSV general, CSV de impactos y reporte son
 *   idénticos byte a byte a 841fe984 (base leída con `git show`, sin checkout).
 * - Con geometría válida: `results.benchRetention`, `runInfo.benchGeometry` saneado y filas al final.
 * - Geometría inválida o clasificador ausente: «No disponible» con su motivo.
 * `SimRocas.BenchRetention` es un DOBLE con la firma del §7 del contrato.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadScripts } = require('./helpers/load');

const ROOT = path.resolve(__dirname, '..');
const BASE = '841fe984534aad3d2f5b239fab17933be63c9ebb';
const TITLE = 'RETENCIÓN POR BANCO';
const DEST_HEADER = 'Roca,Raíz,Padre,Tipo de pieza,Fuente,X liberación,Y liberación,X final,Y final,Motivo,Límite,Zona,Banco,Masa (kg)';
const PROFILE = [{ x: 0, y: 60 }, { x: 60, y: 0 }, { x: 120, y: 0 }];

// Doble del §7: clasifica solo hojas en reposo, con dos bancos y s = ±1.
function makeDouble(calls, over = null) {
    const classify = (x, releaseX, g) => {
        const s = g.downhillSign, u = s * x, m = g.benchMeta;
        if (s * (x - releaseX) < 0) return { zone: 'upstream', bench: null };
        if (x < g.profileMinX || x > g.profileMaxX) return { zone: 'outside', bench: null };
        if (u < s * m[0].crestX) return { zone: 'platform', bench: null };
        for (let i = 0; i < m.length; i++) {
            if (u < s * m[i].toeX) return { zone: `face:${i + 1}`, bench: i + 1 };
            if (i + 1 < m.length && u < s * m[i + 1].crestX) return { zone: `berm:${i + 1}`, bench: i + 1 };
        }
        return { zone: 'floor', bench: null };
    };
    return { classify, summarize(input) {
        calls.push(input);
        if (over) return over;
        const g = input.geometry, n = g.benchMeta.length;
        const defs = [['upstream', 'aguas arriba de la fuente', null], ['platform', 'plataforma superior', null]];
        for (let i = 1; i <= n; i++) {
            defs.push([`face:${i}`, `cara banco ${i}`, i]);
            if (i < n) defs.push([`berm:${i}`, `berma banco ${i}`, i]);
        }
        defs.push(['floor', 'piso', null], ['outside', 'fuera del perfil', null]);
        const zones = defs.map(([key, label, bench]) => ({ key, label, bench, primaries: 0, pieces: 0, mass: 0 }));
        const zone = key => zones.find(z => z.key === key);
        // I10 (arbitraje): forma de A, con objetos { primaries, pieces, mass }.
        const cell = () => ({ primaries: 0, pieces: 0, mass: 0 });
        const censored = { byReason: { culled: cell(), maxTime: cell(), maxSteps: cell() }, primaries: 0, pieces: 0, mass: 0,
            cullBoundary: { minX: cell(), maxX: cell(), minY: cell() } };
        const perLeaf = new Map();
        let known = 0, knownPieces = 0;
        for (const p of input.primaries) {
            if (p.stopReason !== 'rest') {
                censored.primaries++; censored.byReason[p.stopReason].primaries++;
                if (p.stopReason === 'culled') censored.cullBoundary[p.cullBoundary].primaries++;
                continue;
            }
            known++;
            zone(classify(p.finalX, p.releaseX, g).zone).primaries++;
        }
        for (const leaf of input.leaves) {
            if (leaf.stopReason !== 'rest') {
                censored.pieces++;
                censored.mass += leaf.mass;
                censored.byReason[leaf.stopReason].pieces++;
                censored.byReason[leaf.stopReason].mass += leaf.mass;
                if (leaf.stopReason === 'culled') {
                    censored.cullBoundary[leaf.cullBoundary].pieces++;
                    censored.cullBoundary[leaf.cullBoundary].mass += leaf.mass;
                }
                continue;
            }
            knownPieces++;
            const c = classify(leaf.finalX, leaf.releaseX, g);
            zone(c.zone).pieces++;
            zone(c.zone).mass += leaf.mass;
            perLeaf.set(leaf.id, c);
        }
        return { ok: true, schemaVersion: 'bench-retention.v1', zones, censored,
            denominators: { released: input.primaries.length, known, releasedPieces: input.leaves.length, knownPieces },
            discardedMass: input.discardedMass,
            closure: { primariesOk: true, piecesOk: true, massOk: true, massResidual: 0 }, perLeaf };
    } };
}

function stats(double) {
    const SimRocas = double === undefined ? {} : { BenchRetention: double };
    const ctx = loadScripts(['js/stats.js'], { extra: { SimRocas, document: undefined } });
    return new ctx.SimRocas.Stats();
}
let baseSource = null;
function baseStats() {
    if (baseSource === null) {
        baseSource = execFileSync('git', ['show', `${BASE}:js/stats.js`], { cwd: ROOT, encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
    }
    const ctx = vm.createContext({ SimRocas: {} });
    vm.runInContext(baseSource, ctx, { filename: 'stats.841fe984.js' });
    return new ctx.SimRocas.Stats();
}

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
    seed: 123456789, rngAlgorithm: 'mulberry32', engineVersion: 12, correlatedParams: true };
const GEOMETRY = () => ({ source: 'generado', schemaVersion: 'bench-profile.v1', downhillSign: 1,
    benchMeta: [{ index: 1, crestX: 10, crestY: 40, toeX: 20, toeY: 20 }, { index: 2, crestX: 30, crestY: 20, toeX: 40, toeY: 0 }],
    thresholds: null, profileMinX: 0, profileMaxX: 100, pointsKey: '[{"x":0,"y":40}]' });
const withGeometry = (over = {}) => ({ ...RUN_INFO, benchGeometry: { ...GEOMETRY(), ...over } });

function rock(id, over = {}) {
    return { id, rootId: id, parentId: null, fragmentKind: 'primary', generation: 0, mass: 100 + id, discardedMass: 0,
        sourceIndex: 0, releaseX: 5, releaseY: 50, finalX: 20 + id, finalY: 10, stopReason: 'rest',
        cullBoundary: null, downhillSign: 1, maxDownhillAdvance: 15 + id, maxKineticEnergy: 5000 + id,
        maxBounceHeight: 1, maxImpactVelocity: 12, bounces: 3, maxFlightHeight: 2, maxImpactNormalSpeed: 6,
        maxImpactSpeed: 9, maxImpactEnergy: 4000, impactCount: 2, impactEnergies: [1000, 2000], impactEvents: [],
        ...over };
}
// Reposo en cara 1, berma 1, cara 2 y piso; una salida por maxX y una por tiempo máximo.
const plainRocks = () => [rock(0, { finalX: 15 }), rock(1, { finalX: 20 }), rock(2, { finalX: 35 }), rock(3, { finalX: 70 }),
    rock(4, { finalX: 500, stopReason: 'culled', cullBoundary: 'maxX', maxDownhillAdvance: 495 }),
    rock(5, { finalX: 50, stopReason: 'maxTime' })];
// Árbol 0: padre fragmentado, núcleo en reposo (berma 1) y principal más lejana en el piso; 1 kg descartado.
const treeRocks = () => [rock(0, { stopReason: 'fragmented', mass: 100, discardedMass: 1, finalX: 12 }),
    rock(1, { rootId: 0, parentId: 0, fragmentKind: 'core', isCore: true, generation: 1, mass: 60, finalX: 25, maxDownhillAdvance: 20 }),
    rock(2, { rootId: 0, parentId: 0, fragmentKind: 'major', generation: 1, mass: 39, finalX: 80, maxDownhillAdvance: 75 }),
    rock(3, { finalX: 15, maxDownhillAdvance: 10 })];
const FIXTURES = {
    sinRocas: () => [],
    simples: plainRocks,
    arbol: treeRocks,
    cancelada: () => [rock(0), rock(1, { stopReason: 'cancelled' })],
    linajeInvalido: () => [rock(0, { stopReason: 'fragmented' })],
    noFinitos: () => [rock(0, { maxKineticEnergy: NaN }), rock(1)],
    motor: () => engine({ seed: 4242 }),
    motorFragmentado: () => engine({ seed: 4242, fractureEnergy: 500 })
};
const snapshot = s => ({ keys: Object.keys(s.results), runInfoKeys: Object.keys(s.results.runInfo),
    json: JSON.stringify(s.results), csv: s.generateCSV(), impacts: s.generateImpactCSV(), report: s.generateReport() });
const benchRows = s => { const rows = s.exportRows(); return rows.slice(rows.findIndex(row => String(row[0]).startsWith(TITLE))); };

test('I-A: sin benchGeometry todo es idéntico byte a byte a 841fe984', () => {
    const fragmentedRun = FIXTURES.motorFragmentado();
    assert.ok(fragmentedRun.some(r => r.stopReason === 'fragmented'), 'el fixture del motor debe fragmentar');
    for (const [name, make] of Object.entries(FIXTURES)) {
        for (const [tag, info] of [['sin runInfo', null], ['runInfo', RUN_INFO],
            ['undefined', { ...RUN_INFO, benchGeometry: undefined }], ['null', { ...RUN_INFO, benchGeometry: null }]]) {
            const input = name === 'motorFragmentado' ? fragmentedRun : make();
            const calls = [];
            const a = stats(makeDouble(calls)), b = baseStats();
            const ra = a.compute(input, null, info), rb = b.compute(input, null, info);
            assert.deepEqual(snapshot(a), snapshot(b), `${name} / ${tag}`);
            assert.deepEqual(Object.keys(ra), Object.keys(rb), `${name} / ${tag}`);
            assert.equal(calls.length, 0, `${name} / ${tag}: no se llama al clasificador`);
            assert.equal(a.exportRows().some(row => String(row[0]).includes(TITLE)), false);
        }
    }
});

test('geometría válida: results.benchRetention, runInfo.benchGeometry saneado y lo demás sin cambios', () => {
    const calls = [];
    const s = stats(makeDouble(calls)), b = baseStats();
    const info = withGeometry({ extra: 'x' });
    info.benchGeometry.benchMeta[0].basura = () => 1;
    const r = s.compute(plainRocks(), null, info), rb = b.compute(plainRocks(), null, RUN_INFO);
    assert.equal(calls.length, 1);
    assert.equal(r.contractVersion, 'P0.5');
    assert.equal(r.benchRetention.schemaVersion, 'bench-retention.v1');
    assert.deepEqual(Object.keys(r).filter(k => k !== 'benchRetention'), Object.keys(rb));
    assert.deepEqual(Object.keys(r.runInfo), [...Object.keys(rb.runInfo), 'benchGeometry']);
    const g = r.runInfo.benchGeometry;
    assert.deepEqual(Object.keys(g), ['source', 'schemaVersion', 'downhillSign', 'benchMeta', 'thresholds', 'profileMinX', 'profileMaxX', 'pointsKey']);
    assert.notEqual(g.benchMeta, info.benchGeometry.benchMeta, 'copia, no referencia');
    assert.equal(Object.hasOwn(g.benchMeta[0], 'basura'), false);
    assert.equal(g.benchMeta[1].toeX, 40);
    // Sin la sección ni la clave nueva, el resultado es el de la base.
    const { benchRetention, ...rest } = r;
    const { benchGeometry, ...restInfo } = rest.runInfo;
    assert.equal(JSON.stringify({ ...rest, runInfo: restInfo }), JSON.stringify(rb));
    assert.equal(s.generateImpactCSV(), b.generateImpactCSV());
    // Firma del §7.
    const input = calls[0];
    assert.deepEqual(Object.keys(input), ['primaries', 'leaves', 'discardedMass', 'releasedMass', 'geometry']);
    assert.equal(input.primaries.length, 6);
    assert.deepEqual(Object.keys(input.primaries[0]), ['id', 'finalX', 'stopReason', 'cullBoundary', 'releaseX']);
    assert.deepEqual(Object.keys(input.leaves[0]), ['id', 'rootId', 'finalX', 'stopReason', 'cullBoundary', 'releaseX', 'mass']);
    assert.deepEqual({ ...input.leaves[4] }, { id: 4, rootId: 4, finalX: 500, stopReason: 'culled', cullBoundary: 'maxX', releaseX: 5, mass: 104 });
    assert.equal(input.discardedMass, 0);
    assert.equal(input.releasedMass, 100 + 101 + 102 + 103 + 104 + 105);
    assert.equal(JSON.stringify(input.geometry), JSON.stringify(g));
    // El resumen publicado conserva zonas, censura, denominadores y cierre.
    assert.deepEqual(r.benchRetention.zones.map(z => z.key), ['upstream', 'platform', 'face:1', 'berm:1', 'face:2', 'floor', 'outside']);
    assert.deepEqual(r.benchRetention.zones.map(z => z.primaries), [0, 0, 1, 1, 1, 1, 0]);
    assert.deepEqual({ ...r.benchRetention.denominators }, { released: 6, known: 4, releasedPieces: 6, knownPieces: 4 });
    assert.equal(r.benchRetention.source, 'generado');
    assert.doesNotThrow(() => JSON.stringify(r));
});

test('filas de la sección: al final, tras X3, con título, zonas, censuradas, cierre y definición', () => {
    const s = stats(makeDouble([])), b = baseStats();
    s.compute(plainRocks(), null, withGeometry());
    b.compute(plainRocks(), null, RUN_INFO);
    const rows = s.exportRows(), baseRows = b.exportRows();
    assert.deepEqual(JSON.parse(JSON.stringify(rows.slice(0, baseRows.length))), JSON.parse(JSON.stringify(baseRows)));
    const extra = rows.slice(baseRows.length);
    assert.ok(rows.findIndex(row => row[0] === 'Parámetros correlacionados') < baseRows.length);
    assert.equal(extra[0][0], `${TITLE} (geometría: generada)`);
    assert.ok(extra.every(row => row.length === 2), 'filas de 2 elementos');
    const labels = extra.map(row => row[0]);
    const at = text => labels.findIndex(label => label.includes(text));
    const zoneOrder = ['aguas arriba de la fuente', 'plataforma superior', 'cara banco 1', 'berma banco 1', 'cara banco 2', 'piso', 'fuera del perfil'].map(at);
    assert.deepEqual(zoneOrder, [1, 2, 3, 4, 5, 6, 7]);
    for (const text of ['salida del dominio', 'tiempo máximo', 'pasos máximos']) assert.ok(at(`ensuradas por ${text}`) > 7, text);
    assert.ok(at('Σ zonas + censuradas = N') > at('ensuradas por pasos máximos'));
    assert.equal(at('efinición de las zonas'), labels.length - 1);
    // Cada porcentaje va dos veces: sobre lanzadas y sobre destino conocido.
    const face = extra[3][1];
    assert.match(face, /primarias 1 \(16\.67 % de 6 lanzadas; 25\.00 % de 4 con destino conocido\)/);
    assert.match(face, /piezas 1 \(16\.67 % de 6; 25\.00 % de 4 con destino conocido\)/);
    assert.match(face, /masa 100 kg/);
    assert.match(extra[at('Σ zonas')][1], /primarias 4 \+ 2 = 6 \(cumple\)/);
    assert.match(extra[at('Σ zonas')][1], /piezas 4 \+ 2 = 6 \(cumple\)/);
    const culledRow = extra[at('ensuradas por salida del dominio')][1];
    assert.match(culledRow, /piezas por límite: izquierdo 0, derecho 1, inferior 0$/);
    assert.doesNotMatch(culledRow, /minX|maxX|minY/);
    const report = s.generateReport(), csv = s.generateCSV();
    assert.ok(report.startsWith(b.generateReport()));
    assert.ok(csv.startsWith(b.generateCSV()));
    assert.match(report, /\nRETENCIÓN POR BANCO \(geometría: generada\): /);
    for (const text of [report, csv]) {
        assert.ok(text.includes('piezas por límite: izquierdo 0, derecho 1, inferior 0'));
        assert.doesNotMatch(text.slice(text.indexOf('piezas por límite')), /minX|maxX|minY/);
    }
    assert.ok(csv.trimEnd().split('\n').every(line => line.length > 0));
});

test('geometría medida, s = −1 y berma nula', () => {
    const s = stats(makeDouble([]));
    const mirrored = { source: 'medido', downhillSign: -1, thresholds: { bermSlopeDeg: 5, bermToleranceY: 0.5, minFaceHeight: 1 },
        benchMeta: [{ crestX: 90, toeX: 80 }, { crestX: 80, toeX: 60 }] };
    const r = s.compute([rock(0, { releaseX: 95, finalX: 85, downhillSign: -1 })], null, withGeometry(mirrored));
    assert.ok(r.benchRetention, 'ordenada en u = s·x');
    assert.deepEqual({ ...r.runInfo.benchGeometry.thresholds }, mirrored.thresholds);
    const rows = benchRows(s);
    assert.equal(rows[0][0], `${TITLE} (geometría: medida)`);
    assert.match(rows.find(row => row[0].includes('berma banco 1'))[1], /sin berma/);
    assert.doesNotMatch(rows.find(row => row[0].includes('cara banco 1'))[1], /sin berma/);
});

test('geometría inválida: «No disponible» con motivo, sin benchRetention ni benchGeometry', () => {
    const bad = { noObjeto: 7, arreglo: [], fuente: { ...GEOMETRY(), source: 'otro' }, signo: { ...GEOMETRY(), downhillSign: 0 },
        sinBancos: { ...GEOMETRY(), benchMeta: [] }, noFinito: { ...GEOMETRY(), benchMeta: [{ crestX: 10, toeX: NaN }] },
        desordenado: { ...GEOMETRY(), benchMeta: [{ crestX: 10, toeX: 20 }, { crestX: 15, toeX: 30 }] },
        caraInvertida: { ...GEOMETRY(), benchMeta: [{ crestX: 20, toeX: 10 }] },
        extremos: { ...GEOMETRY(), profileMinX: 50, profileMaxX: 50 }, clave: { ...GEOMETRY(), pointsKey: '' },
        umbrales: { ...GEOMETRY(), thresholds: { bermSlopeDeg: 'x' } } };
    for (const [name, benchGeometry] of Object.entries(bad)) {
        const calls = [];
        const s = stats(makeDouble(calls)), b = baseStats();
        const r = s.compute(plainRocks(), null, { ...RUN_INFO, benchGeometry });
        const rb = b.compute(plainRocks(), null, RUN_INFO);
        assert.equal(calls.length, 0, name);
        assert.equal(Object.hasOwn(r, 'benchRetention'), false, name);
        assert.deepEqual(Object.keys(r.runInfo), Object.keys(rb.runInfo), name);
        const rows = s.exportRows(), baseRows = b.exportRows();
        assert.equal(rows.length, baseRows.length + 1, name);
        assert.equal(rows[rows.length - 1][0], TITLE, name);
        assert.match(rows[rows.length - 1][1], /^No disponible: geometría de bancos inválida \(.+\)$/, name);
        assert.equal(s.generateImpactCSV(), b.generateImpactCSV(), name);
    }
});

test('clasificador ausente o que rechaza: «No disponible» con motivo', () => {
    for (const [double, pattern] of [[undefined, /^No disponible: el clasificador de retención no está cargado$/],
        [makeDouble([], { ok: false, reason: 'bancos fuera del perfil' }), /^No disponible: bancos fuera del perfil$/],
        [{ summarize() { throw new Error('x'); } }, /^No disponible: el clasificador de retención falló$/]]) {
        const s = stats(double);
        const r = s.compute(plainRocks(), null, withGeometry());
        assert.equal(Object.hasOwn(r, 'benchRetention'), false);
        const rows = s.exportRows();
        assert.match(rows[rows.length - 1][1], pattern);
        assert.match(s.generateDestinationsCSV(), /^Roca,/);
    }
});

test('I-E: corrida no publicable no publica la tabla ni el CSV de destinos', () => {
    const calls = [];
    const s = stats(makeDouble(calls));
    assert.equal(s.generateDestinationsCSV(), null, 'sin resultados');
    const r = s.compute([rock(0), rock(1, { stopReason: 'cancelled' })], null, withGeometry());
    assert.equal(r.blockedReason, 'censuraNoPublicable');
    assert.equal(calls.length, 0);
    assert.equal(Object.hasOwn(r, 'benchRetention'), false);
    assert.match(s.exportRows().at(-1)[1], /^No disponible: corrida no publicable$/);
    assert.equal(s.generateDestinationsCSV(), null);
    const limit = Object.assign([rock(0)], { status: 'safetyLimit' });
    s.compute(limit, null, RUN_INFO);
    assert.equal(s.generateDestinationsCSV(), null);
});

test('fragmentación: primarias por representante, hojas con masa y masa descartada aparte', () => {
    const calls = [];
    const s = stats(makeDouble(calls));
    const r = s.compute(treeRocks(), null, withGeometry());
    const input = calls[0];
    assert.deepEqual(JSON.parse(JSON.stringify(input.primaries)), [
        { id: 0, finalX: 80, stopReason: 'rest', cullBoundary: null, releaseX: 5 },
        { id: 3, finalX: 15, stopReason: 'rest', cullBoundary: null, releaseX: 5 }]);
    assert.deepEqual(input.leaves.map(l => [l.id, l.rootId, l.mass]), [[1, 0, 60], [2, 0, 39], [3, 3, 103]]);
    assert.equal(input.discardedMass, 1);
    assert.equal(input.releasedMass, 203);
    assert.ok(r.lineage);
    const rows = benchRows(s);
    assert.match(rows.find(row => row[0].includes('masa descartada'))[1], /^1 kg/);
    // Censura conservadora: una hoja en tiempo máximo censura a su primaria.
    const late = treeRocks();
    late[1].stopReason = 'maxTime';
    s.compute(late, null, withGeometry());
    assert.equal(calls[1].primaries[0].stopReason, 'maxTime');
    assert.equal(calls[1].primaries[0].finalX, 80);
});

test('CSV de destinos: una fila por hoja con las columnas del §4', () => {
    const s = stats(makeDouble([]));
    s.compute(treeRocks(), null, RUN_INFO);
    assert.equal(s.generateDestinationsCSV(), `${DEST_HEADER}\n` +
        '1,0,0,núcleo,0,5,50,25,10,reposo,,,,60\n2,0,0,principal,0,5,50,80,10,reposo,,,,39\n3,3,,primaria,0,5,50,15,10,reposo,,,,103\n');
    s.compute(treeRocks(), null, withGeometry());
    assert.equal(s.generateDestinationsCSV(), `${DEST_HEADER}\n` +
        '1,0,0,núcleo,0,5,50,25,10,reposo,,berma banco 1,1,60\n2,0,0,principal,0,5,50,80,10,reposo,,piso,,39\n' +
        '3,3,,primaria,0,5,50,15,10,reposo,,cara banco 1,1,103\n');
    s.compute(plainRocks(), null, withGeometry());
    const lines = s.generateDestinationsCSV().trimEnd().split('\n');
    assert.equal(lines.length, 7);
    assert.equal(lines[5], '4,4,,primaria,0,5,50,500,10,salida del dominio,derecho,,,104');
    assert.equal(lines[6], '5,5,,primaria,0,5,50,50,10,tiempo máximo,,,,105');
    // Sin campos de linaje (rocas anteriores a P0.4): raíz = roca, primaria, masa vacía.
    const legacy = rock(7);
    delete legacy.rootId; delete legacy.parentId; delete legacy.fragmentKind; delete legacy.mass;
    s.compute([legacy], null, RUN_INFO);
    assert.equal(s.generateDestinationsCSV().split('\n')[1], '7,7,,primaria,0,5,50,27,10,reposo,,,,');
    // El CSV no agrega claves enumerables a results.
    assert.deepEqual(Object.keys(s.results), Object.keys(baseStats().compute([legacy], null, RUN_INFO)));
});
