'use strict';

/**
 * Tests de SimRocas.ProfileFromDem (T3.5) y SimRocas.PlanView (T3.7).
 * Todo es lógica pura (sin THREE): js/view3d-profile.js y la parte de datos
 * de js/view3d-plan.js cargan en Node vía tests/helpers/load.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

const FILES = ['js/dem.js', 'js/view3d-profile.js', 'js/stl.js', 'js/view3d-plan.js'];


function buildCtx(extra = {}) {
    return loadScripts(FILES, { env: 'browser', ...extra }).SimRocas;
}

/**
 * DEM de plano inclinado con valores EXACTOS en Float32:
 * z(x, y) = 10 + 0.25·x + 0.125·y (dyádico → sin error de redondeo).
 * Grilla 25 x 20, cellSize 1 → x ∈ [0, 24], y ∈ [0, 19].
 */
function buildPlaneDem(SimRocas) {
    return SimRocas.Dem.fromFunction(25, 20, 1, (x, y) => 10 + 0.25 * x + 0.125 * y);
}

/**
 * Variante para curvas de nivel: z = 10.5 + 0.25·x + 0.125·y (mínimo 10.5 no
 * coincide con un nivel 'bonito'; relieve 8.375 → intervalo 'bonito' cercano
 * a 8.375/20 = 0.42 → 0.5; con intervalo explícito 5 → niveles 15).
 */
function buildContourDem(SimRocas) {
    return SimRocas.Dem.fromFunction(25, 20, 1, (x, y) => 10.5 + 0.25 * x + 0.125 * y);
}

test('sample: polilínea de 3 vértices sobre plano inclinado — distancias y cotas exactas (±1e-6)', () => {
    const SimRocas = buildCtx();
    const dem = buildPlaneDem(SimRocas);
    const polyline = [{ x: 4, y: 3 }, { x: 12, y: 11 }, { x: 12, y: 3 }];
    const L1 = Math.hypot(12 - 4, 11 - 3);   // segmento 1
    const L2 = Math.hypot(12 - 12, 3 - 11);  // segmento 2 (vertical, 8 m)
    assert.ok(Math.abs(L1 - Math.sqrt(128)) < 1e-12);
    const r = SimRocas.ProfileFromDem.sample(dem, polyline, 1);
    assert.equal(r.truncated, false);
    assert.ok(r.points.length >= 3);

    // Referencia: distancias esperadas construidas con la misma aritmética
    // que Dem.sampleProfile usa internamente.
    const expected = [];
    const Ls = [L1, L2];
    let offset = 0;
    let isFirst = true;
    const ux1 = (12 - 4) / L1, uy1 = (11 - 3) / L1;
    const ux2 = 0, uy2 = -1;
    for (let si = 0; si < 2; si++) {
        const L = Ls[si];
        const ux = si === 0 ? ux1 : ux2;
        const uy = si === 0 ? uy1 : uy2;
        const x1 = si === 0 ? 4 : 12;
        const y1 = si === 0 ? 3 : 11;
        const steps = Math.floor(L / 1);
        for (let k = 0; k <= steps; k++) {
            if (k === 0 && !isFirst) { continue; } // vértice compartido: no duplicar
            const d_val = (si === 0) ? offset + k * 1 : offset + k * 1;
            const px = x1 + ux * k * 1;
            const py = y1 + uy * k * 1;
            expected.push({ x: d_val, z: 10 + 0.25 * px + 0.125 * py });
        }
        if (L - steps * 1 > 0) {
            const px = x1 + ux * L;
            const py = y1 + uy * L;
            if (!isFirst) { /* extremo exacto: sólo si no fue emitido */ }
            const lastEmitted = si === 0
                ? expected[expected.length - 1]
                : null;
            if (!(lastEmitted && lastEmitted.x === offset + L)) {
                expected.push({ x: offset + L, z: 10 + 0.25 * px + 0.125 * py });
            }
        }
        offset += L;
        isFirst = false;
    }

    assert.equal(r.points.length, expected.length);
    // Distancias estrictamente crecientes (sin duplicados en el vértice compartido).
    for (let i = 1; i < r.points.length; i++) {
        assert.ok(r.points[i].x - r.points[i - 1].x > 1e-9, 'distancias duplicadas en i=' + i);
    }
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(r.points[i].x - expected[i].x) < 1e-6, 'distancia ' + i);
        assert.ok(Math.abs(r.points[i].y - expected[i].z) < 1e-6, 'cota ' + i);
    }
    assert.ok(Math.abs(r.validLength - (L1 + L2)) < 1e-9);
});

