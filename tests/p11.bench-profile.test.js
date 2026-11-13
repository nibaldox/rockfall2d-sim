'use strict';

/**
 * P1.1 (paquete A) — SimRocas.BenchProfile: generador y medidor puro de
 * perfiles banco–berma (CONTRATO_P11 §2, definiciones de M8 §8).
 *
 * Convención: descenso hacia +X, bancos numerados desde arriba (1…N).
 *   b = H / tan α;  x0 = startX + topPlatform
 *   cresta_i = (x0 + (i−1)(b + W), z0 + (N−i+1)·H)
 *   pata_i   = (cresta_i.x + b,     cresta_i.y − H)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, createContext, runScript, loadScripts } = require('./helpers/load');

const FILE = 'js/bench-profile.js';
const THRESHOLDS = { bermSlopeDeg: 5, bermToleranceY: 0.05 };

function load() {
    return loadScripts([FILE], { env: 'node' }).SimRocas.BenchProfile;
}

// Los objetos vienen de otro contexto vm: se comparan por valor.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function near(actual, expected, label) {
    const tol = 1e-9 * Math.max(1, Math.abs(expected));
    assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);
}

const CASES = [
    { benches: 1, benchHeight: 12.5, faceAngleDeg: 63, bermWidth: 7, baseElevation: 2400 },
    { benches: 3, benchHeight: 10, faceAngleDeg: 70, bermWidth: 6.5, baseElevation: 0,
        topPlatform: 15, floorLength: 40, startX: 5 },
    { benches: 10, benchHeight: 15, faceAngleDeg: 75, bermWidth: 8.25, baseElevation: -120.5,
        topPlatform: 8, floorLength: 25, startX: -30 }
];

for (const p of CASES) {
    test(`oráculo geométrico N=${p.benches}, H=${p.benchHeight}, α=${p.faceAngleDeg}, W=${p.bermWidth}`, () => {
        const BP = load();
        const r = BP.generate(p);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.schemaVersion, 'bench-profile.v1');

        const N = p.benches;
        const H = p.benchHeight;
        const W = p.bermWidth;
        const top = p.topPlatform === undefined ? 20 : p.topPlatform;
        const floor = p.floorLength === undefined ? 30 : p.floorLength;
        const startX = p.startX === undefined ? 0 : p.startX;
        const z0 = p.baseElevation;
        const b = H / Math.tan(p.faceAngleDeg * Math.PI / 180);
        const x0 = startX + top;

        // Cantidad de vértices y de tramos.
        assert.equal(r.points.length, 2 * N + 2);
        assert.equal(r.roles.length, r.points.length - 1);
        assert.equal(r.benchMeta.length, N);

        // Extremos y caída total.
        near(r.points[0].x, startX, 'inicio x');
        near(r.points[0].y, z0 + N * H, 'inicio y');
        const last = r.points[r.points.length - 1];
        near(last.y, z0, 'piso y');
        near(r.points[0].y - last.y, N * H, 'caída total');
        near(last.x, x0 + N * b + (N - 1) * W + floor, 'fin de piso x');

        // Crestas y patas: en los vértices y en benchMeta.
        for (let i = 1; i <= N; i++) {
            const cx = x0 + (i - 1) * (b + W);
            const cy = z0 + (N - i + 1) * H;
            const crest = r.points[2 * i - 1];
            const toe = r.points[2 * i];
            near(crest.x, cx, `cresta ${i} x`);
            near(crest.y, cy, `cresta ${i} y`);
            near(toe.x, cx + b, `pata ${i} x`);
            near(toe.y, cy - H, `pata ${i} y`);

            const m = r.benchMeta[i - 1];
            assert.equal(m.index, i);
            assert.equal(m.crestX, crest.x);
            assert.equal(m.crestY, crest.y);
            assert.equal(m.toeX, toe.x);
            assert.equal(m.toeY, toe.y);
            assert.equal(m.height, H);
            assert.equal(m.faceAngleDeg, p.faceAngleDeg);
            assert.equal(m.bermStartX, toe.x);
            assert.equal(m.bermEndX, r.points[2 * i + 1].x);
            if (i < N) {
                assert.equal(m.nominalWidth, W);
                near(m.effectiveWidth, W, `ancho efectivo ${i}`);
            }
        }
        near(r.benchMeta[N - 1].toeX - r.benchMeta[0].crestX, N * b + (N - 1) * W, 'pata N − cresta 1');

        // Roles por tramo.
        const expected = ['platform'];
        for (let i = 1; i <= N; i++) {
            expected.push('face');
            if (i < N) expected.push('berm');
        }
        expected.push('floor');
        assert.deepEqual(plain(r.roles), expected);

        // Parámetros normalizados, con los valores por defecto aplicados.
        assert.deepEqual(plain(r.params), {
            benches: N, benchHeight: H, faceAngleDeg: p.faceAngleDeg, bermWidth: W,
            baseElevation: z0, topPlatform: top, floorLength: floor, startX
        });
    });

    test(`measure(generate) recupera H, α y W (N=${p.benches})`, () => {
        const BP = load();
        const g = BP.generate(p);
        const m = BP.measure(g.points, THRESHOLDS);
        assert.equal(m.ok, true, m.error);
        assert.equal(m.benchMeta.length, p.benches);
        m.benchMeta.forEach((bench, k) => {
            const ref = g.benchMeta[k];
            assert.equal(bench.index, k + 1);
            near(bench.height, p.benchHeight, `H medido ${k + 1}`);
            near(bench.faceAngleDeg, p.faceAngleDeg, `α medido ${k + 1}`);
            near(bench.crestX, ref.crestX, 'cresta x');
            near(bench.crestY, ref.crestY, 'cresta y');
            near(bench.toeX, ref.toeX, 'pata x');
            near(bench.toeY, ref.toeY, 'pata y');
            near(bench.effectiveWidth, ref.effectiveWidth, `W medido ${k + 1}`);
            if (k < p.benches - 1) near(bench.effectiveWidth, p.bermWidth, `W medido ${k + 1}`);
            near(bench.bermEndX, ref.bermEndX, 'fin de berma');
            // P1.2 §3: el ancho nominal medido va de la pata a la cresta siguiente;
            // solo el último banco queda en null.
            if (k < p.benches - 1) near(bench.nominalWidth, p.bermWidth, `W nominal ${k + 1}`);
            else assert.equal(bench.nominalWidth, null, 'último banco: sin ancho nominal');
        });
    });

    test(`X estrictamente creciente (N=${p.benches})`, () => {
        const g = load().generate(p);
        for (let i = 1; i < g.points.length; i++) {
            assert.ok(g.points[i].x > g.points[i - 1].x, `x[${i}]`);
        }
    });
}

test('W = 0: se omiten los vértices duplicados y la berma mide 0', () => {
    const BP = load();
    const p = { benches: 4, benchHeight: 9, faceAngleDeg: 55, bermWidth: 0, baseElevation: 100 };
    const g = BP.generate(p);
    assert.equal(g.ok, true, g.error);
    const N = 4;
    assert.equal(g.points.length, 2 * N + 2 - (N - 1));
    assert.deepEqual(plain(g.roles), ['platform', 'face', 'face', 'face', 'face', 'floor']);
    for (let i = 1; i < g.points.length; i++) {
        assert.ok(g.points[i].x > g.points[i - 1].x, `x[${i}] duplicada`);
    }
    near(g.points[0].y - g.points[g.points.length - 1].y, N * 9, 'caída total');
    for (let k = 0; k < N - 1; k++) {
        assert.equal(g.benchMeta[k].nominalWidth, 0);
        assert.equal(g.benchMeta[k].effectiveWidth, 0);
        assert.equal(g.benchMeta[k].bermEndX, g.benchMeta[k].bermStartX);
        // La pata i y la cresta i+1 son el mismo vértice.
        assert.equal(g.benchMeta[k].toeX, g.benchMeta[k + 1].crestX);
        assert.equal(g.benchMeta[k].toeY, g.benchMeta[k + 1].crestY);
    }
    const m = BP.measure(g.points, THRESHOLDS);
    assert.equal(m.ok, true, m.error);
    // P1.2 §3: una cara es una cadena maximal de tramos de bajada. Con W = 0
    // las N caras son contiguas y colineales: se miden como una sola de N·H.
    assert.equal(m.benchMeta.length, 1);
    near(m.benchMeta[0].height, N * 9, 'H medido');
    near(m.benchMeta[0].faceAngleDeg, 55, 'α medido');
    near(m.benchMeta[0].crestX, g.benchMeta[0].crestX, 'cresta');
    near(m.benchMeta[0].toeX, g.benchMeta[N - 1].toeX, 'pata');
});

test('plataforma y piso de largo 0 no dejan vértices duplicados', () => {
    const g = load().generate({ benches: 2, benchHeight: 10, faceAngleDeg: 60, bermWidth: 5,
        baseElevation: 0, topPlatform: 0, floorLength: 0 });
    assert.equal(g.ok, true, g.error);
    assert.equal(g.points.length, 4);
    assert.deepEqual(plain(g.roles), ['face', 'berm', 'face']);
    for (let i = 1; i < g.points.length; i++) assert.ok(g.points[i].x > g.points[i - 1].x);
});

test('entradas inválidas: ok:false con motivo en español y sin perfil parcial', () => {
    const BP = load();
    const base = { benches: 3, benchHeight: 10, faceAngleDeg: 70, bermWidth: 6, baseElevation: 0 };
    const bad = [
        ['N NaN', { benches: NaN }, /bancos/],
        ['N = 0', { benches: 0 }, /bancos/],
        ['N = 1.5', { benches: 1.5 }, /bancos/],
        ['N = 51', { benches: 51 }, /bancos/],
        ['H = 0', { benchHeight: 0 }, /altura/],
        ['H < 0', { benchHeight: -3 }, /altura/],
        ['H NaN', { benchHeight: NaN }, /altura/],
        ['α = 0', { faceAngleDeg: 0 }, /ángulo/],
        ['α = 90', { faceAngleDeg: 90 }, /ángulo/],
        ['α NaN', { faceAngleDeg: NaN }, /ángulo/],
        ['W < 0', { bermWidth: -0.1 }, /berma/],
        ['W NaN', { bermWidth: NaN }, /berma/],
        ['z0 infinita', { baseElevation: Infinity }, /cota base/],
        ['z0 ausente', { baseElevation: undefined }, /cota base/],
        ['plataforma < 0', { topPlatform: -1 }, /plataforma/],
        ['piso NaN', { floorLength: NaN }, /piso/],
        ['startX infinita', { startX: -Infinity }, /X inicial/],
        ['N texto', { benches: '3' }, /bancos/]
    ];
    for (const [label, patch, reason] of bad) {
        const r = BP.generate({ ...base, ...patch });
        assert.equal(r.ok, false, label);
        assert.equal(typeof r.error, 'string', label);
        assert.match(r.error, reason, label);
        assert.equal(r.points, undefined, label);
        assert.equal(r.benchMeta, undefined, label);
    }
    for (const params of [undefined, null, 7, 'x']) {
        const r = BP.generate(params);
        assert.equal(r.ok, false);
        assert.match(r.error, /parámetros/);
    }
    // La base, sin parches, sí es válida.
    assert.equal(BP.generate(base).ok, true);
});

test('measure sin umbrales deja effectiveWidth en null, nunca 0', () => {
    const BP = load();
    const g = BP.generate(CASES[1]);
    for (const opts of [undefined, {}, { bermSlopeDeg: 5 }, { bermToleranceY: 0.05 }]) {
        const m = BP.measure(g.points, opts);
        assert.equal(m.ok, true, m.error);
        assert.equal(m.benchMeta.length, 3);
        for (const bench of m.benchMeta) {
            assert.equal(bench.effectiveWidth, null);
            assert.equal(bench.bermEndX, null);
            near(bench.height, 10, 'H sin umbrales');
            near(bench.faceAngleDeg, 70, 'α sin umbrales');
        }
    }
});

test('measure rechaza polilíneas y umbrales inválidos', () => {
    const BP = load();
    const bad = [
        [null, THRESHOLDS, /puntos/],
        [[{ x: 0, y: 1 }], THRESHOLDS, /2 puntos/],
        [[{ x: 0, y: 1 }, { x: NaN, y: 0 }], THRESHOLDS, /punto 2/],
        [[{ x: 0, y: 1 }, { x: 0, y: 0 }], THRESHOLDS, /creciente/],
        [[{ x: 0, y: 1 }, { x: 5, y: 0 }], { bermSlopeDeg: -1, bermToleranceY: 0.1 }, /umbral/],
        [[{ x: 0, y: 1 }, { x: 5, y: 0 }], { bermSlopeDeg: 5, bermToleranceY: NaN }, /umbral/]
    ];
    for (const [points, opts, reason] of bad) {
        const m = BP.measure(points, opts);
        assert.equal(m.ok, false);
        assert.match(m.error, reason);
        assert.equal(m.benchMeta, undefined);
    }
});

test('measure sobre una polilínea ajena: la berma se corta por pendiente y por cota', () => {
    const BP = load();
    // Cara 10 m a 45°, berma de 4 m plana + 3 m con 0.02 m de caída, luego un
    // tramo de 2 m que baja 1 m (fuera de umbral) y otra cara.
    const pts = [
        { x: 0, y: 20 }, { x: 10, y: 20 }, { x: 20, y: 10 }, { x: 24, y: 10 },
        { x: 27, y: 9.98 }, { x: 29, y: 8.98 }, { x: 39, y: -1.02 }, { x: 60, y: -1.02 }
    ];
    const m = BP.measure(pts, { bermSlopeDeg: 5, bermToleranceY: 0.05 });
    assert.equal(m.ok, true, m.error);
    const first = m.benchMeta[0];
    near(first.height, 10, 'H');
    near(first.faceAngleDeg, 45, 'α');
    near(first.effectiveWidth, 7, 'ancho efectivo');
    near(first.bermEndX, 27, 'fin de berma');
    // Con tolerancia de cota más estricta, el segundo tramo de berma queda fuera.
    const strict = BP.measure(pts, { bermSlopeDeg: 5, bermToleranceY: 0.01 });
    near(strict.benchMeta[0].effectiveWidth, 4, 'ancho efectivo estricto');
});

test('pureza: mismas entradas, mismos resultados; no usa Math.random ni muta la entrada', () => {
    const context = createContext({ env: 'node' });
    vm.runInContext(
        'var randomCalls = 0; Math.random = function () { randomCalls++; throw new Error(\'Math.random prohibido\'); };',
        context
    );
    runScript(context, FILE);
    const BP = context.SimRocas.BenchProfile;
    const p = { ...CASES[2] };
    const frozen = Object.freeze({ ...p });
    const a = BP.generate(frozen);
    const b = BP.generate(frozen);
    assert.equal(a.ok, true, a.error);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.notEqual(a.points, b.points, 'cada llamada entrega arreglos propios');
    assert.deepEqual({ ...frozen }, p);

    const snapshot = JSON.stringify(a.points);
    const m1 = BP.measure(a.points, THRESHOLDS);
    const m2 = BP.measure(a.points, THRESHOLDS);
    assert.equal(JSON.stringify(m1), JSON.stringify(m2));
    assert.equal(JSON.stringify(a.points), snapshot, 'measure no muta los puntos');
    // Mutar una salida no afecta a la siguiente llamada (sin estado).
    a.points[0].x = 999;
    a.benchMeta[0].height = -1;
    assert.equal(JSON.stringify(BP.generate(frozen)), JSON.stringify(b));
    assert.equal(vm.runInContext('randomCalls', context), 0);
});

test('fuente: sin DOM, sin azar y carga también sin window ni self', () => {
    const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
    for (const banned of ['Math.random', 'document', 'window', 'localStorage', 'Date.now', 'performance']) {
        assert.ok(!src.includes(banned), `no debe mencionar ${banned}`);
    }
    for (const env of ['node', 'browser', 'worker']) {
        const BP = loadScripts([FILE], { env }).SimRocas.BenchProfile;
        assert.equal(typeof BP.generate, 'function');
        assert.equal(typeof BP.measure, 'function');
    }
    // No pisa un namespace existente.
    const ctx = loadScripts([FILE], { env: 'node', extra: { SimRocas: { Keep: 1 } } });
    assert.equal(ctx.SimRocas.Keep, 1);
    assert.equal(typeof ctx.SimRocas.BenchProfile.generate, 'function');
});
