'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function buildDemBuilder() {
    const ctx = loadScripts(['js/dem.js', 'js/dem-builder.js'], { env: 'worker' });
    return ctx.SimRocas;
}

// Plano z = 0.3x + 0.1y + 5
function planeZ(x, y) {
    return 0.3 * x + 0.1 * y + 5;
}

function closeTo(actual, expected, tol, msg) {
    assert.ok(Number.isFinite(actual), 'esperaba número finito, recibí ' + actual + (msg ? ' (' + msg + ')' : ''));
    assert.ok(
        Math.abs(actual - expected) <= tol,
        (msg ? msg + ': ' : '') + actual + ' != ' + expected + ' ±' + tol
    );
}

// Malla de 2 triángulos: cuadrado local [0, sx]x[0, sy] del plano, con diagonal
function makePlaneMesh(sx = 10, sy = 10, originX = 350000, originY = 6300000) {
    const verts = [[0, 0], [sx, 0], [sx, sy], [0, sy]];
    const positions = new Float32Array(12);
    verts.forEach(function (v, k) {
        positions[k * 3] = v[0];
        positions[k * 3 + 1] = v[1];
        positions[k * 3 + 2] = planeZ(v[0], v[1]);
    });
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    return {
        kind: 'mesh',
        positions: positions,
        indices: indices,
        origin: { x: originX, y: originY, z: 7.5 },
    };
}

// Malla indexada desde listas de vértices por celda de rejilla
function makeIndexedMesh(verts, cells) {
    const positions = new Float32Array(verts.length * 3);
    for (let k = 0; k < verts.length; k++) {
        positions[k * 3] = verts[k][0];
        positions[k * 3 + 1] = verts[k][1];
        positions[k * 3 + 2] = verts[k].length > 2 ? verts[k][2] : planeZ(verts[k][0], verts[k][1]);
    }
    const indices = new Uint32Array(cells.length * 3);
    for (let k = 0; k < cells.length; k++) {
        indices[k * 3] = cells[k][0];
        indices[k * 3 + 1] = cells[k][1];
        indices[k * 3 + 2] = cells[k][2];
    }
    return { kind: 'mesh', positions: positions, indices: indices, origin: { x: 350000, y: 6300000, z: 0 } };
}

// Del mundo (del Dem) a coordenada local de la malla
function demNodeLocal(dem, mesh, i, j) {
    return [dem.originX - mesh.origin.x + i * dem.cellSize, dem.originY - mesh.origin.y + j * dem.cellSize];
}

test('fromMesh: plano 2 triángulos, heightAt exacto en nodos interiores y origen UTM', () => {
    const SR = buildDemBuilder();
    const mesh = makePlaneMesh();
    const dem = SR.DemBuilder.fromMesh(mesh, 1);
    assert.ok(dem instanceof SR.Dem);
    assert.equal(dem.cols, 11);
    assert.equal(dem.rows, 11);
    assert.equal(dem.cellSize, 1);
    closeTo(dem.originX, 350000, 1e-9, 'originX');
    closeTo(dem.originY, 6300000, 1e-9, 'originY');
    closeTo(dem.originZ, 7.5, 1e-9, 'originZ');
    for (let j = 1; j < dem.rows - 1; j++) {
        for (let i = 1; i < dem.cols - 1; i++) {
            const loc = demNodeLocal(dem, mesh, i, j);
            closeTo(dem.heightAt(loc[0], loc[1]), planeZ(loc[0], loc[1]), 1e-4, 'node ' + i + ',' + j);
        }
    }
});

test('fromMesh: origen redondeado hacia abajo a múltiplo de cellSize en mundo', () => {
    const SR = buildDemBuilder();
    const mesh = makePlaneMesh(10, 10, 350000.7, 6300000.9);
    const dem = SR.DemBuilder.fromMesh(mesh, 2);
    closeTo(dem.originX, 350000, 1e-9, 'originX redondeado');
    closeTo(dem.originY, 6300000, 1e-9, 'originY redondeado');
    assert.ok((dem.originX / 2) % 1 === 0, 'originX debe ser múltiplo de 2');
    assert.ok((dem.originY / 2) % 1 === 0, 'originY debe ser múltiplo de 2');
    // el plano sigue exacto en los nodos
    for (let j = 0; j < dem.rows; j++) {
        for (let i = 0; i < dem.cols; i++) {
            const loc = demNodeLocal(dem, mesh, i, j);
            if (Number.isFinite(dem.heights[j * dem.cols + i])) {
                closeTo(dem.heights[j * dem.cols + i], planeZ(loc[0], loc[1]), 1e-4, 'nodo ' + i + ',' + j);
            }
        }
    }
});

