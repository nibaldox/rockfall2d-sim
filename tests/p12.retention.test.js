'use strict';

/**
 * P1.2 (paquete A) — SimRocas.BenchRetention: clasificador puro de destinos
 * por banco (CONTRATO_P12 §2, §4 y §7).
 *
 * Oráculo a mano. Geometría base (s = +1, perfil 0…60):
 *   cresta_1 = 10, pata_1 = 14, cresta_2 = 20, pata_2 = 24
 *   plataforma u<10 · cara 1 [10,14) · berma 1 [14,20) · cara 2 [20,24) · piso u≥24
 * La reflejada (s = −1) usa x' = 60 − x.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, loadScripts } = require('./helpers/load');

const FILE = 'js/bench-retention.js';
const ZONE_KEYS = ['upstream', 'platform', 'face:1', 'berm:1', 'face:2', 'floor', 'outside'];

function load(options = {}) {
    return loadScripts([FILE], { env: 'node', ...options }).SimRocas.BenchRetention;
}

// Los objetos vienen de otro contexto vm: se comparan por valor.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

function geometry(overrides = {}) {
    return {
        source: 'generado',
        schemaVersion: 'bench-profile.v1',
        downhillSign: 1,
        benchMeta: [
            { crestX: 10, crestY: 20, toeX: 14, toeY: 10, height: 10 },
            { crestX: 20, crestY: 10, toeX: 24, toeY: 0, height: 10 }
        ],
        thresholds: null,
        profileMinX: 0,
        profileMaxX: 60,
        pointsKey: 'k',
        ...overrides
    };
}

function mirrored(overrides = {}) {
    const base = geometry();
    return {
        ...base,
        downhillSign: -1,
        benchMeta: base.benchMeta.map(b => ({ ...b, crestX: 60 - b.crestX, toeX: 60 - b.toeX })),
        ...overrides
    };
}

function noBerm() {
    return geometry({ benchMeta: [
        { crestX: 10, crestY: 20, toeX: 14, toeY: 10 },
        { crestX: 14, crestY: 10, toeX: 18, toeY: 0 }
    ] });
}

function leaf(id, finalX, extra = {}) {
    return { id, rootId: id, finalX, stopReason: 'rest', cullBoundary: null, releaseX: 5, mass: 1, ...extra };
}

function zone(result, key) {
    return plain(result.zones.find(z => z.key === key));
}

// [x, zona, banco] con liberación en x = 5.
const POSITIONS = [
    [5, 'platform', null],
    [9.999999, 'platform', null],
    [10, 'face:1', 1],
    [12, 'face:1', 1],
    [13.999999, 'face:1', 1],
    [14, 'berm:1', 1],
    [17, 'berm:1', 1],
    [19.999999, 'berm:1', 1],
    [20, 'face:2', 2],
    [23.999999, 'face:2', 2],
    [24, 'floor', null],
    [60, 'floor', null],
    [4.999999, 'upstream', null],
    [60.000001, 'outside', null]
];

test('P12-A classify: bordes exactos; la cresta es de la cara y la pata de la berma', () => {
    const BR = load();
    for (const [x, key, bench] of POSITIONS) {
        assert.deepEqual(plain(BR.classify(x, 5, geometry())), { zone: key, bench }, `x=${x}`);
    }
    // Liberación sobre la plataforma: el borde izquierdo del perfil sigue dentro.
    assert.deepEqual(plain(BR.classify(0, 0, geometry())), { zone: 'platform', bench: null });
    assert.deepEqual(plain(BR.classify(-0.000001, -1, geometry())), { zone: 'outside', bench: null });
});

test('P12-A classify: s = −1 con la geometría reflejada da las mismas zonas', () => {
    const BR = load();
    for (const [x, key, bench] of POSITIONS) {
        assert.deepEqual(plain(BR.classify(60 - x, 55, mirrored())), { zone: key, bench }, `x=${60 - x}`);
    }
    // Bordes en el marco reflejado: cresta_1 = 50, pata_1 = 46, cresta_2 = 40, pata_2 = 36.
    assert.equal(BR.classify(50, 55, mirrored()).zone, 'face:1');
    assert.equal(BR.classify(46, 55, mirrored()).zone, 'berm:1');
    assert.equal(BR.classify(40, 55, mirrored()).zone, 'face:2');
    assert.equal(BR.classify(36, 55, mirrored()).zone, 'floor');
    assert.equal(BR.classify(55.5, 55, mirrored()).zone, 'upstream');
});

test('P12-A classify: aguas arriba tiene prioridad sobre fuera y sobre los bancos', () => {
    const BR = load();
    // La fuente está en la berma 1: una roca que retrocede a la cara 1 es «aguas arriba».
    assert.deepEqual(plain(BR.classify(12, 17, geometry())), { zone: 'upstream', bench: null });
    assert.deepEqual(plain(BR.classify(17, 17, geometry())), { zone: 'berm:1', bench: 1 });
    // Aguas arriba y además fuera del perfil: gana aguas arriba.
    assert.deepEqual(plain(BR.classify(-3, 5, geometry())), { zone: 'upstream', bench: null });
    assert.deepEqual(plain(BR.classify(63, 55, mirrored())), { zone: 'upstream', bench: null });
    // Fuera del perfil aguas abajo.
    assert.deepEqual(plain(BR.classify(61, 5, geometry())), { zone: 'outside', bench: null });
    assert.deepEqual(plain(BR.classify(-1, 55, mirrored())), { zone: 'outside', bench: null });
});

test('P12-A classify: W = 0 deja la berma vacía; la pata pasa a la cara inferior', () => {
    const BR = load();
    const g = noBerm();
    assert.deepEqual(plain(BR.classify(13.999999, 5, g)), { zone: 'face:1', bench: 1 });
    assert.deepEqual(plain(BR.classify(14, 5, g)), { zone: 'face:2', bench: 2 });
    assert.deepEqual(plain(BR.classify(18, 5, g)), { zone: 'floor', bench: null });
});

test('P12-A classify: entradas no clasificables devuelven zona nula', () => {
    const BR = load();
    for (const x of [NaN, Infinity, null, undefined, '12']) {
        assert.deepEqual(plain(BR.classify(x, 5, geometry())), { zone: null, bench: null });
    }
    assert.deepEqual(plain(BR.classify(12, NaN, geometry())), { zone: null, bench: null });
    assert.deepEqual(plain(BR.classify(12, 5, null)), { zone: null, bench: null });
    assert.deepEqual(plain(BR.classify(12, 5, geometry({ benchMeta: [] }))), { zone: null, bench: null });
});

test('P12-A summarize: zonas en orden fijo, con rótulos, y las vacías publicadas en 0', () => {
    const BR = load();
    const r = BR.summarize({ primaries: [], leaves: [], discardedMass: 0, releasedMass: 0, geometry: geometry() });
    assert.equal(r.ok, true);
    assert.equal(r.schemaVersion, 'bench-retention.v1');
    assert.deepEqual(plain(r.zones), [
        { key: 'upstream', label: 'aguas arriba de la fuente', bench: null, primaries: 0, pieces: 0, mass: 0, note: null },
        { key: 'platform', label: 'plataforma superior', bench: null, primaries: 0, pieces: 0, mass: 0, note: null },
        { key: 'face:1', label: 'cara banco 1', bench: 1, primaries: 0, pieces: 0, mass: 0, note: null },
        { key: 'berm:1', label: 'berma banco 1', bench: 1, primaries: 0, pieces: 0, mass: 0, note: null },
        { key: 'face:2', label: 'cara banco 2', bench: 2, primaries: 0, pieces: 0, mass: 0, note: null },
        { key: 'floor', label: 'piso', bench: null, primaries: 0, pieces: 0, mass: 0, note: null },
        { key: 'outside', label: 'fuera del perfil', bench: null, primaries: 0, pieces: 0, mass: 0, note: null }
    ]);
    assert.deepEqual(plain(r.denominators), { released: 0, known: 0, releasedPieces: 0, knownPieces: 0 });
    assert.deepEqual(plain(r.closure), { primariesOk: true, piecesOk: true, massOk: true, massResidual: 0 });
    // Un solo banco: sin berma y sin fila de berma.
    const one = BR.summarize({ primaries: [], leaves: [], discardedMass: 0, releasedMass: 0,
        geometry: geometry({ benchMeta: [{ crestX: 10, toeX: 14 }] }) });
    assert.deepEqual(plain(one.zones.map(z => z.key)), ['upstream', 'platform', 'face:1', 'floor', 'outside']);
});

test('P12-A summarize: una hoja por posición del oráculo, cierre en conteo y masa', () => {
    const BR = load();
    const leaves = POSITIONS.map(([x], i) => leaf(i + 1, x, { mass: i + 1 }));
    const primaries = leaves.map(({ mass, rootId, ...p }) => p);
    const released = leaves.reduce((sum, l) => sum + l.mass, 0);
    const r = BR.summarize({ primaries, leaves, discardedMass: 0, releasedMass: released, geometry: geometry() });
    assert.equal(r.ok, true);
    const expected = { upstream: [1, 13], platform: [2, 1 + 2], 'face:1': [3, 3 + 4 + 5], 'berm:1': [3, 6 + 7 + 8],
        'face:2': [2, 9 + 10], floor: [2, 11 + 12], outside: [1, 14] };
    assert.deepEqual(plain(r.zones.map(z => z.key)), ZONE_KEYS);
    for (const key of ZONE_KEYS) {
        const z = zone(r, key);
        assert.deepEqual([z.primaries, z.pieces, z.mass], [expected[key][0], expected[key][0], expected[key][1]], key);
    }
    assert.deepEqual(plain(r.denominators), { released: 14, known: 14, releasedPieces: 14, knownPieces: 14 });
    assert.deepEqual(plain(r.closure), { primariesOk: true, piecesOk: true, massOk: true, massResidual: 0 });
    POSITIONS.forEach(([, key, bench], i) => {
        assert.deepEqual(plain(r.perLeaf[i + 1]), { zone: key, bench }, `hoja ${i + 1}`);
    });
});

test('P12-A summarize: s = −1 reflejado da la misma tabla', () => {
    const BR = load();
    const build = (g, flip) => {
        const leaves = POSITIONS.map(([x], i) => leaf(i + 1, flip ? 60 - x : x, { mass: i + 1, releaseX: flip ? 55 : 5 }));
        return BR.summarize({ primaries: leaves, leaves, discardedMass: 0, releasedMass: 105, geometry: g });
    };
    const direct = build(geometry(), false);
    const flipped = build(mirrored(), true);
    assert.equal(flipped.ok, true);
    assert.deepEqual(plain(flipped.zones), plain(direct.zones));
    assert.deepEqual(plain(flipped.perLeaf), plain(direct.perLeaf));
    assert.deepEqual(plain(flipped.closure), plain(direct.closure));
});

test('P12-A summarize: W = 0 publica la fila de berma en 0 con la nota «sin berma»', () => {
    const BR = load();
    const leaves = [leaf(1, 12), leaf(2, 14), leaf(3, 16), leaf(4, 18)];
    const r = BR.summarize({ primaries: leaves, leaves, discardedMass: 0, releasedMass: 4, geometry: noBerm() });
    assert.equal(r.ok, true);
    assert.deepEqual(zone(r, 'berm:1'),
        { key: 'berm:1', label: 'berma banco 1', bench: 1, primaries: 0, pieces: 0, mass: 0, note: 'sin berma' });
    assert.equal(zone(r, 'face:1').pieces, 1);
    assert.equal(zone(r, 'face:2').pieces, 2);
    assert.equal(zone(r, 'floor').pieces, 1);
    assert.equal(zone(r, 'face:2').note, null);
    assert.equal(r.closure.piecesOk, true);
});

test('P12-A summarize: cada motivo de censura va aparte, con su cullBoundary, y nunca en una zona', () => {
    const BR = load();
    // Todas las censuradas tienen una finalX que caería en la berma 1.
    const leaves = [
        leaf(1, 17, { mass: 2 }),
        leaf(2, 17, { stopReason: 'culled', cullBoundary: 'minX', mass: 3 }),
        leaf(3, 17, { stopReason: 'culled', cullBoundary: 'maxX', mass: 5 }),
        leaf(4, 17, { stopReason: 'culled', cullBoundary: 'maxX', mass: 7 }),
        leaf(5, 17, { stopReason: 'culled', cullBoundary: 'minY', mass: 11 }),
        leaf(6, 17, { stopReason: 'maxTime', mass: 13 }),
        leaf(7, 17, { stopReason: 'maxSteps', mass: 17 }),
        // isResting no decide nada: finish lo pone en true para cualquier motivo.
        leaf(8, 17, { stopReason: 'maxSteps', isResting: true, mass: 19 })
    ];
    const r = BR.summarize({ primaries: leaves, leaves, discardedMass: 0, releasedMass: 77, geometry: geometry() });
    assert.equal(r.ok, true);
    assert.deepEqual(zone(r, 'berm:1'),
        { key: 'berm:1', label: 'berma banco 1', bench: 1, primaries: 1, pieces: 1, mass: 2, note: null });
    assert.equal(r.zones.reduce((sum, z) => sum + z.pieces, 0), 1);
    assert.deepEqual(plain(r.censored), {
        byReason: {
            culled: { primaries: 4, pieces: 4, mass: 26 },
            maxTime: { primaries: 1, pieces: 1, mass: 13 },
            maxSteps: { primaries: 2, pieces: 2, mass: 36 }
        },
        primaries: 7,
        pieces: 7,
        mass: 75,
        cullBoundary: {
            minX: { primaries: 1, pieces: 1, mass: 3 },
            maxX: { primaries: 2, pieces: 2, mass: 12 },
            minY: { primaries: 1, pieces: 1, mass: 11 }
        }
    });
    assert.deepEqual(plain(r.denominators), { released: 8, known: 1, releasedPieces: 8, knownPieces: 1 });
    assert.deepEqual(plain(r.closure), { primariesOk: true, piecesOk: true, massOk: true, massResidual: 0 });
    assert.deepEqual(plain(r.perLeaf[1]), { zone: 'berm:1', bench: 1 });
    for (let id = 2; id <= 8; id++) assert.deepEqual(plain(r.perLeaf[id]), { zone: null, bench: null });
});

test('P12-A summarize: aguas arriba usa el releaseX de cada roca, con varias fuentes', () => {
    const BR = load();
    // Misma finalX = 12 (cara 1) para tres fuentes distintas.
    const leaves = [
        leaf(1, 12, { releaseX: 5 }),
        leaf(2, 12, { releaseX: 12 }),
        leaf(3, 12, { releaseX: 12.000001 }),
        leaf(4, 12, { releaseX: 22 }),
        leaf(5, 22, { releaseX: 22 })
    ];
    const r = BR.summarize({ primaries: leaves, leaves, discardedMass: 0, releasedMass: 5, geometry: geometry() });
    assert.equal(zone(r, 'face:1').pieces, 2);
    assert.equal(zone(r, 'upstream').pieces, 2);
    assert.equal(zone(r, 'face:2').pieces, 1);
    assert.deepEqual(plain([1, 2, 3, 4, 5].map(id => r.perLeaf[id].zone)),
        ['face:1', 'face:1', 'upstream', 'upstream', 'face:2']);
});

test('P12-A summarize: un árbol con hojas en zonas distintas, censura y masa descartada', () => {
    const BR = load();
    // Árbol 1 (100 kg): hojas en cara 1, berma 1 y piso, una cortada y 4 kg descartados.
    // Árbol 2 (50 kg): entero, en la plataforma. Árbol 3 (30 kg): entero, censurado por tiempo.
    const leaves = [
        { id: 11, rootId: 1, finalX: 12, stopReason: 'rest', cullBoundary: null, releaseX: 5, mass: 40 },
        { id: 12, rootId: 1, finalX: 15, stopReason: 'rest', cullBoundary: null, releaseX: 5, mass: 30 },
        { id: 13, rootId: 1, finalX: 30, stopReason: 'rest', cullBoundary: null, releaseX: 5, mass: 16 },
        { id: 14, rootId: 1, finalX: 520, stopReason: 'culled', cullBoundary: 'maxX', releaseX: 5, mass: 10 },
        { id: 2, rootId: 2, finalX: 7, stopReason: 'rest', cullBoundary: null, releaseX: 5, mass: 50 },
        { id: 3, rootId: 3, finalX: 21, stopReason: 'maxTime', cullBoundary: null, releaseX: 5, mass: 30 }
    ];
    // Representantes que entrega Stats: la más lejana de cada árbol.
    const primaries = [
        { id: 1, finalX: 30, stopReason: 'rest', cullBoundary: null, releaseX: 5 },
        { id: 2, finalX: 7, stopReason: 'rest', cullBoundary: null, releaseX: 5 },
        { id: 3, finalX: 21, stopReason: 'maxTime', cullBoundary: null, releaseX: 5 }
    ];
    const r = BR.summarize({ primaries, leaves, discardedMass: 4, releasedMass: 180, geometry: geometry() });
    assert.equal(r.ok, true);
    const table = Object.fromEntries(plain(r.zones).map(z => [z.key, [z.primaries, z.pieces, z.mass]]));
    assert.deepEqual(table, {
        upstream: [0, 0, 0], platform: [1, 1, 50], 'face:1': [0, 1, 40], 'berm:1': [0, 1, 30],
        'face:2': [0, 0, 0], floor: [1, 1, 16], outside: [0, 0, 0]
    });
    assert.deepEqual(plain(r.censored.byReason), {
        culled: { primaries: 0, pieces: 1, mass: 10 },
        maxTime: { primaries: 1, pieces: 1, mass: 30 },
        maxSteps: { primaries: 0, pieces: 0, mass: 0 }
    });
    assert.deepEqual(plain(r.censored.cullBoundary.maxX), { primaries: 0, pieces: 1, mass: 10 });
    assert.deepEqual([r.censored.primaries, r.censored.pieces, r.censored.mass], [1, 2, 40]);
    assert.deepEqual(plain(r.denominators), { released: 3, known: 2, releasedPieces: 6, knownPieces: 4 });
    assert.equal(r.discardedMass, 4);
    // Σ zonas + censuradas = N, en primarias, piezas y masa (con la descartada).
    const sum = key => r.zones.reduce((total, z) => total + z[key], 0);
    assert.equal(sum('primaries') + r.censored.primaries, 3);
    assert.equal(sum('pieces') + r.censored.pieces, 6);
    assert.equal(sum('mass') + r.censored.mass + r.discardedMass, 180);
    assert.deepEqual(plain(r.closure), { primariesOk: true, piecesOk: true, massOk: true, massResidual: 0 });
});

test('P12-A summarize: el cierre de masa detecta la masa descartada omitida', () => {
    const BR = load();
    const leaves = [leaf(1, 12, { mass: 96 })];
    const bad = BR.summarize({ primaries: leaves, leaves, discardedMass: 0, releasedMass: 100, geometry: geometry() });
    assert.equal(bad.ok, true);
    assert.equal(bad.closure.massOk, false);
    assert.equal(bad.closure.massResidual, 4);
    assert.equal(bad.closure.piecesOk, true);
    const good = BR.summarize({ primaries: leaves, leaves, discardedMass: 4, releasedMass: 100, geometry: geometry() });
    assert.equal(good.closure.massOk, true);
    // Tolerancia relativa de P0.4 B (1e-9): el redondeo de punto flotante no rompe el cierre.
    const parts = [0.1, 0.2, 0.3].map((mass, i) => leaf(i + 1, 12, { mass }));
    const fp = BR.summarize({ primaries: parts, leaves: parts, discardedMass: 0, releasedMass: 0.6, geometry: geometry() });
    assert.equal(fp.closure.massOk, true);
    const off = BR.summarize({ primaries: parts, leaves: parts, discardedMass: 0, releasedMass: 0.6000001, geometry: geometry() });
    assert.equal(off.closure.massOk, false);
});

test('P12-A summarize: geometría inválida da ok:false con motivo', () => {
    const BR = load();
    const args = g => ({ primaries: [], leaves: [], discardedMass: 0, releasedMass: 0, geometry: g });
    const bench = (crestX, toeX) => ({ crestX, crestY: 0, toeX, toeY: 0 });
    const invalid = [
        ['ausente', null],
        ['sin benchMeta', geometry({ benchMeta: undefined })],
        ['benchMeta vacío', geometry({ benchMeta: [] })],
        ['cresta = pata', geometry({ benchMeta: [bench(10, 10)] })],
        ['cresta > pata en u', geometry({ benchMeta: [bench(14, 10)] })],
        ['cresta > pata en u, s = −1', mirrored({ benchMeta: [bench(46, 50)] })],
        ['cresta NaN', geometry({ benchMeta: [bench(NaN, 14)] })],
        ['pata infinita', geometry({ benchMeta: [bench(10, Infinity)] })],
        ['pata como texto', geometry({ benchMeta: [bench(10, '14')] })],
        ['banco nulo', geometry({ benchMeta: [null] })],
        ['bancos desordenados', geometry({ benchMeta: [bench(20, 24), bench(10, 14)] })],
        ['bancos solapados', geometry({ benchMeta: [bench(10, 14), bench(13, 24)] })],
        ['sentido 0', geometry({ downhillSign: 0 })],
        ['sentido ausente', geometry({ downhillSign: undefined })],
        ['extremo NaN', geometry({ profileMinX: NaN })],
        ['extremos invertidos', geometry({ profileMinX: 60, profileMaxX: 0 })]
    ];
    for (const [label, g] of invalid) {
        const r = BR.summarize(args(g));
        assert.equal(r.ok, false, label);
        assert.equal(typeof r.reason, 'string', label);
        assert.ok(r.reason.length > 0, label);
        assert.deepEqual(Object.keys(plain(r)).sort(), ['ok', 'reason'], label);
    }
    // El mismo criterio en ambos sentidos: la reflejada válida sí pasa.
    assert.equal(BR.summarize(args(mirrored())).ok, true);
});

test('P12-A summarize: hojas no clasificables dan ok:false en vez de perderse', () => {
    const BR = load();
    const run = leaves => BR.summarize({ primaries: leaves, leaves, discardedMass: 0, releasedMass: 1, geometry: geometry() });
    for (const [label, l] of [
        ['finalX NaN en reposo', leaf(1, NaN)],
        ['releaseX NaN en reposo', leaf(1, 12, { releaseX: NaN })],
        ['motivo desconocido', leaf(1, 12, { stopReason: 'fragmented' })],
        ['motivo nulo', leaf(1, 12, { stopReason: null })],
        ['culled sin límite', leaf(1, 12, { stopReason: 'culled', cullBoundary: null })],
        ['masa NaN', leaf(1, 12, { mass: NaN })],
        ['masa negativa', leaf(1, 12, { mass: -1 })]
    ]) {
        const r = run([l]);
        assert.equal(r.ok, false, label);
        assert.ok(typeof r.reason === 'string' && r.reason.length > 0, label);
    }
    // Una censurada no necesita posición finita.
    assert.equal(run([leaf(1, NaN, { stopReason: 'maxTime', releaseX: NaN })]).ok, true);
    // Entradas que no son listas, o masas globales inválidas.
    assert.equal(BR.summarize({ primaries: null, leaves: [], discardedMass: 0, releasedMass: 0, geometry: geometry() }).ok, false);
    assert.equal(BR.summarize({ primaries: [], leaves: [], discardedMass: NaN, releasedMass: 0, geometry: geometry() }).ok, false);
    assert.equal(BR.summarize({ primaries: [], leaves: [], discardedMass: 0, releasedMass: -1, geometry: geometry() }).ok, false);
    assert.equal(BR.summarize().ok, false);
    // Identificadores de hoja repetidos: perLeaf perdería una fila.
    assert.equal(run([leaf(1, 12), leaf(1, 17)]).ok, false);
});

test('P12-A pureza: sin Math.random, sin document y sin modificar las entradas', () => {
    const ctx = loadScripts([FILE], { env: 'node' });
    assert.equal(typeof ctx.document, 'undefined');
    assert.equal(typeof ctx.window, 'undefined');
    vm.runInContext('Math.random = () => { throw new Error(\'Math.random prohibido\'); };', ctx);
    assert.throws(() => vm.runInContext('Math.random()', ctx), /prohibido/);
    const BR = ctx.SimRocas.BenchRetention;
    assert.deepEqual(Object.keys(BR).sort(), ['classify', 'summarize']);
    const leaves = POSITIONS.map(([x], i) => leaf(i + 1, x, { mass: i + 1 }))
        .concat([leaf(99, 17, { stopReason: 'culled', cullBoundary: 'minY', mass: 2 })]);
    const input = deepFreeze({ primaries: leaves.map(l => ({ ...l })), leaves, discardedMass: 1, releasedMass: 108,
        geometry: geometry() });
    const before = JSON.stringify(input);
    const first = BR.summarize(input);
    const second = BR.summarize(input);
    assert.equal(first.ok, true);
    assert.equal(JSON.stringify(input), before);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(plain(first.closure), { primariesOk: true, piecesOk: true, massOk: true, massResidual: 0 });
    // Sin estado: el resultado no comparte objetos con la entrada ni entre llamadas.
    first.zones[0].pieces = 999;
    assert.equal(BR.summarize(input).zones[0].pieces, second.zones[0].pieces);
    // El fuente no nombra la página ni el azar.
    const source = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
    for (const banned of ['document', 'window', 'Math.random', 'Date.now', 'localStorage']) {
        assert.ok(!source.includes(banned), `el módulo no debe usar ${banned}`);
    }
});
