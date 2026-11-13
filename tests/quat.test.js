'use strict';

/**
 * Tests de SimRocas.Quat y SimRocas.Mat3 (js/math3d.js) — fase F5 / T5.1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function loadQuat() {
    const ctx = loadScripts(['js/math3d.js'], { env: 'node' });
    return { Quat: ctx.SimRocas.Quat, Mat3: ctx.SimRocas.Mat3, V3: ctx.SimRocas.V3 };
}

function approx(a, b, tol = 1e-12) {
    assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} ± ${tol}`);
}

function vecClose(label, out, x, y, z, tol = 1e-12) {
    assert.ok(Math.abs(out.x - x) <= tol, `${label} x: ${out.x} ≈ ${x} ± ${tol}`);
    assert.ok(Math.abs(out.y - y) <= tol, `${label} y: ${out.y} ≈ ${y} ± ${tol}`);
    assert.ok(Math.abs(out.z - z) <= tol, `${label} z: ${out.z} ≈ ${z} ± ${tol}`);
}

function quatClose(label, q, w, x, y, z, tol) {
    assert.ok(Math.abs(q.w - w) <= tol, `${label} w`);
    assert.ok(Math.abs(q.x - x) <= tol, `${label} x`);
    assert.ok(Math.abs(q.y - y) <= tol, `${label} y`);
    assert.ok(Math.abs(q.z - z) <= tol, `${label} z`);
}

function matClose(label, m, expected, tol = 1e-12) {
    for (let i = 0; i < 9; i++) {
        assert.ok(Math.abs(m[i] - expected[i]) <= tol, `${label}[${i}]: ${m[i]} ≈ ${expected[i]} ± ${tol}`);
    }
}

// ---------- QUAT: identity / fromAxisAngle ----------

test('Quat.identity: (1, 0, 0, 0) y no rota vectores', () => {
    const { Quat } = loadQuat();
    const q = {};
    assert.equal(Quat.identity(q), q);
    quatClose('identity', q, 1, 0, 0, 0, 0);
    const out = {};
    Quat.rotateVector(out, q, { x: 1, y: 2, z: 3 });
    vecClose('identity-rot', out, 1, 2, 3);
});

test('Quat.fromAxisAngle: 90° sobre Z rota X→Y; normaliza el eje', () => {
    const { Quat, V3 } = loadQuat();
    const q = {};
    const halfSqrt2 = Math.SQRT1_2;
    quatClose('qz90', Quat.fromAxisAngle(q, V3.set({}, 0, 0, 1), Math.PI / 2), halfSqrt2, 0, 0, halfSqrt2, 1e-15);

    const out = {};
    Quat.rotateVector(out, q, { x: 1, y: 0, z: 0 });
    vecClose('rot 90', out, 0, 1, 0, 1e-13);

    // eje no unitario: se normaliza internamente
    Quat.fromAxisAngle(q, V3.set({}, 0, 0, 2), Math.PI / 2);
    Quat.rotateVector(out, q, { x: 1, y: 0, z: 0 });
    vecClose('rot 90 (eje 2z)', out, 0, 1, 0, 1e-13);
});

// ---------- QUAT: multiply / conjugate ----------

test('Quat.multiply: composición coincide con aplicar rotaciones en orden', () => {
    const { Quat, V3 } = loadQuat();
    const qz = Quat.fromAxisAngle({}, V3.set({}, 0, 0, 1), Math.PI / 2);
    const qx = Quat.fromAxisAngle({}, V3.set({}, 1, 0, 0), Math.PI / 3);
    const composed = Quat.multiply({}, qz, qx);

    const v = { x: 0.3, y: -0.7, z: 0.55 };
    const t = {};
    const viaCompose = {};
    Quat.rotateVector(viaCompose, composed, { x: v.x, y: v.y, z: v.z });

    // primero qx, luego qz
    Quat.rotateVector(t, qx, v);
    const viaSeq = {};
    Quat.rotateVector(viaSeq, qz, t);
    approx(viaCompose.x, viaSeq.x, 1e-13);
    approx(viaCompose.y, viaSeq.y, 1e-13);
    approx(viaCompose.z, viaSeq.z, 1e-13);

    // el orden aplicado ya se verificó contra la secuencia de rotaciones
});

test('Quat.multiply: identidad es elemento neutro y coincide con la fórmula de Hamilton', () => {
    const { Quat } = loadQuat();
    const qa = { w: 0.5, x: -0.25, y: 0.75, z: 0.35 };
    const qb = { w: 1.3, x: 0.6, y: -0.9, z: 0.2 };
    const out = {};
    Quat.multiply(out, Quat.identity({}), qa);
    quatClose('qa·I', out, qa.w, qa.x, qa.y, qa.z, 0);
    Quat.multiply(out, qa, Quat.identity({}));
    quatClose('I·qa', out, qa.w, qa.x, qa.y, qa.z, 0);

    // producto Hamilton a mano: (w1w2 − v1·v2, w1 v2 + w2 v1 + v1×v2)
    const w = qa.w * qb.w - (qa.x * qb.x + qa.y * qb.y + qa.z * qb.z);
    const x = qa.w * qb.x + qb.w * qa.x + (qa.y * qb.z - qa.z * qb.y);
    const y = qa.w * qb.y + qb.w * qa.y + (qa.z * qb.x - qa.x * qb.z);
    const z = qa.w * qb.z + qb.w * qa.z + (qa.x * qb.y - qa.y * qb.x);
    Quat.multiply(out, qa, qb);
    quatClose('Hamilton', out, w, x, y, z, 1e-15);
});

test('Quat.conjugate: conj(q) deshace q;q·conj(q) = identidad', () => {
    const { Quat, V3 } = loadQuat();
    const q = Quat.fromAxisAngle({}, V3.set({}, 1, 1, 1), 1.234);
    const cj = {};
    assert.equal(Quat.conjugate(cj, q), cj);
    quatClose('conj', cj, q.w, -q.x, -q.y, -q.z, 0);

    const unit = {};
    Quat.multiply(unit, q, cj);
    quatClose('q·conj(q)', unit, 1, 0, 0, 0, 1e-14);

    // rotar y des-rotar devuelve el vector original
    const v = { x: 2, y: -1, z: 0.5 };
    const r = {}; const back = {};
    Quat.rotateVector(r, q, v);
    Quat.rotateVector(back, cj, r);
    vecClose('ida y vuelta', back, v.x, v.y, v.z, 1e-13);
});

// ---------- QUAT: normalize ----------

test('Quat.normalize: módulo 1 y sin NaN', () => {
    const { Quat } = loadQuat();
    const q = { w: 2, x: -1, y: 0.5, z: -3 };
    const out = {};
    assert.equal(Quat.normalize(out, q), out);
    const exp2 = out.w * out.w + out.x * out.x + out.y * out.y + out.z * out.z;
    approx(exp2, 1, 1e-15);
});

// ---------- QUAT: integrate ----------

test('Quat.integrate: giro puro reproduce un paso grande contra fromAxisAngle', () => {
    const { Quat, V3 } = loadQuat();
    const axis = { x: 0.4, y: 0.2, z: 0.894427190999916 };
    const omega = V3.scale({}, axis, 0.7); // |ω| = 0.7 rad/s
    const q = Quat.identity({});
    const h = 1e-4;
    const T = 1; // 1 s → 0.7 rad
    const steps = Math.round(T / h);
    for (let i = 0; i < steps; i++) {
        Quat.integrate(q, q, omega, h);
    }
    const exact = Quat.fromAxisAngle({}, axis, 0.7);
    // error de Euler renormalizado: O(h·T·|ω|) ≈ 3.5e-5
    quatClose('integrate vs exacto', q, exact.w, exact.x, exact.y, exact.z, 1e-4);
    // norma
    assert.ok(Math.abs(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z - 1) < 1e-12);
});

// ---------- QUAT: toMat3 ----------

test('Quat.toMat3: coincide con Rodrigues en 3 vectores; R es ortonormal con det +1', () => {
    const { Quat, Mat3, V3 } = loadQuat();
    const q = Quat.fromAxisAngle({}, V3.set({}, 1, -2, 0.5), 0.9);
    const m = Quat.toMat3(new Float64Array(9), q);

    // ortonormalidad
    const dot01 = m[0] * m[3] + m[1] * m[4] + m[2] * m[5];
    const dot02 = m[0] * m[6] + m[1] * m[7] + m[2] * m[8];
    const dot12 = m[3] * m[6] + m[4] * m[7] + m[5] * m[8];
    approx(dot01, 0);
    approx(dot02, 0);
    approx(dot12, 0);
    const n0 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
    const n1 = m[3] * m[3] + m[4] * m[4] + m[5] * m[5];
    const n2 = m[6] * m[6] + m[7] * m[7] + m[8] * m[8];
    approx(n0, 1); approx(n1, 1); approx(n2, 1);

    const det = m[0] * (m[4] * m[8] - m[5] * m[7])
        - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6]);
    approx(det, 1, 1e-12);

    // coincide con Rodrigues (V3.rotateAroundAxis) sobre vectores de prueba
    const tests = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 3, y: -4, z: 7 }];
    const out = {}; const ref = {};
    const norm = { x: 1, y: -2, z: 0.5 };
    const len = Math.sqrt(1 + 4 + 0.25);
    norm.x /= len; norm.y /= len; norm.z /= len;
    for (const v of tests) {
        Quat.rotateVector(out, q, v);
        V3.rotateAroundAxis(ref, v, norm, 0.9);
        approx(out.x, ref.x, 1e-12);
        approx(out.y, ref.y, 1e-12);
        approx(out.z, ref.z, 1e-12);
    }
});

test('Quat.toMat3 (90° sobre Z) da la permutación esperada', () => {
    const { Quat, V3 } = loadQuat();
    const q = Quat.fromAxisAngle({}, V3.set({}, 0, 0, 1), Math.PI / 2);
    const m = Quat.toMat3(new Float64Array(9), q);
    matClose('Rz90', m, [0, -1, 0, 1, 0, 0, 0, 0, 1], 1e-14);
});

// ---------- MAT3: identidad / multiplicar / transponer / mulVec ----------

test('Mat3.identity / multiply / transpose / mulVec: valores concretos', () => {
    const { Mat3, V3 } = loadQuat();
    const I = Mat3.identity(new Float64Array(9));
    matClose('I', I, [1, 0, 0, 0, 1, 0, 0, 0, 1], 0);

    const A = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    const B = new Float64Array([1, 0, 2, 0, 1, 0, 3, 0, 1]);

    const out = new Float64Array(9);
    assert.equal(Mat3.multiply(out, A, B), out);
    matClose('A·B', out, [
        10, 2, 5,
        22, 5, 14,
        37, 8, 24,
    ]);

    const At = new Float64Array(9);
    Mat3.transpose(At, A);
    matClose('Aᵀ', At, [1, 4, 7, 2, 5, 8, 3, 6, 10], 0);

    const v = {};
    Mat3.mulVec(v, A, { x: 1, y: -1, z: 2 });
    vecClose('A·v', v, 5, 11, 19);
    void V3;
});

// ---------- MAT3: fromQuat / rotateTensor / inverse ----------

test('Mat3.fromQuat coincide con Quat.toMat3', () => {
    const { Quat, Mat3, V3 } = loadQuat();
    const q = Quat.fromAxisAngle({}, V3.set({}, 2, 1, -1), 1.1);
    const m1 = Quat.toMat3(new Float64Array(9), q);
    const m2 = Mat3.fromQuat(new Float64Array(9), q);
    matClose('fromQuat', m2, m1, 0);
});

test('Mat3.rotateTensor: rotar la inercia de una caja 90° sobre Z intercambiaIx↔Iy', () => {
    const { Quat, Mat3, V3 } = loadQuat();
    // caja a=2, b=4, c=6, densidad 1: m = 48
    const m = 48;
    const Ix = m * (4 * 4 + 6 * 6) / 12;
    const Iy = m * (2 * 2 + 6 * 6) / 12;
    const Iz = m * (2 * 2 + 4 * 4) / 12;
    const Ibody = new Float64Array([Ix, 0, 0, 0, Iy, 0, 0, 0, Iz]);

    const q = Quat.fromAxisAngle({}, V3.set({}, 0, 0, 1), Math.PI / 2);
    const R = Quat.toMat3(new Float64Array(9), q);
    const Irot = Mat3.rotateTensor(new Float64Array(9), R, Ibody);
    // rotar 90° en Z: eje x del cuerpo pasa a −y del mundo…
    matClose('I rotada', Irot, [Iy, 0, 0, 0, Ix, 0, 0, 0, Iz], 1e-9);
});

test('Mat3.inverse simétrica: A·A⁻¹ ≈ I; caso con mezcla', () => {
    const { Mat3 } = loadQuat();
    const A = new Float64Array([2, 0.5, 0, 0.5, 3, 0.25, 0, 0.25, 1]);
    const inv = Mat3.inverseSym(new Float64Array(9), A);
    const prod = Mat3.multiply(new Float64Array(9), A, inv);
    matClose('A·A⁻¹', prod, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
});

// ---------- MAT3: jacobiEigen ----------

test('Mat3.jacobiEigen: matriz diagonal ya está en base propia', () => {
    const { Mat3 } = loadQuat();
    const A = new Float64Array([1, 0, 0, 0, 2, 0, 0, 0, 3]);
    const evals = { x: 0, y: 0, z: 0 };
    const evecs = new Float64Array(9);
    assert.equal(Mat3.jacobiEigen(evals, evecs, A), true);
    // orden ascendente
    approx(evals.x, 1); approx(evals.y, 2); approx(evals.z, 3);
    reconstructCheck(Mat3, A, evals, evecs);
});

function eigOrthonormal(evecs, tol = 1e-10) {
    // convención: COLUMNAS — el autovector j está en (evecs[j], evecs[3+j], evecs[6+j])
    const cols = [0, 1, 2].map(i => ({ x: evecs[i], y: evecs[3 + i], z: evecs[6 + i] }));
    for (const c of cols) {
        approx(Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z), 1, tol);
    }
    approx(cols[0].x * cols[1].x + cols[0].y * cols[1].y + cols[0].z * cols[1].z, 0, tol);
    approx(cols[0].x * cols[2].x + cols[0].y * cols[2].y + cols[0].z * cols[2].z, 0, tol);
    approx(cols[1].x * cols[2].x + cols[1].y * cols[2].y + cols[1].z * cols[2].z, 0, tol);
    return cols;
}

function reconstructCheck(Mat3, A, evals, evecs) {
    const cols = eigOrthonormal(evecs);
    // construyo E fila mayor a partir de columnas (autovectores)
    const E = new Float64Array([
        cols[0].x, cols[1].x, cols[2].x,
        cols[0].y, cols[1].y, cols[2].y,
        cols[0].z, cols[1].z, cols[2].z,
    ]);
    const Et = Mat3.transpose(new Float64Array(9), E);
    const L = new Float64Array([evals.x, 0, 0, 0, evals.y, 0, 0, 0, evals.z]);
    const t0 = Mat3.multiply(new Float64Array(9), E, L);
    const rec = Mat3.multiply(new Float64Array(9), t0, Et);
    matClose('A = E Λ Eᵀ', rec, A, 1e-10 * Math.max(1, Math.abs(evals.x), Math.abs(evals.z)));
}

test('Mat3.jacobiEigen: matriz densa conocida 2±√2 y ortonormalidad', () => {
    const { Mat3 } = loadQuat();
    const A = new Float64Array([2, 1, 0, 1, 2, 1, 0, 1, 2]);
    const evals = {}; const evecs = new Float64Array(9);
    assert.equal(Mat3.jacobiEigen(evals, evecs, A), true);
    approx(evals.z, 2 + Math.SQRT2, 1e-12);
    approx(evals.y, 2, 1e-12);
    approx(evals.x, 2 - Math.SQRT2, 1e-12);
    reconstructCheck(Mat3, A, evals, evecs);
});

test('Mat3.jacobiEigen: autovalores separados 1e-10 (casi degenerados)', () => {
    const { Mat3 } = loadQuat();
    const eps = 1e-10;
    const A = new Float64Array([3 + eps, 0, 0, 0, 3, 0, 0, 0, 3 - 2 * eps]);
    // perturbo con un acoplamiento simétrico conocido
    A[1] = 1e-12; A[3] = 1e-12;
    const evals = {}; const evecs = new Float64Array(9);
    assert.equal(Mat3.jacobiEigen(evals, evecs, A), true);
    assert.ok(Math.abs(evals.x - (3 - 2 * eps)) <= 1e-11, `eval menor ${evals.x}`);
    assert.ok(Math.abs(evals.z - (3 + eps)) <= 1e-11, `eval mayor ${evals.z}`);
    assert.ok(Math.abs(evals.y - 3) <= 1e-10, `eval medio ${evals.y}`);
    reconstructCheck(Mat3, A, evals, evecs);
});

test('Mat3.jacobiEigen: reconstrucción correcta con matriz general (R·I·Rᵀ de unal ínea)', () => {
    const { Quat, Mat3, V3 } = loadQuat();
    // inercia diagonal de una caja, rotada: es simétrica definida positiva general
    const m = 10;
    const Ibody = new Float64Array([
        m * (25 + 36) / 12, 0, 0,
        0, m * (4 + 36) / 12, 0,
        0, 0, m * (4 + 25) / 12,
    ]);
    const q = Quat.fromAxisAngle({}, V3.set({}, 0.3, -0.7, 0.4), 1.7);
    const R = Quat.toMat3(new Float64Array(9), q);
    const Iworld = Mat3.rotateTensor(new Float64Array(9), R, Ibody);
    const evals = {}; const evecs = new Float64Array(9);
    assert.equal(Mat3.jacobiEigen(evals, evecs, Iworld), true);
    // orden ascendente: Izz ≤ Iyy ≤ Ixx (a=2·? caja 5·6·2? a=2,b=5,c=6 >?) — siempre Izz < Iyy < Ixx
    assert.ok(Math.abs(evals.x - Ibody[8]) <= 1e-10, `eval0 ${evals.x}`);
    assert.ok(Math.abs(evals.y - Ibody[4]) <= 1e-10, `eval1 ${evals.y}`);
    assert.ok(Math.abs(evals.z - Ibody[0]) <= 1e-10, `eval2 ${evals.z}`);
    reconstructCheck(Mat3, Iworld, evals, evecs);
});