test('sample: tramo con hueco (NaN) — truncated y validLength al primer hueco', () => {
    const SimRocas = buildCtx();
    const data = new Float32Array(25 * 20);
    for (let j = 0; j < 20; j++) {
        for (let i = 0; i < 25; i++) {
            data[j * 25 + i] = 10 + 0.25 * i + 0.125 * j;
        }
    }
    // Colina con banda NaN en x = 14: el perfil V0(6,5) → V1(20,5) se corta ahí.
    for (let j = 0; j < 20; j++) {
        data[j * 25 + 14] = NaN;
    }
    const dem = new SimRocas.Dem({ cols: 25, rows: 20, cellSize: 1, heights: data });
    const polyline = [
        { x: 6, y: 5 },
        { x: 20, y: 5 },
    ];
    const r = SimRocas.ProfileFromDem.sample(dem, polyline, 1);
    assert.equal(r.truncated, true);
    assert.ok(r.points.length > 0);
    // El último punto muestreado debe estar antes del hueco (x = 13 como máximo):
    // distancia d = x - 6 ≤ 8 el valor exacto depende de sampleProfile (13.0).
    const last = r.points[r.points.length - 1];
    assert.ok(last.x <= 8 + 1e-9, 'el tramo no debe pasar del hueco');
    assert.ok(Math.abs(r.validLength - last.x) < 1e-12);
    // Cotas correctas hasta el corte (y = 5 fijo → z = 10 + 0.25·x + 0.625).
    for (const p of r.points) {
        const x = 6 + p.x;
        assert.ok(Math.abs(p.y - (10 + 0.25 * x + 0.125 * 5)) < 1e-6);
    }
});

test('sample: polilínea en L sin duplicados en el vértice compartido', () => {
    const SimRocas = buildCtx();
    const dem = buildPlaneDem(SimRocas);
    // L: horizontal 8 m y luego diagonal 5 m (3-4-5).
    const polyline = [{ x: 2, y: 2 }, { x: 10, y: 2 }, { x: 13, y: 6 }];
    const r = SimRocas.ProfileFromDem.sample(dem, polyline, 1);
    assert.equal(r.truncated, false);
    // Distancias: 0..8 (enteros), luego 9..13 (offset 8, j=1..5), sin punto 8 duplicado.
    const distances = r.points.map((p) => p.x);
    assert.equal(distances.length, new Set(distances).size);
    // Índices del vértice compartido: sólo UN punto en d=8.
    assert.equal(distances.filter((d) => Math.abs(d - 8) < 1e-9).length, 1);
    // Cotas en el vértice compartido: z(10,2) = 14.5.
    const idx8 = distances.findIndex((d) => Math.abs(d - 8) < 1e-9);
    assert.ok(Math.abs(r.points[idx8].y - (10 + 0.25 * 10 + 0.125 * 2)) < 1e-6);
    // Longitud total 13.
    assert.ok(Math.abs(Math.max(...distances) - 13) < 1e-9);
});

test('sample: input inválido lanza error razonable', () => {
    const SimRocas = buildCtx();
    const dem = buildPlaneDem(SimRocas);
    assert.throws(() => SimRocas.ProfileFromDem.sample(dem, [{ x: 0, y: 0 }], 1));
    assert.throws(() => SimRocas.ProfileFromDem.sample(dem,
        [{ x: 0, y: 0 }, { x: 4, y: 0 }], 0));
});

test('niceInterval: elige 1/2/5·10^k cercano a relieve/20', () => {
    const SimRocas = buildCtx();
    const cases = [
        [100, 5],    // 100/20 = 5
        [200, 10],   // 10
        [40, 2],     // 2
        [10, 0.5],   // 0.5
        [12, 0.5],   // 0.6 → 0.5
        [95, 5],     // 4.75 → 5
        [300, 10],   // 15 → empate 5/15 = |20-15|/15 → se prefiere el menor (10)
        [1, 0.05],   // 0.05
        [1000, 50],  // 50
    ];
    for (const [relief, expected] of cases) {
        const got = SimRocas.ProfileFromDem.niceInterval(relief);
        assert.ok(
            Math.abs(got - expected) < 1e-12,
            'niceInterval(' + relief + ') = ' + got + ' (esperado ' + expected + ')'
        );
    }
    assert.equal(SimRocas.ProfileFromDem.niceInterval(0), 1);
    assert.equal(SimRocas.ProfileFromDem.niceInterval(NaN), 1);
});

