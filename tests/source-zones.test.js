'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function load() {
    const ctx = loadScripts(['js/source-zones.js'], { env: 'worker' });
    return ctx.SimRocas.SourceZones;
}

// PRNG mulberry32 simple, determinista, para tests.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const RECT = {
    id: 'rect',
    type: 'polygon',
    vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 1 },
        { x: 0, y: 1 },
    ],
};

// L cóncava 2x2 menos el cuadrado [1,2]x[1,2] (notch): área 3.
const L_ZONE = {
    id: 'L',
    type: 'polygon',
    vertices: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
    ],
};

test('área: cuadrado, triángulo y L cóncava (shoelace, valor absoluto, sentido indiferente)', () => {
    const SZ = load();
    assert.equal(SZ.area(RECT), 10);
    assert.equal(SZ.area(L_ZONE), 3);
    // triángulo 3-4-5 → área 6
    const tri = {
        id: 'tri',
        type: 'polygon',
        vertices: [
            { x: 0, y: 0 },
            { x: 3, y: 0 },
            { x: 0, y: 4 },
        ],
    };
    assert.equal(SZ.area(tri), 6);
    // mismo polígono recorriéndolo en sentido horario → misma área (absoluta)
    const rectCW = {
        id: 'rectCW',
        type: 'polygon',
        vertices: [...RECT.vertices].reverse(),
    };
    assert.equal(SZ.area(rectCW), 10);
});

test('contains: dentro, fuera y borde cuenta como dentro', () => {
    const SZ = load();
    // dentro / fuera en la L
    assert.equal(SZ.contains(L_ZONE, 0.5, 0.5), true);
    assert.equal(SZ.contains(L_ZONE, 0.5, 1.5), true);
    assert.equal(SZ.contains(L_ZONE, 1.5, 1.5), false); // notch
    assert.equal(SZ.contains(L_ZONE, -0.1, 2), false);
    assert.equal(SZ.contains(L_ZONE, 2.1, 0.5), false);
    // bordes
    assert.equal(SZ.contains(RECT, 0, 0), true);      // vértice
    assert.equal(SZ.contains(RECT, 5, 0), true);      // borde sur
    assert.equal(SZ.contains(RECT, 10, 1), true);     // vértice opuesto
    assert.equal(SZ.contains(RECT, 0, 0.5), true);    // borde oeste
    assert.equal(SZ.contains(RECT, 10, 0.5), true);   // borde este
    // borde del notch
    assert.equal(SZ.contains(L_ZONE, 1, 1.5), true);
    assert.equal(SZ.contains(L_ZONE, 1.5, 1), true);
});

