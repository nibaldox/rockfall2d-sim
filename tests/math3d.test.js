'use strict';

/**
 * Tests de SimRocas.V3 (js/math3d.js) — contrato C7.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function loadV3() {
    return loadScripts(['js/math3d.js'], { env: 'node' }).SimRocas.V3;
}

function approx(a, b, tol = 1e-12) {
    assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} ± ${tol}`);
}

// ---------- SET / COPY / ADD / SUB / SCALE / ADDSCALED ----------

test('V3.set escribe componentes y devuelve out (misma referencia)', () => {
    const V3 = loadV3();
    const out = { x: 0, y: 0, z: 0 };
    const r = V3.set(out, 1, 2, 3);
    approx(out.x, 1);
    approx(out.y, 2);
    approx(out.z, 3);
    assert.equal(r, out);
});

test('V3.copy / add / sub / scale / addScaled: valores exactos, out reutilizado', () => {
    const V3 = loadV3();
    const a = { x: 1, y: 2, z: 3 };
    const b = { x: 5, y: -1, z: 0.5 };
    const out = { x: 0, y: 0, z: 0 };

    assert.equal(V3.copy(out, a), out);
    assert.deepEqual([out.x, out.y, out.z], [1, 2, 3]);

    assert.equal(V3.add(out, a, b), out);
    assert.deepEqual([out.x, out.y, out.z], [6, 1, 3.5]);

    assert.equal(V3.sub(out, a, b), out);
    assert.deepEqual([out.x, out.y, out.z], [-4, 3, 2.5]);

    assert.equal(V3.scale(out, a, 2), out);
    assert.deepEqual([out.x, out.y, out.z], [2, 4, 6]);

    assert.equal(V3.addScaled(out, a, b, 2), out);
    // a + 2·b = (1+10, 2-2, 3+1)
    assert.deepEqual([out.x, out.y, out.z], [11, 0, 4]);
});

// ---------- DOT / CROSS ----------

test('V3.dot: base ortonormal y valores generales', () => {
    const V3 = loadV3();
    const e1 = { x: 1, y: 0, z: 0 };
    const e2 = { x: 0, y: 1, z: 0 };
    const e3 = { x: 0, y: 0, z: 1 };
    approx(V3.dot(e1, e2), 0);
    approx(V3.dot(e3, e3), 1);
    approx(V3.dot({ x: 1, y: 2, z: 3 }, { x: 4, y: -5, z: 6 }), 12);
});

test('V3.cross: cross(ẑ? base) anti-cíclico; cross es ortogonal a a y a b', () => {
    const V3 = loadV3();
    const out = { x: 0, y: 0, z: 0 };
    const e1 = { x: 1, y: 0, z: 0 };
    const e2 = { x: 0, y: 1, z: 0 };
    const e3 = { x: 0, y: 0, z: 1 };
    assert.equal(V3.cross(out, e1, e2), out);
    // x × y = z
    assert.deepEqual([out.x, out.y, out.z].map(Math.round), [0, 0, 1]);
    // y × z = x, z × x = y, z × y = −x
    const r = { x: 0, y: 0, z: 0 };
    V3.cross(r, e2, e3);
    assert.deepEqual([r.x, r.y, r.z], [1, 0, 0]);
    V3.cross(r, e3, e1);
    assert.deepEqual([r.x, r.y, r.z], [0, 1, 0]);
    V3.cross(r, e3, e2);
    assert.deepEqual([r.x, r.y, r.z], [-1, 0, 0]);

    const a = { x: 1, y: 2, z: 3 };
    const b = { x: -1, y: 0.5, z: 2 };
    V3.cross(r, a, b);
    approx(V3.dot(a, r), 0);
    approx(V3.dot(b, r), 0);
    // valor conocido: a × b = (2·2−3·0.5, 3·(−1)−1·2, 1·0.5−2·(−1))
    assert.deepEqual([r.x, r.y, r.z], [2.5, -5, 2.5]);
});

// ---------- LENGTH / NORMALIZE ----------

test('V3.length y normalize: unitario, vector nulo → (0,0,0)', () => {
    const V3 = loadV3();
    approx(V3.length({ x: 3, y: 4, z: 0 }), 5);
    approx(V3.length({ x: 1, y: 1, z: 1 }), Math.sqrt(3), 1e-15);

    const out = { x: 0, y: 0, z: 0 };
    const len = V3.normalize(out, { x: 3, y: 4, z: 12 });
    approx(len, 13);
    approx(out.x, 3 / 13);
    approx(out.y, 4 / 13);
    approx(out.z, 12 / 13);
    const normLen = V3.normalize(out, out); // in-place
    approx(normLen, 1);
    // in-place: sigue siendo unitario
    approx(V3.length(out), 1);
    // vector nulo: escribe (0,0,0) y devuelve longitud 0
    approx(V3.normalize(out, { x: 0, y: 0, z: 0 }), 0);
    assert.deepEqual([out.x, out.y, out.z], [0, 0, 0]);
});

// ---------- ROTATE AROUND AXIS (Rodrigues) ----------

test('rotateAroundAxis: 90° exactos (±1e-12)', () => {
    const V3 = loadV3();
    const out = { x: 0, y: 0, z: 0 };
    const v = { x: 1, y: 0, z: 0 };
    const k = { x: 0, y: 0, z: 1 };
    V3.rotateAroundAxis(out, v, k, Math.PI / 2);
    approx(out.x, 0);
    approx(out.y, 1);
    approx(out.z, 0);

    // 90° de y alrededor de z → −x
    V3.rotateAroundAxis(out, { x: 0, y: 1, z: 0 }, k, Math.PI / 2);
    approx(out.x, -1);
    approx(out.y, 0);
    approx(out.z, 0);

    // rotación alrededor del propio eje: invariante
    V3.rotateAroundAxis(out, { x: 0, y: 0, z: 7 }, k, 1.234);
    assert.deepEqual([out.x, out.y, out.z], [0, 0, 7]);

    // v genérico con componente axial: (1,2,3) rotado 90° alrededor de z → (−2,1,3)
    V3.rotateAroundAxis(out, { x: 1, y: 2, z: 3 }, k, Math.PI / 2);
    approx(out.x, -2);
    approx(out.y, 1);
    approx(out.z, 3);

    // preserva la longitud
    V3.rotateAroundAxis(out, { x: 1, y: 2, z: 3 }, { x: 0, y: 0.6, z: 0.8 }, 0.7);
    approx(V3.length(out), Math.sqrt(14), 1e-12);
});

// ---------- ANY PERPENDICULAR ----------

test('anyPerpendicular: ortogonal y unitario para normales casi verticales y casi horizontales', () => {
    const V3 = loadV3();
    const out = { x: 0, y: 0, z: 0 };
    const cases = [
        { x: 0, y: 0, z: 1 },          // vertical
        { x: 0, y: 0, z: -1 },         // vertical invertida
        { x: 1e-9, y: 1e-9, z: 1 },    // casi vertical (antes de normalizar ≈ vertical)
        { x: 0.99995, y: 0.007, z: 0.007 }, // casi horizontal
        { x: -0.6, y: 0.55, z: 0.58 }, // general
        { x: 1, y: 0, z: 0 },          // horizontal
        { x: 0, y: 1, z: 0 },
    ];
    for (const n of cases) {
        const r = V3.anyPerpendicular(out, n);
        assert.equal(r, out);
        approx(V3.dot(n, out), 0);
        approx(V3.length(out), 1, 1e-9);
    }
    // determinista (misma entrada → misma salida)
    const a = { x: 0.3, y: 0.4, z: 0.85 };
    const b = { x: 0, y: 0, z: 0 };
    V3.anyPerpendicular(a, { x: 0, y: 0, z: 1 });
    V3.anyPerpendicular(b, { x: 0, y: 0, z: 1 });
    assert.deepEqual([a.x, a.y, a.z], [b.x, b.y, b.z]);
});