test('fromMesh: dos triángulos superpuestos a distinta altura → gana el más alto', () => {
    const SR = buildDemBuilder();
    // Dos triángulos con la MISMA huella XY (0,0)-(10,0)-(0,10): el segundo está 2 m
    // más arriba. En todo nodo cubierto el z-buffer debe entregar la cota + 2.
    const positions = new Float32Array(18);
    const base = [[0, 0], [10, 0], [0, 10]];
    for (let k = 0; k < 6; k++) {
        const v = base[k % 3];
        positions[k * 3] = v[0];
        positions[k * 3 + 1] = v[1];
        positions[k * 3 + 2] = planeZ(v[0], v[1]) + (k < 3 ? 0 : 2);
    }
    const mesh = { kind: 'mesh', positions: positions, indices: new Uint32Array([0, 1, 2, 3, 4, 5]), origin: { x: 350000, y: 6300000, z: 0 } };
    const dem = SR.DemBuilder.fromMesh(mesh, 1);
    let seen = 0;
    for (let k = 0; k < dem.heights.length; k++) {
        const z = dem.heights[k];
        if (Number.isFinite(z)) {
            seen++;
            const loc = demNodeLocal(dem, mesh, k % dem.cols, Math.floor(k / dem.cols));
            closeTo(z, planeZ(loc[0], loc[1]) + 2, 1e-4, 'z-buffer nodo ' + loc[0] + ',' + loc[1]);
        }
    }
    assert.ok(seen > 40, 'debe haber muchos nodos cubiertos, visto ' + seen);
});

test('fromMesh: malla con hueco (celda faltante) → NaN ahí', () => {
    const SR = buildDemBuilder();
    // rejilla 3x3 vértices (celdas de 1 m), se omite la celda (1,1)-(2,2)
    const verts = [];
    for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
            verts.push([i, j]);
        }
    }
    const cells = [
        [0, 1, 4], [0, 4, 3],   // celda (0,0)
        [1, 2, 5], [1, 5, 4],   // celda (1,0)
        [3, 4, 7], [3, 7, 6],   // celda (0,1)
        // falta celda (1,1): vértices 4,5,7,8
    ];
    const mesh = makeIndexedMesh(verts, cells);
    const dem = SR.DemBuilder.fromMesh(mesh, 1);
    const idx = function (i, j) { return j * dem.cols + i; };
    assert.ok(Number.isNaN(dem.heights[idx(2, 2)]), 'vértice huérfano de la celda faltante debe ser NaN');
    // los vértices 4,5,7 siguen compartidos por vecinas: finitos
    assert.ok(Number.isFinite(dem.heights[idx(1, 1)]));
    assert.ok(Number.isFinite(dem.heights[idx(2, 1)]));
    assert.ok(Number.isFinite(dem.heights[idx(1, 2)]));
    assert.ok(Number.isFinite(dem.heights[idx(0, 0)]));
});

test('fromMesh: maxCells excedido lanza Error en español con cellSize mínimo', () => {
    const SR = buildDemBuilder();
    const mesh = makePlaneMesh();
    let message = '';
    try {
        SR.DemBuilder.fromMesh(mesh, 0.001);
        assert.fail('debía lanzar');
    } catch (e) {
        message = e.message;
    }
    // Error de otro realm (sandbox vm): no usar instanceof Error del host.
    assert.ok(/[a-záéíóúñü]/.test(message), 'mensaje en español: ' + message);
    assert.ok(/maxCells/.test(message), 'mensaje menciona maxCells: ' + message);
    assert.ok(/cellSize/.test(message), 'mensaje sugiere cellSize: ' + message);
    const m = message.match(/cellSize\s*[><=]+\s*(\d+(?:\.\d+)?)\s*m/);
    const m2 = !m ? message.match(/(\d+(?:\.\d+)?)[a-z\[\] */]*m(?:etro|in)imo?/) : null;
    const min = m ? parseFloat(m[1]) : parseFloat(m2[1]);
    // El mínimo sugerido debe hacer caber la grilla: (10/cs+1)^2 <= 25e6 → cs >= 0.002.
    assert.ok(min >= 0.002 && min <= 0.1, 'mínimo recomendado entre 0.002 y 0.1: ' + min);
    const cs2 = Math.floor(10 / min) + 1;
    assert.ok(cs2 * cs2 <= 25e6, 'con el cellSize sugerido la grilla cabe: ' + cs2 + 'x' + cs2);
});