test('sample uniforme en rectángulo 10x1: medias y fracción por mitades dentro de 3σ', () => {
    const SZ = load();
    const n = 10000;
    const samples = SZ.sample(RECT, n, mulberry32(1234));
    assert.equal(samples.length, n);
    let sumX = 0;
    let sumY = 0;
    let left = 0;
    let bottom = 0;
    let fuera = 0;
    for (const p of samples) {
        sumX += p.x;
        sumY += p.y;
        if (p.x < 5) { left++; }
        if (p.y < 0.5) { bottom++; }
        if (!(p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 1)) { fuera++; }
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    // σ media X = 10/sqrt(12)/sqrt(n) ≈ 0.0289 → 3σ ≈ 0.0866
    assert.ok(Math.abs(meanX - 5) <= 0.09, `meanX=${meanX} fuera de 5±0.09`);
    // σ media Y = 1/sqrt(12)/sqrt(n) ≈ 0.00289 → 3σ ≈ 0.0087
    assert.ok(Math.abs(meanY - 0.5) <= 0.01, `meanY=${meanY} fuera de 0.5±0.01`);
    // σ binomial (n=10000, p=0.5) = 0.005 → 3σ = 0.015
    assert.ok(Math.abs(left / n - 0.5) <= 0.016, `fracción x<5 = ${left / n}`);
    assert.ok(Math.abs(bottom / n - 0.5) <= 0.016, `fracción y<0.5 = ${bottom / n}`);
    assert.equal(fuera, 0);
});

test('sample en L cóncava (rechazo en bbox): ninguna muestra fuera del polígono', () => {
    const SZ = load();
    const n = 10000;
    const samples = SZ.sample(L_ZONE, n, mulberry32(7));
    assert.equal(samples.length, n);
    for (const p of samples) {
        assert.equal(
            SZ.contains(L_ZONE, p.x, p.y),
            true,
            `muestra (${p.x}, ${p.y}) cae fuera de la L`
        );
    }
});

test('sample con zona puntual repite el punto; distribute pondera puntos con 1 m²', () => {
    const SZ = load();
    const point = { id: 'pt', type: 'point', x: 3, y: 7 };
    const samples = SZ.sample(point, 3, mulberry32(1));
    assert.equal(samples.length, 3);
    for (const p of samples) {
        assert.equal(p.x, 3);
        assert.equal(p.y, 7);
    }
    // 4 zonas cuadradas de 10x10 (área 100) → total 10 → reparto 3,3,2,2 (mayor resto)
    const square = () => ({
        id: 'sq',
        type: 'polygon',
        vertices: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ],
    });
    const zones = [square(), square(), square(), square()];
    const counts = SZ.distribute(zones, 10);
    assert.equal(counts.length, 4);
    assert.equal(counts.reduce((a, c) => a + c.count, 0), 10);
    assert.deepEqual(counts.map((c) => c.count), [3, 3, 2, 2]);
    // proporcional: áreas 100, 100, 200; total 5 → 1.25, 1.25, 2.5 → [1, 1, 3]
    const zones2 = [square(), square(), square()];
    zones2[2].vertices = zones2[2].vertices.map((v) => ({ x: v.x * 2, y: v.y }));
    const counts2 = SZ.distribute(zones2, 5);
    assert.deepEqual(counts2.map((c) => c.count), [1, 1, 3]);
    // puntos cuentan como 1 m²: punto (1 m²) + cuadrado (100 m²), total 101 → 1 y 100
    const counts3 = SZ.distribute([point, square()], 101);
    assert.equal(counts3.reduce((a, c) => a + c.count, 0), 101);
    assert.equal(counts3[0].count, 1);
    assert.equal(counts3[1].count, 100);
});

test('rng determinista: reproducibilidad exacta con la misma semilla', () => {
    const SZ = load();
    const a = SZ.sample(L_ZONE, 50, mulberry32(77));
    const b = SZ.sample(L_ZONE, 50, mulberry32(77));
    assert.deepEqual(b, a);
    const c = SZ.sample(L_ZONE, 50, mulberry32(78));
    const mismo = a.every((p, i) => p.x === c[i].x && p.y === c[i].y);
    assert.equal(mismo, false);
});

test('muestreo de rectángulo también reproducible y uniforme con el defecto Math.random', () => {
    const SZ = load();
    const samples = SZ.sample(RECT, 100);
    assert.equal(samples.length, 100);
    for (const p of samples) {
        assert.ok(p.x >= 0 && p.x <= 10);
        assert.ok(p.y >= 0 && p.y <= 1);
    }
});

test('validación: < 3 vértices o área 0 → Error en español', () => {
    const SZ = load();
    const linea = {
        id: 'linea',
        type: 'polygon',
        vertices: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
        ],
    };
    const colineales = {
        id: 'col',
        type: 'polygon',
        vertices: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 2 },
        ],
    };
    assert.throws(() => SZ.area(linea), /SourceZones:/);
    assert.throws(() => SZ.contains(linea, 0.5, 0.5), /SourceZones:/);
    assert.throws(() => SZ.sample(colineales, 5), /SourceZones:/);
    assert.throws(() => SZ.distribute([colineales], 5), /SourceZones:/);
    assert.throws(() => SZ.distribute([], 5), /SourceZones:/);
    assert.throws(() => SZ.distribute([RECT], 5.5), /SourceZones:/);
    try {
        SZ.sample(colineales, 5);
        assert.fail('debía lanzar');
    } catch (err) {
        // el Error se crea en el realm del sandbox: instanceof del anfitrión falla
        assert.ok(/SourceZones/.test(err.message));
        assert.ok(/[áéíóúñue]/i.test(err.message), 'el mensaje debe estar en español');
    }
});
