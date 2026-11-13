'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function buildDem(env = 'worker') {
    const ctx = loadScripts(['js/dem.js'], { env: env });
    return ctx.SimRocas;
}

// Plano inclinado de referencia: z = 0.5x + 0.25y + 10, grilla 16x12, celda 2 m.
function makePlaneDem(SimRocas, cs = 2, cols = 16, rows = 12) {
    return SimRocas.Dem.fromFunction(cols, rows, cs, (x, y) => 0.5 * x + 0.25 * y + 10);
}

function approx(actual, expected, eps = 1e-6) {
    assert.ok(Number.isFinite(actual), 'esperaba un número finito');
    assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected} ±${eps}`);
}

test('constructor rechaza datos inválidos con Error en español', () => {
    const SR = buildDem();
    const ok = new Float32Array(16 * 12);
    ok.fill(1);
    const F = SR.Dem;
    assert.throws(() => new F({ cols: 1, rows: 12, cellSize: 2, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 1, cellSize: 2, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16.5, rows: 12, cellSize: 2, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 12.2, cellSize: 2, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 12, cellSize: 0, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 12, cellSize: -1, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 12, cellSize: Infinity, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 12, cellSize: NaN, heights: ok }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 12, cellSize: 2, heights: [] }), /Dem:/);
    assert.throws(() => new F({ cols: 16, rows: 12, cellSize: 2, heights: new Float32Array(5) }), /Dem:/);
    // mensajes en español
    try {
        new F({ cols: 16, rows: 12, cellSize: 2, heights: new Float32Array(0) });
        assert.fail('debía lanzar');
    } catch (e) {
        assert.ok(/[a-záéíóúñü]/.test(e.message), 'mensaje en español: ' + e.message);
    }
});

test('constructor acepta opciones válidas ydefaults de origen', () => {
    const SR = buildDem('browser');
    const heights = new Float32Array(16 * 12);
    const dem = new SR.Dem({ cols: 16, rows: 12, cellSize: 2, heights });
    assert.equal(dem.cols, 16);
    assert.equal(dem.rows, 12);
    assert.equal(dem.cellSize, 2);
    assert.equal(dem.originX, 0);
    assert.equal(dem.originY, 0);
    assert.equal(dem.originZ, 0);
    assert.equal(dem.crs, null);
});

test('heightAt: plano inclinado, exacto en interiores y bordes', () => {
    const SR = buildDem();
    const dem = makePlaneDem(SR);
    const L = (dem.cols - 1) * dem.cellSize; // 30
    const H = (dem.rows - 1) * dem.cellSize; // 22
    // interiores (sobre nodos y centros de celda)
    for (const [x, y] of [[0, 0], [4, 6], [7, 5], [11.5, 3.25], [29, 21]]) {
        approx(dem.heightAt(x, y), 0.5 * x + 0.25 * y + 10);
    }
    // bordes exteriores exactos
    approx(dem.heightAt(L, 0), 0.5 * L + 10);
    approx(dem.heightAt(0, H), 0.25 * H + 10);
    approx(dem.heightAt(L, H), 0.5 * L + 0.25 * H + 10);
    // NaN fuera del rango
    assert.ok(Number.isNaN(dem.heightAt(-0.001, 0)));
    assert.ok(Number.isNaN(dem.heightAt(0, H + 0.001)));
    assert.ok(Number.isNaN(dem.heightAt(L + 0.001, H)));
    assert.ok(Number.isNaN(dem.heightAt(L + 1, H + 1)));
});

test('normalAt: normalize(-0.5, -0.25, 1) en puntos interiores', () => {
    const SR = buildDem();
    const dem = makePlaneDem(SR);
    const len = Math.sqrt(0.5 * 0.5 + 0.25 * 0.25 + 1);
    for (const [x, y] of [[5, 4], [0, 0], [11.5, 3.25]]) {
        const n = dem.normalAt(x, y);
        approx(n.nx, -0.5 / len);
        approx(n.ny, -0.25 / len);
        approx(n.nz, 1 / len);
        approx(Math.hypot(n.nx, n.ny, n.nz), 1);
    }
    // borde exterior exacto
    const nEdge = dem.normalAt((dem.cols - 1) * dem.cellSize, 0);
    approx(nEdge.nx, -0.5 / len);
    // out opcional sin asignar
    const out = {};
    const n2 = dem.normalAt(5, 4, out);
    assert.equal(out.nx, n2.nx);
    // NaN fuera
    assert.equal(dem.normalAt(-1, 0), null);
});

test('contains: true dentro, false fuera', () => {
    const SR = buildDem();
    const dem = makePlaneDem(SR);
    assert.equal(dem.contains(0, 0), true);
    assert.equal(dem.contains(30, 22), true);
    assert.equal(dem.contains(-1, 0), false);
    assert.equal(dem.contains(30.5, 22), false);
});

test('nodo NaN contamina solo sus celdas', () => {
    const SR = buildDem();
    const cs = 2;
    const heights = new Float32Array(16 * 12);
    const dem = new SR.Dem({ cols: 16, rows: 12, cellSize: cs, heights });
    heights[4 * 16 + 3] = NaN; // nodo (i=3, j=4): celda x∈[6,8], y∈[8,10]
    // celda contaminada y nodos NaN
    for (const [x, y] of [[6, 8], [7, 9], [7, 8], [4.5, 9.5], [7.5, 6.5]]) {
        assert.ok(Number.isNaN(dem.heightAt(x, y)), `NaN esperado en (${x},${y})`);
        assert.equal(dem.normalAt(x, y), null);
        assert.equal(dem.contains(x, y), false);
    }
    // fuera de las 4 celdas adyacentes al nodo NaN sigue habiendo datos
    assert.ok(Number.isFinite(dem.heightAt(10, 4)));
    assert.ok(Number.isFinite(dem.heightAt(8.5, 5)));
    assert.ok(Number.isFinite(dem.heightAt(2, 2)));
});

test('bounds ignora NaN y devuelve mínimos/máximos locales', () => {
    const SR = buildDem();
    const cs = 2;
    const cols = 5, rows = 4;
    const heights = new Float32Array(cols * rows);
    heights.fill(NaN);
    const dem = new SR.Dem({ cols, rows, cellSize: cs, heights });
    heights[0 * cols + 0] = 3;  // (0,0) mínimo
    heights[3 * cols + 4] = 9;  // (4,3) máximo
    heights[1 * cols + 2] = 5;
    const b = dem.bounds();
    assert.equal(b.minX, 0);
    assert.equal(b.minY, 0);
    assert.equal(b.maxX, (cols - 1) * cs);
    assert.equal(b.maxY, (rows - 1) * cs);
    assert.equal(b.minZ, 3);
    assert.equal(b.maxZ, 9);
    // todo NaN
    const empty = new SR.Dem({ cols, rows, cellSize: cs, heights: new Float32Array(cols * rows).fill(NaN) });
    const be = empty.bounds();
    assert.ok(Number.isNaN(be.minZ));
    assert.ok(Number.isNaN(be.maxZ));
});

test('worldToLocal / localToWorld: ida y vuelta exacta con origen UTM Float64', () => {
    const SR = buildDem();
    const cs = 2;
    const cols = 4, rows = 4;
    const heights = new Float32Array(cols * rows).fill(1.5);
    const dem = new SR.Dem({
        cols, rows, cellSize: cs, heights,
        originX: 350000.5, originY: 6300000.25, originZ: 1000.125, crs: 'EPSG:32719',
    });
    const X = dem.originX, Y = dem.originY, Z = dem.originZ;
    const l = dem.worldToLocal(X, Y, Z);
    assert.equal(l.x, 0);
    assert.equal(l.y, 0);
    assert.equal(l.z, 0);
    const w = dem.localToWorld(0, 0, 0);
    assert.equal(w.x, X);
    assert.equal(w.y, Y);
    assert.equal(w.z, Z);
    // ida y vuelta con valores arbitrarios
    const lx = 3 * cs + 0.5, ly = 2 * cs + 1.25, lz = 42.75;
    const lw = dem.localToWorld(lx, ly, lz);
    const back = dem.worldToLocal(lw.x, lw.y, lw.z);
    assert.equal(back.x, lx);
    assert.equal(back.y, ly);
    assert.equal(back.z, lz);
    assert.equal(dem.localToWorld(1, 2).z, dem.originZ); // z local por defecto = 0
});

test('sampleProfile del plano: recta con pendiente correcta y distancias equiespaciadas', () => {
    const SR = buildDem();
    const dem = makePlaneDem(SR);
    const pts = dem.sampleProfile(0, 0, 20, 20, 5);
    assert.ok(pts.length > 0);
    // incluye ambos extremos y distancias 0..L
    assert.equal(pts[0].x, 0);
    approx(pts[pts.length - 1].x, Math.hypot(20, 20));
    // equiespaciado
    for (let k = 1; k < pts.length - 2; k++) { // el tramo final (hasta el extremo) puede ser corto por diseño
        const d0 = pts[k - 1].x, d1 = pts[k].x, d2 = pts[k + 1].x;
        approx(d1 - d0, d2 - d1, 1e-6);
    }
    // z del plano a lo largo del perfil
    // dirección unitaria (1/√2, 1/√2): dz/dd = 0.5/√2 + 0.25/√2 = 0.75/√2
    const slope = (0.5 + 0.25) / Math.SQRT2;
    for (const p of pts) {
        approx(p.y, slope * p.x + 10, 1e-6);
    }
});

test('sampleProfile con hueco NaN corta en el primer tramo', () => {
    const SR = buildDem();
    const cs = 2;
    const heights = new Float32Array(16 * 12);
    // hueco: celdas con x ∈ [8,16] vacías (NaN) para simular buraco
    for (let j = 0; j < 12; j++) {
        for (let i = 4; i < 8; i++) {
            heights[j * 16 + i] = NaN;
        }
    }
    // primer tramo: x ∈ [0, 8] (nodo 4 NaN ~ celdas [6,8] en fracción) - forzamos corte con spacing grueso
    const dem = new SR.Dem({ cols: 16, rows: 12, cellSize: cs, heights });
    // solo rellena el primer tramo de 0 a ~6 (nodo (4,j) es NaN en x=8). Perfil de 0 a 30 con spacing 5:
    // puntos en d=0,x=2.5(?),5,7.5 → en x>=8 NaN → se corta en el primer tramo contiguo
    const pts = dem.sampleProfile(0, 0, 30, 0, 5);
    assert.ok(pts.length >= 1 && pts.length <= 2, 'un solo tramo corto, no todo el perfil');
    assert.equal(pts[0].x, 0);
    // el perfil vuelve con {}  vacío si empieza en NaN
    assert.equal(dem.sampleProfile(9, 0, 14, 0, 1).length, 0);
    assert.equal(dem.sampleProfile(100, 100, 200, 200, 1).length, 0);
});

test('toTransferable / fromTransferable: ida y vuelta', () => {
    const SR = buildDem();
    const cs = 2;
    const cols = 3, rows = 3;
    const heights = new Float32Array(cols * rows);
    heights.set([1, 2, NaN, 4, 5, 6, 7, 8, 9]);
    const dem = new SR.Dem({
        cols, rows, cellSize: cs, heights,
        originX: 350000.5, originY: 6300000.25, originZ: 0.25, crs: 'EPSG:32719',
    });
    const t = dem.toTransferable();
    assert.equal(t.cols, cols);
    assert.equal(t.rows, rows);
    assert.equal(t.cellSize, cs);
    assert.equal(t.originX, 350000.5);
    assert.equal(t.originY, 6300000.25);
    assert.equal(t.originZ, 0.25);
    assert.equal(t.crs, 'EPSG:32719');
    assert.ok(t.heights instanceof Float32Array);
    assert.equal(t.heights.length, cols * rows);
    assert.equal(t.heights[0], 1);
    assert.ok(Number.isNaN(t.heights[2]));
    // apto para transfer: asegurar que es un buffer propio (con sólo esas claves)
    assert.deepEqual(Object.keys(t).sort(), ['cellSize', 'cols', 'crs', 'heights', 'originX', 'originY', 'originZ', 'rows']);
    const back = SR.Dem.fromTransferable(t);
    assert.equal(back.cols, cols);
    assert.equal(back.originX, 350000.5);
    assert.equal(back.cellSize, cs);
    assert.equal(back.heights[1], 2);
    assert.equal(back.crs, 'EPSG:32719');
});

test('env browser: la clase también está disponible', () => {
    const SR = buildDem('browser');
    assert.ok(typeof SR.Dem === 'function');
    assert.ok(typeof SR.Dem.fromFunction(2, 2, 1, () => 0).heightAt(1, 1) === 'number');
});
