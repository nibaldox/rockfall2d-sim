'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TextDecoder, TextEncoder } = require('node:util');
const { loadScripts } = require('./helpers/load.js');

// Los tests cargan js/dem.js + js/importers/asc.js (asc exige Dem cargado antes)
function loadAsc(withDem = true) {
    const files = withDem ? ['js/dem.js', 'js/importers/asc.js'] : ['js/importers/asc.js'];
    const ctx = loadScripts(files, { env: 'node', extra: { TextDecoder } });
    return ctx;
}

const enc = new TextEncoder();
function strToBytes(s) { return enc.encode(s); }

function chunkArray(bytes, size) {
    const out = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
    if (out.length === 0) out.push(new Uint8Array(0));
    return out;
}

function assertKindFloat32(arr) {
    assert.strictEqual(Object.prototype.toString.call(arr), '[object Float32Array]');
}
function assertSameArr(a, b, tol = 0) {
    assert.strictEqual(a.length, b.length, `length ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) {
        if (tol === 0) assert.strictEqual(a[i], b[i], `idx ${i}`);
        else assert.ok(Math.abs(a[i] - b[i]) <= tol, `idx ${i}: ${a[i]} vs ${b[i]}`);
    }
}
function isNaNVal(v) { return typeof v === 'number' && Number.isNaN(v); }

// Grilla 3 columnas x 4 filas. Valores_[filaArchivo][columna] = fila*10 + col.
// La fila 0 del archivo es la NORTE (arriba).
const COLS = 3, ROWS = 4;
function gridVal(r, c) { return r * 10 + c; }
function gridText() {
    const lines = [
        `ncols ${COLS}`,
        `nrows ${ROWS}`,
        `xllcorner 100.0`,
        `yllcorner 200.0`,
        `cellsize 2.5`,
        `NODATA_value -9999`,
    ];
    for (let r = 0; r < ROWS; r++) {
        lines.push(Array.from({ length: COLS }, (_, c) => String(gridVal(r, c))).join(' '));
    }
    return lines.join('\n') + '\n';
}

test('detect: extensión .asc/.grd con cabecera ESRI presentes', () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    assert.strictEqual(asc.detect('malla.ASC', new Uint8Array(0)), true);
    assert.strictEqual(asc.detect('malla.grd', new Uint8Array(0)), true);
    assert.strictEqual(asc.detect('sinext', strToBytes('ncols 3\nnrows 4\n')), true);
    assert.strictEqual(asc.detect('foo.asc', strToBytes('v 0 0 0\nf 1 2 3\n')), false); // sin cabecera ESRI
    assert.strictEqual(asc.detect('foo.txt', strToBytes('hola\n')), false);
});

test('xllcorner: nodos en xll + (i+0.5)*cellsize, fila norte abajo', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const res = await asc.parse(strToBytes(gridText()).buffer);
    assert.strictEqual(res.kind, 'grid');
    const dem = res.dem;
    assert.strictEqual(dem.cols, COLS);
    assert.strictEqual(dem.rows, ROWS);
    assert.strictEqual(dem.cellSize, 2.5);
    assertKindFloat32(dem.heights);
    // origen mundo del nodo (0,0): xll + 0.5*cs, yll + 0.5*cs
    assert.strictEqual(dem.originX, 101.25);
    assert.strictEqual(dem.originY, 201.25);
    assert.strictEqual(dem.originZ, 0);
    // fila j del DEM (sur->norte) = fila del archivo (nrows-1-j)
    for (let j = 0; j < ROWS; j++) {
        const fileRow = ROWS - 1 - j;
        for (let i = 0; i < COLS; i++) {
            assert.strictEqual(dem.heights[j * COLS + i], gridVal(fileRow, i),
                `nodo (i=${i}, j=${j})`);
        }
    }
    // heightAt en nodos exactos
    for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < COLS; i++) {
            const fileRow = ROWS - 1 - j;
            const z = dem.heightAt(i * 2.5, j * 2.5);
            assert.strictEqual(z, gridVal(fileRow, i), `heightAt nodo (i=${i}, j=${j})`);
        }
    }
    // orientación: el borde SUR (j=0) tiene los valores de la ÚLTIMA fila del archivo
    assert.strictEqual(dem.heights[0], gridVal(ROWS - 1, 0));
    // el borde norte (j=rows-1) guarda la PRIMERA fila del archivo
    assert.strictEqual(dem.heights[(ROWS - 1) * COLS], gridVal(0, 0));
});

test('xllcenter: nodos en xll + i*cellsize', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const text = gridText().replace('xllcorner', 'xllcenter').replace('yllcorner', 'yllcenter');
    const res = await asc.parse(strToBytes(text).buffer);
    assert.strictEqual(res.dem.originX, 100);
    assert.strictEqual(res.dem.originY, 200);
    for (let j = 0; j < ROWS; j++) {
        const fileRow = ROWS - 1 - j;
        for (let i = 0; i < COLS; i++) {
            assert.strictEqual(res.dem.heights[j * COLS + i], gridVal(fileRow, i));
        }
    }
});

test('NODATA_value -> NaN en dem.heights', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const text = [
        'ncols 3', 'nrows 4', 'xllcorner 0', 'yllcorner 0', 'cellsize 1', 'NODATA_value -9999',
        '1 2 3',
        '4 -9999 6',
        '7 8 9',
        '-9999 11 12',
    ].join('\n') + '\n';
    const res = await asc.parse(strToBytes(text).buffer);
    const h = res.dem.heights;
    assert.ok(Number.isNaN(h[2 * 3 + 1]), 'celda NODATA interior (fila 1 del archivo -> fila 2 del Dem)');
    assert.ok(Number.isNaN(h[0 * 3 + 0]), 'celda NODATA borde sur');
    assert.strictEqual(h[3 * 3 + 2], 3); // fila norte del archivo = fila 0 del texto
    assert.strictEqual(h[3 * 3 + 0], 1);
    assert.strictEqual(h[0 * 3 + 2], 12); // fila sur = última del archivo
});

test('cabecera sin NODATA_value: todos los valores válidos', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const text = ['ncols 3', 'nrows 4', 'xllcenter 10', 'yllcenter 20', 'cellsize 1',
        '1 2 3', '4 5 6', '7 8 9', '10 11 12'].join('\n') + '\n';
    const res = await asc.parse(strToBytes(text).buffer);
    // fila j del Dem = fila (rows-1-j) del archivo: {1,2,3,4...12} quedan invertidas por filas
    for (let j = 0; j < ROWS; j++) {
        const fileRow = ROWS - 1 - j;
        for (let i = 0; i < COLS; i++) {
            assert.strictEqual(res.dem.heights[j * COLS + i], fileRow * COLS + i + 1,
                `nodo (i=${i}, j=${j})`);
        }
    }
});

test('dx y dy (en vez de cellsize) iguales se aceptan', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const text = ['ncols 3', 'nrows 4', 'xllcorner 0', 'yllcorner 0', 'dx 1.5', 'dy 1.5',
        '1 2 3', '4 5 6', '7 8 9', '10 11 12'].join('\n') + '\n';
    const res = await asc.parse(strToBytes(text).buffer);
    assert.strictEqual(res.dem.cellSize, 1.5);
});

test('dx y dy distintos -> error en español', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const text = ['ncols 3', 'nrows 4', 'xllcorner 0', 'yllcorner 0', 'dx 1.5', 'dy 2.5',
        '1 2 3', '4 5 6', '7 8 9', '10 11 12'].join('\n') + '\n';
    await assert.rejects(asc.parse(strToBytes(text).buffer), /dx.*dy|celda/i);
});

test('coordenadas UTM: origen Float64 sin pérdida', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const xll = 350123.456, yll = 6301234.789, cs = 0.125;
    const text = [`ncols ${COLS}`, `nrows ${ROWS}`, `xllcorner ${xll}`, `yllcorner ${yll}`, `cellsize ${cs}`,
        '1 2 3', '4 5 6', '7 8 9', '10 11 12'].join('\n') + '\n';
    const res = await asc.parse(strToBytes(text).buffer);
    const dem = res.dem;
    assert.strictEqual(dem.originX, xll + cs / 2);
    assert.strictEqual(dem.originY, yll + cs / 2);
    // localToWorld exacto en Float64 (comparaciónDriven por la precisión del double)
    const w = dem.localToWorld(0, 0);
    assert.ok(Math.abs(w.x - (xll + cs / 2)) < 1e-9);
    assert.ok(Math.abs(w.y - (yll + cs / 2)) < 1e-9);
});

test('streaming: bloques de 1, 7 y 4096 bytes dan el mismo DEM', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const bytes = strToBytes(gridText());
    const asyncFromChunks = async function* (chunks) {
        for (const c of chunks) yield c;
    };
    const full = await asc.parse(bytes.buffer);
    for (const size of [1, 7, 4096]) {
        const res = await asc.parse(asyncFromChunks(chunkArray(bytes, size)));
        assertSameArr(res.dem.heights, full.dem.heights);
        assert.strictEqual(res.dem.cols, full.dem.cols);
        assert.strictEqual(res.dem.rows, full.dem.rows);
        assert.strictEqual(res.dem.cellSize, full.dem.cellSize);
        assert.strictEqual(res.dem.originX, full.dem.originX);
        assert.strictEqual(res.dem.originY, full.dem.originY);
    }
});

test('cabecera inválida -> error en español', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    await assert.rejects(asc.parse(strToBytes('hola mundo\n').buffer),
        /cabecera/i);
    await assert.rejects(asc.parse(strToBytes('ncols 3\n').buffer),
        /cabecera|nrows/i);
    await assert.rejects(asc.parse(strToBytes('ncols abc\nnrows 2\nend\n').buffer),
        /cabecera|ncols/i);
});

test('sin SimRocas.Dem cargado -> error claro en español', async () => {
    const ctx = loadAsc(false);
    const asc = ctx.SimRocas.importers.asc;
    await assert.rejects(asc.parse(strToBytes(gridText()).buffer), /dem\.js/i);
});

test('progreso: onProgress monótono con totalBytes', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const bytes = strToBytes(gridText());
    let last = -1, calls = 0;
    await asc.parse(bytes.buffer, { totalBytes: bytes.length }, (f) => {
        assert.ok(f >= last && f >= 0 && f <= 1);
        last = f; calls++;
    });
    assert.ok(calls > 0, 'hubo callbacks');
    assert.ok(last >= 0.99, `última fracción ${last}`);
});

test('rendimiento: grilla 1200x1200 (~1.4M metros cuadrados) parsea en < 10 s', async () => {
    const ctx = loadAsc();
    const asc = ctx.SimRocas.importers.asc;
    const N = 1200;
    const parts = [];
    parts.push(`ncols ${N}\nnrows ${N}\nxllcorner 350000\nyllcorner 6300000\ncellsize 0.5\n`);
    for (let j = 0; j < N; j++) {
        let row = '';
        for (let i = 0; i < N; i++) {
            row += String(2500 + ((i * 7 + j * 13) % 100) * 0.01);
            row += (i === N - 1 ? '\n' : ' ');
        }
        parts.push(row);
    }
    const bytes = strToBytes(parts.join(''));
    const t0 = process.hrtime.bigint();
    const res = await asc.parse(bytes.buffer);
    const dt = Number(process.hrtime.bigint() - t0) / 1e9;
    assert.strictEqual(res.dem.cols, N);
    assert.strictEqual(res.dem.rows, N);
    const mb = bytes.length / (1024 * 1024);
    console.log(`[perf ASC] ${mb.toFixed(1)} MB en ${dt.toFixed(2)} s = ${(mb / dt).toFixed(1)} MB/s`);
    assert.ok(dt < 10, `parse tardó ${dt.toFixed(2)} s`);
});
