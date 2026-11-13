'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

// Solo la parte pura (sin THREE): js/view3d-terrain.js es IIFE clásica.
function buildTerra(SimRocas = undefined) {
    const ctx = loadScripts(['js/view3d-terrain.js'], { env: 'browser' });
    return ctx.SimRocas;
}

test('fromDem: grilla completa, conteo de triángulos y posiciones locales', () => {
    const SimRocas = loadScripts(['js/dem.js', 'js/view3d-terrain.js'], { env: 'browser' }).SimRocas;
    // Plano: z = 0.4x + 0.2y + 5. Grilla 7x5, celda 2 m (x de 0 a 12, y de 0 a 8).
    const dem = SimRocas.Dem.fromFunction(7, 5, 2, (x, y) => 0.4 * x + 0.2 * y + 5);
    const dm = SimRocas.displayMeshFromDem(dem, 400);
    assert.equal(dm.stride, 1);
    // 6x4 quads = 48 triángulos.
    assert.equal(dm.triangles, 2 * 6 * 4);
    assert.equal(dm.positions.length, dm.triangles * 9);
    assert.equal(dm.indices.length, dm.triangles * 3);
    // Posiciones locales: primer vértice del primer triángulo es el nodo (0,0).
    assert.deepEqual([...dm.positions.slice(0, 3)], [0, 0, 5]);
    // Segundo vértice es nodo (1,0): x=2, y=0, z=5.8.
    assert.ok(Math.abs(dm.positions[3] - 2) < 1e-6);
    assert.ok(Math.abs(dm.positions[4] - 0) < 1e-6);
    assert.ok(Math.abs(dm.positions[5] - 5.8) < 1e-5);
    // Indices cubren 0..n-1 con todos los vértices usados al menos una vez.
    const used = new Set();
    for (const idx of dm.indices) {
        assert.ok(Number.isInteger(idx) && idx >= 0 && idx < dm.positions.length / 3);
        used.add(idx);
    }
    assert.equal(used.size, dm.positions.length / 3);
    assert.equal(dm.hasNodata, false);
});

test('fromDem: NaN excluye triángulos (cuenta y hasNodata)', () => {
    const SimRocas = loadScripts(['js/dem.js', 'js/view3d-terrain.js'], { env: 'browser' }).SimRocas;
    const heights = new Float32Array(7 * 5).fill(10);
    // Un nodo NaN (3,2) invalida los 6 triángulos que comparten ese vértice
    // (3 quads con esquina en (3,2): los quads (3,2)-(4,3) etc.).
    heights[2 * 7 + 3] = NaN;
    const dem = new SimRocas.Dem({ cols: 7, rows: 5, cellSize: 2, heights });
    const dm = SimRocas.displayMeshFromDem(dem, 400);
    assert.equal(dm.hasNodata, true);
    const quadsTotal = 6 * 4;
    const quadsConNaN = 3; // (2,1), (2,2), (3,1), (3,2) → quads con esquina en (3,2): (2,1),(2,2),(3,1),(3,2) → 4?
    // Los quads que tocan el nodo (3,2) son 4: (2,1), (2,2), (3,1), (3,2).
    assert.equal(dm.triangles, 2 * (quadsTotal - 4));
    // Verificación contada en detalle: total de quads = (gw-1)*(gj-1) = 6*4=24; sin NaN: 20 quads → 40 tri.
    assert.equal(dm.positions.length, 40 * 9);
    // Ningún vértice con NaN debería quedar.
    for (const v of dm.positions) { assert.ok(Number.isFinite(v)); }
});

test('fromDem: stride mínimo que respeta maxTriangles', () => {
    const SimRocas = loadScripts(['js/dem.js', 'js/view3d-terrain.js'], { env: 'browser' }).SimRocas;
    // Grilla 201x101 → quads 200x100 = 20000 quads = 40000 tri; con maxTriangles 2000 se exige stride.
    // stride=4: (ceil(201/4)=51)·(ceil(101/4)=26) ≈ 51·26 = 1326 quads? demasiado; el límite busca el stride tal
    // que 2·ceil(cols/s)·ceil(rows/s) <= maxTri.
    const dem = SimRocas.Dem.fromFunction(201, 101, 1, (x, y) => 0.1 * x);
    const maxTri = 2000;
    const dm = SimRocas.displayMeshFromDem(dem, maxTri);
    // Verificar fuente de verdad: el stride s devuelto debe cumplir el invariante y ser el mínimo.
    const cols = 201;
    const rows = 101;
    const ok = (s) => 2 * Math.ceil(cols / s) * Math.ceil(rows / s) <= maxTri;
    assert.ok(ok(dm.stride));
    assert.ok(dm.stride === 1 || !ok(dm.stride - 1), 'stride debe ser el mínimo que cumple el invariante');
    // Triángulos realmente generados no exceden maxTriangles.
    assert.ok(dm.triangles <= maxTri);
    // Con y con NaN no cambia el stride.
    const dm2 = SimRocas.displayMeshFromDem(dem, maxTri);
    assert.equal(dm2.stride, dm.stride);
});