test('PlanView.heightmapFromDem: mapea nodos → formato StlContour (sin NaN)', () => {
    const SimRocas = buildCtx();
    const data = new Float32Array(6 * 5);
    for (let k = 0; k < data.length; k++) { data[k] = 3 + 0.5 * (k % 7); }
    data[0] = NaN;
    const dem = new SimRocas.Dem({ cols: 6, rows: 5, cellSize: 2, heights: data });
    const hm = SimRocas.PlanView.heightmapFromDem(dem);
    assert.equal(hm.cols, 6);
    assert.equal(hm.rows, 5);
    assert.equal(hm.cellW, 2);
    assert.equal(hm.cellH, 2);
    assert.equal(hm.minHX, 0);
    assert.equal(hm.minHY, 0);
    assert.equal(hm.heights.length, 30);
    assert.ok(hm.heights[0] < -1e29, 'NaN → NODATA (float32)');
    assert.equal(Number.isNaN(dem.heights[0]), true);
    assert.equal(hm.heights[7], dem.heights[7]);             // resto intacto
});

test('PlanView.segmentPositions: vértices de curva sobre nodos interpolados del DEM', () => {
    const SimRocas = buildCtx();
    const dem = buildContourDem(SimRocas);      // z = 10.5 + 0.25x + 0.125y
    const contours = SimRocas.PlanView.buildContoursFromDem(dem, 5);
    assert.ok(contours.length > 0);
    const levels = contours.map((c) => c.level);
    // firstLevel = ceil(minZ/interval)·interval; minZ = 10.5 → nivel 15
    // (maxZ = 18.875 → sólo 15).
    assert.equal(levels.length, 1);
    assert.ok(Math.abs(levels[0] - 15) < 1e-12);
    for (const c of contours) {
        const pos = SimRocas.PlanView.segmentPositions(dem, [c], 0);
        assert.ok(pos.length > 0);
        for (let v = 0; v < pos.length; v += 3) {
            const x = pos[v], y = pos[v + 1], z = pos[v + 2];
            const zPlane = 10.5 + 0.25 * x + 0.125 * y;
            const levelHit = Math.abs(zPlane - c.level) < 1e-6;
            let onNodeInterp = false;
            // El vértice debe yacer sobre una arista entre nodos interpolados:
            // al menos un extremo de la arista generadora está en la cota del nivel.
            const fi = x / dem.cellSize;
            const fj = y / dem.cellSize;
            if ([fi, fj].some((f) => Math.abs(f - Math.round(f)) < 1e-9)) {
                onNodeInterp = true; // sobre una línea de nodos (arista del grid)
            }
            assert.ok(levelHit, 'z del vértice en el nivel ' + c.level);
            assert.ok(onNodeInterp, 'vértice sobre red de nodos');
            // z de escena = cota del terreno en (x, y) + lift (aquí lift = 0 → cota base).
            assert.ok(Math.abs(z - dem.heightAt(x, y)) < 1e-6, 'z sobre terreno local');
        }
    }
});

test('PlanView.niceIntervalFromDem usa el relieve del DEM (con NaN)', () => {
    const SimRocas = buildCtx();
    const data = new Float32Array(4 * 4);
    for (let k = 0; k < data.length; k++) { data[k] = k * 17.5; } // 0..241.5? relieve 241.5
    const dem = new SimRocas.Dem({ cols: 4, rows: 4, cellSize: 3, heights: data });
    const got = SimRocas.PlanView.autoInterval(dem);
    // relieve = 240 + ? — max 17.5*15=262.5, min 0 → 262.5/20 = 13.1 → candidato 10 ó 20:
    // |10-13.1|/13.1 = .238 < |20-13.1|/13.1 = .527 → 10.
    assert.equal(got, 10);
});
