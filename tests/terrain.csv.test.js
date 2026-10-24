'use strict';

/**
 * T0.12 — Terrain.fromCSV con filas desordenadas.
 *
 * Defecto: los segmentos se recolectaban por fila en el orden del archivo,
 * pero los puntos se ordenaban por X al final. Con un CSV en orden
 * descendente, segment[i] quedaba pegado al tramo equivocado y los
 * materiales del perfil quedaban desalineados respecto a sus tramos.
 *
 * Corrección: recolectar filas { x, y, segment|null }, ordenarlas por x
 * (estable: empates conservan el orden de aparición) y recién ahí construir
 * points y segments — el segmento de la fila i describe el tramo
 * points[i] → points[i+1]; la última fila no aporta segmento.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');

function loadTerrain() {
    return loadScripts(['js/terrain.js'], { env: 'node', seed: 1 });
}

// CSV ascendente de referencia: materiales alternados para que cualquier
// desalineación de segmentos sea observable. La fila de la derecha (x=60)
// cierra el perfil y no aporta segmento.
const ASC = [
    'X,Y,Type,Cn,Ct,Roughness',
    '0,10,roca-suave,0.6,0.4,8',
    '20,12,asfalto,0.5,0.35,1',
    '40,10,roca-suave,0.6,0.4,8',
    '60,8,asfalto,0.5,0.35,1'
].join('\n');

// El mismo perfil escrito en orden descendente.
const DESC = [
    'X,Y,Type,Cn,Ct,Roughness',
    '60,8,asfalto,0.5,0.35,1',
    '40,10,roca-suave,0.6,0.4,8',
    '20,12,asfalto,0.5,0.35,1',
    '0,10,roca-suave,0.6,0.4,8'
].join('\n');

test('(a) CSV descendente produce los mismos points que el CSV ascendente', () => {
    const ctx = loadTerrain();
    const asc = new ctx.SimRocas.Terrain();
    asc.fromCSV(ASC);
    const desc = new ctx.SimRocas.Terrain();
    desc.fromCSV(DESC);
    assert.equal(desc.points.length, asc.points.length);
    for (let i = 0; i < asc.points.length; i++) {
        assert.ok(
            Math.abs(asc.points[i].x - desc.points[i].x) < 1e-9 &&
            Math.abs(asc.points[i].y - desc.points[i].y) < 1e-9,
            `points[${i}] diverge: ${JSON.stringify(asc.points[i])} vs ${JSON.stringify(desc.points[i])}`
        );
    }
});

test('(b) CSV descendente produce los mismos segments que el CSV ascendente', () => {
    const ctx = loadTerrain();
    const asc = new ctx.SimRocas.Terrain();
    asc.fromCSV(ASC);
    const desc = new ctx.SimRocas.Terrain();
    desc.fromCSV(DESC);
    assert.equal(desc.segments.length, asc.segments.length, 'mismo número de segmentos');
    for (let i = 0; i < asc.segments.length; i++) {
        const a = asc.segments[i];
        const d = desc.segments[i];
        assert.equal(d.type, a.type, `segments[${i}].type`);
        assert.equal(d.cn, a.cn, `segments[${i}].cn`);
        assert.equal(d.ct, a.ct, `segments[${i}].ct`);
        assert.equal(d.roughness, a.roughness, `segments[${i}].roughness`);
    }
});

test('(c) alineación fila↔tramo: el material de la fila i va al tramo points[i]→points[i+1]', () => {
    const ctx = loadTerrain();
    const t = new ctx.SimRocas.Terrain();
    t.fromCSV(ASC);
    assert.equal(t.points.length, 4);
    assert.equal(t.segments.length, 3, 'la última fila no aporta segmento');
    assert.equal(t.segments[0].type, 'roca-suave', 'tramo 0 (0→20)');
    assert.equal(t.segments[1].type, 'asfalto', 'tramo 1 (20→40)');
    assert.equal(t.segments[2].type, 'roca-suave', 'tramo 2 (40→60)');
    // Y los valores numéricos llegan sin normalización del preset.
    assert.ok(Math.abs(t.segments[1].cn - 0.5) < 1e-9);
    assert.ok(Math.abs(t.segments[1].ct - 0.35) < 1e-9);
});

test('(d) CSV sin columnas de material sigue creando segmentos por defecto', () => {
    const ctx = loadTerrain();
    const t = new ctx.SimRocas.Terrain();
    t.fromCSV('X,Y\n10,10\n20,12\n30,8\n40,10');
    assert.equal(t.points.length, 4);
    // Un segmento entre cada par de puntos consecutivos (3, no 4).
    assert.equal(t.segments.length, 3);
    for (const seg of t.segments) {
        assert.equal(seg.type, 'roca-suave');
        assert.ok(Math.abs(seg.cn - 0.6) < 1e-9, `cn por defecto (preset): ${seg.cn}`);
        assert.ok(Math.abs(seg.ct - 0.3) < 1e-9, `ct por defecto (preset): ${seg.ct}`);
        assert.ok(Math.abs(seg.roughness - 8) < 1e-9, 'roughness del preset roca-suave');
    }
});

test('(e) cabecera omitida: el CSV sin cabecera se parsea igual', () => {
    const ctx = loadTerrain();
    const withHeader = new ctx.SimRocas.Terrain();
    withHeader.fromCSV(ASC);
    const noHeader = new ctx.SimRocas.Terrain();
    noHeader.fromCSV(ASC.split('\n').slice(1).join('\n'));
    assert.equal(noHeader.points.length, withHeader.points.length);
    assert.equal(noHeader.segments.length, withHeader.segments.length);
    for (let i = 0; i < withHeader.points.length; i++) {
        assert.ok(Math.abs(noHeader.points[i].x - withHeader.points[i].x) < 1e-9);
    }
    for (let i = 0; i < withHeader.segments.length; i++) {
        assert.equal(noHeader.segments[i].type, withHeader.segments[i].type);
    }
});

test('(f) round-trip: toCSV() de un CSV ordenado no altera el perfil (regresión del orden)', () => {
    const ctx = loadTerrain();
    const first = new ctx.SimRocas.Terrain();
    first.fromCSV(ASC);
    const second = new ctx.SimRocas.Terrain();
    second.fromCSV(first.toCSV());
    assert.equal(second.points.length, first.points.length);
    assert.equal(second.segments.length, first.segments.length);
    for (let i = 0; i < first.points.length; i++) {
        assert.ok(Math.abs(second.points[i].x - first.points[i].x) < 1e-9, `x[${i}]`);
        assert.ok(Math.abs(second.points[i].y - first.points[i].y) < 1e-9, `y[${i}]`);
    }
    for (let i = 0; i < first.segments.length; i++) {
        assert.equal(second.segments[i].type, first.segments[i].type, `type[${i}]`);
    }
});
