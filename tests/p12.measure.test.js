'use strict';

/**
 * P1.2 (paquete M) — SimRocas.BenchProfile.measure v2 (CONTRATO_P12 §3).
 *
 * Cara = cadena maximal de tramos con pendiente de bajada mayor que
 * bermSlopeDeg; las cadenas con caída menor que minFaceHeight no son cara.
 * El sentido de bajada se decide por la cota de los extremos (umbral 0,5 m).
 * `generate` debe quedar idéntico a la base 841fe984 (I-B).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { ROOT, loadScripts } = require('./helpers/load');

const FILE = 'js/bench-profile.js';
const BASE_REF = '841fe984534aad3d2f5b239fab17933be63c9ebb';
const U6 = { bermSlopeDeg: 5, bermToleranceY: 0.5, minFaceHeight: 1.0 };

function load() {
    return loadScripts([FILE], { env: 'node' }).SimRocas.BenchProfile;
}

// La base se extrae de git a scratch (nunca se compara contra HEAD).
function baseSource() {
    const dir = path.join(os.tmpdir(), 'P12M');
    const file = path.join(dir, 'bench-profile.base.js');
    if (!fs.existsSync(file)) {
        fs.mkdirSync(dir, { recursive: true });
        const src = execFileSync('git', ['show', `${BASE_REF}:${FILE}`], {
            cwd: ROOT, env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
        });
        fs.writeFileSync(file, src);
    }
    return fs.readFileSync(file, 'utf8');
}

function loadBase() {
    const context = vm.createContext({ console });
    vm.runInContext(baseSource(), context, { filename: 'bench-profile.base.js' });
    return context.SimRocas.BenchProfile;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function near(actual, expected, label, tol = 1e-9) {
    const t = tol * Math.max(1, Math.abs(expected));
    assert.ok(Math.abs(actual - expected) <= t, `${label}: ${actual} vs ${expected}`);
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function reflect(points) {
    return points.map((pt) => ({ x: -pt.x, y: pt.y })).reverse();
}

// ---------------------------------------------------------------- generate

function generateBattery() {
    const rnd = mulberry32(1202);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const battery = [];
    for (let i = 0; i < 160; i++) {
        const p = {
            benches: 1 + Math.floor(rnd() * 50),
            benchHeight: 0.5 + rnd() * 29.5,
            faceAngleDeg: 1 + rnd() * 88,
            bermWidth: rnd() < 0.2 ? 0 : rnd() * 20,
            baseElevation: (rnd() - 0.5) * 9000
        };
        if (rnd() < 0.5) p.topPlatform = rnd() < 0.3 ? 0 : rnd() * 50;
        if (rnd() < 0.5) p.floorLength = rnd() < 0.3 ? 0 : rnd() * 80;
        if (rnd() < 0.5) p.startX = (rnd() - 0.5) * 2000;
        battery.push(p);
    }
    const base = { benches: 3, benchHeight: 10, faceAngleDeg: 70, bermWidth: 6, baseElevation: 0 };
    const badValues = [NaN, Infinity, -Infinity, -1, 0, 1.5, 51, 90, 1e-9, 1e-7, 1e300, '3', null,
        undefined, true, {}, []];
    const keys = ['benches', 'benchHeight', 'faceAngleDeg', 'bermWidth', 'baseElevation',
        'topPlatform', 'floorLength', 'startX'];
    for (const key of keys) {
        for (const value of badValues) battery.push({ ...base, [key]: value });
    }
    for (let i = 0; i < 40; i++) {
        battery.push({ ...base, [pick(keys)]: pick(badValues), [pick(keys)]: pick(badValues) });
    }
    battery.push(undefined, null, 7, 'x', [], {}, () => 1,
        { ...base, faceAngleDeg: 89.9999999999 }, { ...base, startX: 1e18 },
        { ...base, baseElevation: 1e308, benchHeight: 1e308 });
    return battery;
}

test('I-B: generate es idéntico a 841fe984 por JSON.stringify (válidas e inválidas)', () => {
    const base = loadBase();
    const current = load();
    const battery = generateBattery();
    assert.ok(battery.length >= 200, `batería de ${battery.length}`);
    let valid = 0;
    let invalid = 0;
    battery.forEach((params, k) => {
        const expected = base.generate(params);
        const actual = current.generate(params);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected), `entrada ${k}`);
        if (expected.ok) valid++; else invalid++;
    });
    assert.ok(valid >= 100, `válidas: ${valid}`);
    assert.ok(invalid >= 100, `inválidas: ${invalid}`);
});

test('I-B: el código anterior a measure no cambia un solo byte', () => {
    const marker = '    function readThreshold(';
    const baseSrc = baseSource();
    const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
    assert.ok(baseSrc.includes(marker) && src.includes(marker));
    assert.equal(src.slice(0, src.indexOf(marker)), baseSrc.slice(0, baseSrc.indexOf(marker)));
});

// ----------------------------------------------------------------- salida

test('salida v2: claves, esquema, sentido y umbrales', () => {
    const BP = load();
    const g = BP.generate({ benches: 2, benchHeight: 10, faceAngleDeg: 60, bermWidth: 5, baseElevation: 0 });
    const m = BP.measure(g.points, U6);
    assert.equal(m.ok, true, m.error);
    assert.deepEqual(Object.keys(m), ['ok', 'downhillSign', 'benchMeta', 'thresholds', 'schemaVersion']);
    assert.equal(m.schemaVersion, 'bench-measure.v2');
    assert.equal(m.downhillSign, 1);
    assert.deepEqual(plain(m.thresholds), U6);
    assert.deepEqual(Object.keys(m.benchMeta[0]), ['index', 'crestX', 'crestY', 'toeX', 'toeY', 'height',
        'faceAngleDeg', 'bermStartX', 'bermEndX', 'nominalWidth', 'effectiveWidth']);
    // Los umbrales ausentes se informan como null, no se inventan.
    const bare = BP.measure(g.points);
    assert.deepEqual(plain(bare.thresholds), { bermSlopeDeg: null, bermToleranceY: null, minFaceHeight: null });
});

// ---------------------------------------------------------------- oráculo

const ORACLE = [
    { benches: 1, benchHeight: 12.5, faceAngleDeg: 63, bermWidth: 7, baseElevation: 2400 },
    { benches: 3, benchHeight: 10, faceAngleDeg: 70, bermWidth: 6.5, baseElevation: 0,
        topPlatform: 15, floorLength: 40, startX: 5 },
    { benches: 8, benchHeight: 15, faceAngleDeg: 75, bermWidth: 9, baseElevation: -120,
        topPlatform: 0, floorLength: 25, startX: -300 },
    { benches: 5, benchHeight: 1, faceAngleDeg: 5.5, bermWidth: 0.25, baseElevation: 10 }
];

for (const p of ORACLE) {
    test(`oráculo: measure(generate) reproduce H, α y W (N=${p.benches}, α=${p.faceAngleDeg})`, () => {
        const BP = load();
        const g = BP.generate(p);
        const m = BP.measure(g.points, U6);
        assert.equal(m.ok, true, m.error);
        assert.equal(m.downhillSign, 1);
        assert.equal(m.benchMeta.length, p.benches);
        m.benchMeta.forEach((bench, k) => {
            const ref = g.benchMeta[k];
            const last = k === p.benches - 1;
            assert.equal(bench.index, k + 1);
            near(bench.height, p.benchHeight, 'H');
            near(bench.faceAngleDeg, p.faceAngleDeg, 'α');
            near(bench.crestX, ref.crestX, 'cresta x');
            near(bench.crestY, ref.crestY, 'cresta y');
            near(bench.toeX, ref.toeX, 'pata x');
            near(bench.toeY, ref.toeY, 'pata y');
            assert.equal(bench.bermStartX, bench.toeX);
            near(bench.effectiveWidth, ref.effectiveWidth, 'W efectivo');
            near(bench.bermEndX, ref.bermEndX, 'fin de berma');
            if (last) {
                assert.equal(bench.nominalWidth, null, 'último banco: sin ancho nominal');
            } else {
                near(bench.nominalWidth, p.bermWidth, 'W nominal');
                near(bench.effectiveWidth, p.bermWidth, 'W efectivo = W');
            }
        });
    });
}

test('una cara subdividida en k tramos colineales o casi colineales es UNA cara', () => {
    const BP = load();
    const p = { benches: 3, benchHeight: 12, faceAngleDeg: 65, bermWidth: 8, baseElevation: 50 };
    const g = BP.generate(p);
    const rnd = mulberry32(7);
    for (const k of [2, 5, 17]) {
        for (const jitter of [0, 0.05]) {
            const pts = [];
            for (let i = 0; i < g.points.length; i++) {
                pts.push({ ...g.points[i] });
                if (g.roles[i] !== 'face') continue;
                const a = g.points[i];
                const b = g.points[i + 1];
                for (let j = 1; j < k; j++) {
                    const t = j / k;
                    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + (rnd() - 0.5) * 2 * jitter });
                }
            }
            assert.equal(pts.length, g.points.length + 3 * (k - 1));
            const m = BP.measure(pts, U6);
            assert.equal(m.ok, true, m.error);
            assert.equal(m.benchMeta.length, 3, `k=${k}, jitter=${jitter}`);
            m.benchMeta.forEach((bench, i) => {
                near(bench.height, 12, 'H');
                near(bench.faceAngleDeg, 65, 'α de la cuerda');
                near(bench.crestX, g.benchMeta[i].crestX, 'cresta');
                near(bench.toeX, g.benchMeta[i].toeX, 'pata');
                near(bench.effectiveWidth, g.benchMeta[i].effectiveWidth, 'W efectivo');
                if (i < 2) near(bench.nominalWidth, 8, 'W nominal');
            });
        }
    }
});

test('un escalón menor que minFaceHeight no es cara: se absorbe en la berma o la plataforma', () => {
    const BP = load();
    // Plataforma con escalón de 0,4 m; cara de 10 m a 45°; berma de 12 m con
    // un escalón de 0,6 m a los 5 m; cara de 10 m; piso.
    const pts = [
        { x: 0, y: 21 }, { x: 4, y: 21 }, { x: 4.4, y: 20.6 }, { x: 10, y: 20.6 },
        { x: 20, y: 10.6 }, { x: 25, y: 10.6 }, { x: 25.6, y: 10 }, { x: 32, y: 10 },
        { x: 42, y: 0 }, { x: 70, y: 0 }
    ];
    const m = BP.measure(pts, U6);
    assert.equal(m.ok, true, m.error);
    assert.equal(m.benchMeta.length, 2);
    const [b1, b2] = m.benchMeta;
    assert.deepEqual([b1.crestX, b1.crestY, b1.toeX, b1.toeY], [10, 20.6, 20, 10.6]);
    assert.deepEqual([b2.crestX, b2.crestY, b2.toeX, b2.toeY], [32, 10, 42, 0]);
    near(b1.height, 10, 'H1');
    near(b1.faceAngleDeg, 45, 'α1');
    // El escalón queda dentro de la berma nominal (pata 1 → cresta 2)…
    near(b1.nominalWidth, 12, 'W nominal');
    // …pero corta la berma efectiva: su pendiente (45°) supera bermSlopeDeg.
    near(b1.effectiveWidth, 5, 'W efectivo');
    near(b1.bermEndX, 25, 'fin de berma');
    near(b2.effectiveWidth, 28, 'piso');
    assert.equal(b2.nominalWidth, null);

    // Con minFaceHeight menor que el escalón, el mismo escalón sí es cara.
    const fine = BP.measure(pts, { ...U6, minFaceHeight: 0.5 });
    assert.equal(fine.benchMeta.length, 3);
    near(fine.benchMeta[1].height, 0.6, 'H del escalón');
    near(fine.benchMeta[0].nominalWidth, 5, 'W nominal hasta el escalón');
    // Una caída exactamente igual a minFaceHeight sí es cara (solo «menor» se absorbe).
    const edge = BP.measure([{ x: 0, y: 1 }, { x: 5, y: 1 }, { x: 6, y: 0 }, { x: 9, y: 0 }], U6);
    assert.equal(edge.ok, true, edge.error);
    assert.equal(edge.benchMeta.length, 1);
});

test('perfil con lomas pequeñas en la berma: no inventan bancos', () => {
    const BP = load();
    // Cara 10 m a 45°; berma de 20 m con una loma suave (0,05 m en 1 m, 2,9°)
    // y una loma brusca (0,3 m en 1 m, 16,7°); cara 10 m; piso.
    const pts = [
        { x: 0, y: 20 }, { x: 10, y: 20 }, { x: 20, y: 10 },
        { x: 23, y: 10 }, { x: 24, y: 10.05 }, { x: 25, y: 10 },
        { x: 30, y: 10 }, { x: 31, y: 10.3 }, { x: 32, y: 10 },
        { x: 40, y: 10 }, { x: 50, y: 0 }, { x: 80, y: 0 }
    ];
    const m = BP.measure(pts, U6);
    assert.equal(m.ok, true, m.error);
    assert.equal(m.benchMeta.length, 2, 'las lomas no son caras');
    const b1 = m.benchMeta[0];
    assert.deepEqual([b1.crestX, b1.toeX], [10, 20]);
    near(b1.height, 10, 'H');
    near(b1.nominalWidth, 20, 'W nominal: pata 1 → cresta 2');
    // La loma suave cumple los umbrales; la brusca corta la berma efectiva.
    near(b1.effectiveWidth, 10, 'W efectivo');
    near(b1.bermEndX, 30, 'fin de berma');
    assert.deepEqual([m.benchMeta[1].crestX, m.benchMeta[1].toeX], [40, 50]);
    // Con un umbral de pendiente más holgado, la berma efectiva cubre toda la berma.
    const loose = BP.measure(pts, { ...U6, bermSlopeDeg: 20 });
    assert.equal(loose.benchMeta.length, 2);
    near(loose.benchMeta[0].effectiveWidth, 20, 'W efectivo holgado');
    // La tolerancia de cota también corta: con 0,2 m la loma de 0,3 m queda fuera.
    const tight = BP.measure(pts, { bermSlopeDeg: 20, bermToleranceY: 0.2, minFaceHeight: 1 });
    near(tight.benchMeta[0].effectiveWidth, 10, 'W efectivo con cota estricta');
});

// ---------------------------------------------------------------- sentido

test('reflexión: el perfil reflejado da los mismos benchMeta reflejados', () => {
    const BP = load();
    const profiles = ORACLE.map((p) => BP.generate(p).points);
    profiles.push([
        { x: 0, y: 21 }, { x: 4, y: 21 }, { x: 4.4, y: 20.6 }, { x: 10, y: 20.6 },
        { x: 20, y: 10.6 }, { x: 25, y: 10.6 }, { x: 25.6, y: 10 }, { x: 32, y: 10 },
        { x: 42, y: 0 }, { x: 70, y: 0 }
    ]);
    for (const pts of profiles) {
        const mirrored = reflect(pts);
        const snapshot = JSON.stringify(mirrored);
        const a = BP.measure(pts, U6);
        const b = BP.measure(mirrored, U6);
        assert.equal(JSON.stringify(mirrored), snapshot, 'measure no muta los puntos');
        assert.equal(a.ok, true, a.error);
        assert.equal(b.ok, true, b.error);
        assert.equal(a.downhillSign, 1);
        assert.equal(b.downhillSign, -1);
        assert.equal(b.schemaVersion, 'bench-measure.v2');
        const expected = a.benchMeta.map((bench) => ({
            ...bench,
            crestX: -bench.crestX,
            toeX: -bench.toeX,
            bermStartX: -bench.bermStartX,
            bermEndX: -bench.bermEndX
        }));
        // JSON.stringify iguala −0 y 0.
        assert.equal(JSON.stringify(b.benchMeta), JSON.stringify(expected));
        // Bancos numerados desde arriba y anchos siempre positivos.
        b.benchMeta.forEach((bench, k) => {
            assert.equal(bench.index, k + 1);
            assert.ok(bench.crestX > bench.toeX, 'con s = −1 la cresta queda a la derecha de la pata');
            assert.ok(bench.bermEndX <= bench.toeX);
            assert.ok(bench.effectiveWidth >= 0);
            if (k > 0) assert.ok(bench.crestY < b.benchMeta[k - 1].crestY);
        });
    }
});

test('sentido por cota con umbral de 0,5 m; si no se resuelve, ok:false', () => {
    const BP = load();
    const face = (yLeft, yRight) => [{ x: 0, y: yLeft }, { x: 5, y: yLeft }, { x: 6, y: yRight }, { x: 12, y: yRight }];
    assert.equal(BP.measure(face(10, 9.5), { ...U6, minFaceHeight: 0.1 }).downhillSign, 1);
    assert.equal(BP.measure(face(9.5, 10), { ...U6, minFaceHeight: 0.1 }).downhillSign, -1);
    const unresolved = [
        face(10, 9.51),
        face(9.51, 10),
        [{ x: 0, y: 5 }, { x: 10, y: 5 }],
        // Valle: hay caras, pero los extremos están a la misma cota.
        [{ x: 0, y: 10 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 15, y: 10 }]
    ];
    for (const pts of unresolved) {
        const m = BP.measure(pts, U6);
        assert.equal(m.ok, false);
        assert.match(m.error, /sentido de bajada no resuelto/);
        assert.equal(m.benchMeta, undefined);
        assert.equal(m.downhillSign, undefined);
    }
});

test('sin ninguna cara: ok:false con motivo en español', () => {
    const BP = load();
    const cases = [
        // Rampa de 4°: nunca supera bermSlopeDeg.
        [{ x: 0, y: 7 }, { x: 100, y: 0 }],
        // Escalones de 0,9 m, todos menores que minFaceHeight.
        [{ x: 0, y: 1.8 }, { x: 5, y: 1.8 }, { x: 6, y: 0.9 }, { x: 11, y: 0.9 }, { x: 12, y: 0 }, { x: 20, y: 0 }]
    ];
    for (const pts of cases) {
        const m = BP.measure(pts, U6);
        assert.equal(m.ok, false);
        assert.equal(typeof m.error, 'string');
        assert.match(m.error, /ninguna cara/);
        assert.equal(m.benchMeta, undefined);
    }
});

test('umbral minFaceHeight inválido: ok:false', () => {
    const BP = load();
    const pts = [{ x: 0, y: 10 }, { x: 5, y: 0 }];
    for (const bad of [-1, NaN, Infinity, '1']) {
        const m = BP.measure(pts, { ...U6, minFaceHeight: bad });
        assert.equal(m.ok, false);
        assert.match(m.error, /umbral/);
        assert.match(m.error, /minFaceHeight/);
    }
});

test('pureza: determinista, sin estado y sin mutar puntos ni opciones', () => {
    const BP = load();
    const g = BP.generate(ORACLE[1]);
    const pts = Object.freeze(g.points.map((pt) => Object.freeze({ ...pt })));
    const opts = Object.freeze({ ...U6 });
    const a = BP.measure(pts, opts);
    a.benchMeta[0].height = -1;
    a.thresholds.minFaceHeight = 99;
    const b = BP.measure(pts, opts);
    const c = BP.measure(pts, opts);
    assert.equal(JSON.stringify(b), JSON.stringify(c));
    near(b.benchMeta[0].height, 10, 'sin estado');
    assert.equal(b.thresholds.minFaceHeight, 1);
});