test('fromMesh: options.onProgress reporta fracciones crecientes hasta 1', () => {
    const SR = buildDemBuilder();
    const fracciones = [];
    const dem = SR.DemBuilder.fromMesh(makePlaneMesh(), 1, {
        onProgress: function (f) { fracciones.push(f); },
    });
    assert.ok(dem.cols > 0);
    assert.ok(fracciones.length > 0, 'onProgress debió llamarse');
    assert.ok(fracciones[fracciones.length - 1] === 1, 'última fracción = 1');
    for (let k = 1; k < fracciones.length; k++) {
        assert.ok(fracciones[k] >= fracciones[k - 1], 'fracción no decreciente');
    }
});

test('fromPoints: rejilla regular del plano (mean por defecto) → Dem igual al plano', () => {
    const SR = buildDemBuilder();
    const lista = [];
    for (let j = 0; j <= 10; j++) {
        for (let i = 0; i <= 10; i++) {
            lista.push([i, j, planeZ(i, j)]);
        }
    }
    const positions = new Float32Array(lista.length * 3);
    for (let k = 0; k < lista.length; k++) {
        positions[k * 3] = lista[k][0];
        positions[k * 3 + 1] = lista[k][1];
        positions[k * 3 + 2] = lista[k][2];
    }
    const points = { kind: 'points', positions: positions, origin: { x: 350000, y: 6300000, z: 0 } };
    const dem = SR.DemBuilder.fromPoints(points, 1);
    assert.equal(dem.cols, 11);
    assert.equal(dem.rows, 11);
    closeTo(dem.originX, 350000, 1e-9, 'originX');
    closeTo(dem.originY, 6300000, 1e-9, 'originY');
    for (let k = 0; k < dem.heights.length; k++) {
        const i = k % dem.cols;
        const j = Math.floor(k / dem.cols);
        closeTo(dem.heights[k], planeZ(i, j), 1e-4, 'nodo ' + i + ',' + j);
    }
});

test('fromPoints: modos min y max con dos puntos en el mismo nodo', () => {
    const SR = buildDemBuilder();
    const mk = function (zA, zB, mode) {
        const positions = new Float32Array([
            2, 2, zA,
            2, 2, zB,   // mismo nodo
        ]);
        return { kind: 'points', positions: positions, origin: { x: 0, y: 0, z: 0 } };
    };
    const demMin = SR.DemBuilder.fromPoints(mk(1, 3, 'min'), 1, { mode: 'min' });
    const demMax = SR.DemBuilder.fromPoints(mk(1, 3, 'max'), 1, { mode: 'max' });
    const demMean = SR.DemBuilder.fromPoints(mk(1, 3, 'mean'), 1, { mode: 'mean' });
    // dos puntos idénticos en XY → grilla mínima 2x2, el nodo (0,0) es el compartido
    assert.equal(demMin.cols, 2);
    assert.equal(demMin.rows, 2);
    closeTo(demMin.heights[0], 1, 1e-9, 'min');
    closeTo(demMax.heights[0], 3, 1e-9, 'max');
    closeTo(demMean.heights[0], 2, 1e-9, 'mean');
});

test('fromPoints: hueco de 2 celdas contiguas se rellena por IDW (±0.05 del plano)', () => {
    const SR = buildDemBuilder();
    const positions = [];
    for (let j = 0; j <= 10; j++) {
        for (let i = 0; i <= 10; i++) {
            if (i >= 2 && i <= 3 && j === 2) { continue; } // hueco de 2 celdas contiguas
            positions.push(i, j, planeZ(i, j));
        }
    }
    const points = { kind: 'points', positions: new Float32Array(positions), origin: { x: 350000, y: 6300000, z: 0 } };
    const dem = SR.DemBuilder.fromPoints(points, 1);
    for (let i = 2; i <= 3; i++) {
        const z = dem.heights[2 * dem.cols + i];
        assert.ok(Number.isFinite(z), 'hueco rellenado en ' + i + ',2');
        closeTo(z, planeZ(i, 2), 0.05, 'hueco ' + i + ',2');
    }
    // el resto de la grilla sigue siendo el plano exacto
    for (let j = 0; j <= 10; j++) {
        for (let i = 0; i <= 10; i++) {
            if (i >= 2 && i <= 3 && j === 2) { continue; }
            closeTo(dem.heights[j * dem.cols + i], planeZ(i, j), 1e-4, 'nodo ' + i + ',' + j);
        }
    }
});