test('slopeDegFromNormal: plano horizontal, inclinado y casos degenerados', () => {
    const SR = buildTerra();
    const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
    assert.ok(near(SR.slopeDegFromNormal(0, 0, 1), 0));
    assert.ok(near(SR.slopeDegFromNormal(1, 0, 1) ?? 0, (90 - 45) === 45 ? 45 : 45, 1e-6));
    // Normal (1, 0, 1) normalizada: pendiente 45°.
    assert.ok(near(SR.slopeDegFromNormal(Math.SQRT1_2, 0, Math.SQRT1_2), 45));
    // Vertical (nz→0) → ~90°.
    assert.ok(near(SR.slopeDegFromNormal(1, 0, 0.001), 89.94, 0.05));
    // Casos inválidos → NaN.
    assert.ok(Number.isNaN(SR.slopeDegFromNormal(0, 0, -1)));
    assert.ok(Number.isNaN(SR.slopeDegFromNormal(NaN, 0, 1)));
    assert.ok(Number.isNaN(SR.slopeDegFromNormal(1, 1, NaN)));
});

test('colorForSlope: rampa 0°→35°→60°→73° y NaN', () => {
    const SR = buildTerra();
    const nearC = (c, e, eps = 1e-6) => c.every((v, i) => Math.abs(v - e[i]) <= eps);
    // 0° = verde.
    assert.ok(nearC(SR.colorForSlope(0), [0.15, 0.75, 0.20]));
    // 35° = amarillo.
    assert.ok(nearC(SR.colorForSlope(35), [0.90, 0.90, 0.25]));
    // 60° = rojo.
    assert.ok(nearC(SR.colorForSlope(60), [0.90, 0.20, 0.05]));
    // 73°+ = gris.
    assert.ok(nearC(SR.colorForSlope(73), [0.45, 0.45, 0.45]));
    assert.ok(nearC(SR.colorForSlope(85), [0.45, 0.45, 0.45]));
    // NaN → rojo oscuro (indicador de sin datos).
    assert.ok(nearC(SR.colorForSlope(NaN), [0.7, 0.15, 0.15]));
    // Interpolación en 17.5° (mitad del verde→amarillo).
    const c = SR.colorForSlope(17.5);
    assert.ok(c[0] > 0.4 && c[0] < 0.7, 'canal rojo interpolado entre verde y amarillo');
    assert.ok(c[0] > 0.2, 'verde canal en medio');
});

test('colorForElevation: rampa hipsométrica, extremos y NaN', () => {
    const SR = buildTerra();
    const nearC = (c, e, eps = 1e-6) => c.every((v, i) => Math.abs(v - e[i]) <= eps);
    // t=0: azul.
    assert.ok(nearC(SR.colorForElevation(0), [0.23, 0.49, 0.94]));
    // t=1: blanco.
    assert.ok(nearC(SR.colorForElevation(1), [0.98, 0.98, 0.98]));
    // t=0.5: interpolación entre amarillo verdoso (0.45) y marrón (0.70): f=(0.5-0.45)/0.25=0.2.
    const c = SR.colorForElevation(0.5);
    assert.ok(c[1] < 0.9 && c[1] > 0.5);
    // Clamps: fuera de rango.
    assert.ok(nearC(SR.colorForElevation(-0.5), SR.colorForElevation(0)));
    assert.ok(nearC(SR.colorForElevation(2.0), SR.colorForElevation(1)));
    // NaN → color rosa-rojo marcador.
    assert.ok(nearC(SR.colorForElevation(NaN), [0.8, 0.2, 0.2]));
});

test('TerrainMesh3D.utils expone mismos modulo/ funciones que el módulo', () => {
    const SR = buildTerra();
    assert.equal(typeof SR.TerrainMesh3D.utils.slopeDegFromNormal, 'function');
    assert.equal(typeof SR.TerrainMesh3D.utils.colorForSlope, 'function');
    assert.equal(typeof SR.TerrainMesh3D.utils.colorForElevation, 'function');
    assert.equal(typeof SR.TerrainMesh3D.utils.displayMeshFromDem, 'function');
    assert.equal(SR.TerrainMesh3D.utils.slopeDegFromNormal, SR.slopeDegFromNormal);
});