test('fromPoints: hueco de 10x10 celdas queda NaN en el centro', () => {
    const SR = buildDemBuilder();
    const positions = [];
    for (let j = 0; j <= 20; j++) {
        for (let i = 0; i <= 20; i++) {
            if (i >= 5 && i <= 14 && j >= 5 && j <= 14) { continue; } // hueco 10x10
            positions.push(i, j, planeZ(i, j));
        }
    }
    const points = { kind: 'points', positions: new Float32Array(positions), origin: { x: 350000, y: 6300000, z: 0 } };
    const dem = SR.DemBuilder.fromPoints(points, 1);
    // centro del hueco (9..10, 9..10): lejos por >= 4 celdas del borde → NaN
    for (let j = 9; j <= 10; j++) {
        for (let i = 9; i <= 10; i++) {
            assert.ok(Number.isNaN(dem.heights[j * dem.cols + i]), 'centro del hueco grande debe quedar NaN en ' + i + ',' + j);
        }
    }
    // el borde del hueco sí se rellena
    assert.ok(Number.isFinite(dem.heights[6 * dem.cols + 6]), 'borde del hueco grande rellenado');
});

test('estimateCellSize: malla → cerca de la longitud media de arista; puntos → sqrt(area/n)', () => {
    const SR = buildDemBuilder();
    const mesh = makePlaneMesh(1, 1); // aristas 1, 1, 1.414 → media ~1.14
    const csMesh = SR.DemBuilder.estimateCellSize(mesh);
    assert.ok(Number.isFinite(csMesh) && csMesh >= 0.1, 'cs mesh finita >= 0.1, recibí ' + csMesh);
    assert.ok(csMesh <= 2.5, 'cs mesh razonable para aristas ~1.1, recibí ' + csMesh);
    assert.ok([0.1, 0.25, 0.5, 1, 2, 5].indexOf(csMesh) !== -1, 'cs mesh redondeada al set: ' + csMesh);

    // 100 puntos en cuadrado 10x10 → sqrt(100/100) = 1
    const positions = [];
    for (let j = 0; j < 10; j++) {
        for (let i = 0; i < 10; i++) {
            positions.push(i * (10 / 9), j * (10 / 9), 0);
        }
    }
    const points = { kind: 'points', positions: new Float32Array(positions), origin: { x: 0, y: 0, z: 0 } };
    const csPoints = SR.DemBuilder.estimateCellSize(points);
    assert.ok([0.1, 0.25, 0.5, 1, 2, 5].indexOf(csPoints) !== -1, 'cs puntos redondeada al set: ' + csPoints);
    assert.ok(Math.abs(csPoints - 1) <= 0.9, 'cs puntos razonable ~1, recibí ' + csPoints);
});

test('rendimiento: malla 1000x1000 vértices (~2M triángulos) a cellSize = espaciado en < 10 s', () => {
    const SR = buildDemBuilder();
    const N = 1000;
    const positions = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const k = (j * N + i) * 3;
            positions[k] = i;
            positions[k + 1] = j;
            positions[k + 2] = planeZ(i, j);
        }
    }
    const indices = new Uint32Array(2 * (N - 1) * (N - 1) * 3);
    let t = 0;
    for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
            const v00 = j * N + i;
            const v10 = j * N + i + 1;
            const v01 = (j + 1) * N + i;
            const v11 = (j + 1) * N + i + 1;
            indices[t++] = v00; indices[t++] = v10; indices[t++] = v11;
            indices[t++] = v00; indices[t++] = v11; indices[t++] = v01;
        }
    }
    const mesh = { kind: 'mesh', positions: positions, indices: indices, origin: { x: 350000, y: 6300000, z: 0 } };
    const t0 = performance.now();
    const dem = SR.DemBuilder.fromMesh(mesh, 1);
    const dt = performance.now() - t0;
    console.log('tiempo rasterizado 2M triángulos: ' + dt.toFixed(1) + ' ms');
    assert.equal(dem.cols, N);
    assert.equal(dem.rows, N);
    assert.ok(dt < 10000, 'rasterizado debía tardar < 10 s, tardó ' + (dt / 1000).toFixed(2) + ' s');
    // sanity: algunos nodos interiores exactos
    for (const [i, j] of [[100, 100], [500, 500], [999, 999]]) {
        closeTo(dem.heights[j * dem.cols + i], planeZ(i, j), 1e-4, 'sanity ' + i + ',' + j);
    }
});
