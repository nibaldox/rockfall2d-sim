'use strict';

/**
 * Registro de los importadores DXF y LAS en el worker de importación
 * (js/workers/import-worker.js): detección, conversión a Dem y advertencias.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createContext, runScript } = require('./helpers/load.js');

function makeWorker() {
    const msgs = [];
    let ctx;
    ctx = createContext({
        env: 'worker',
        extra: {
            TextDecoder: globalThis.TextDecoder,
            TextEncoder: globalThis.TextEncoder,
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
            Blob: globalThis.Blob,
            postMessage: (m) => msgs.push(m),
            importScripts: (...files) => {
                for (const f of files) {
                    runScript(ctx, path.posix.normalize(path.join('js', 'workers', String(f).split('?')[0])));
                }
            },
        },
    });
    runScript(ctx, 'js/workers/import-worker.js');
    return { ctx, msgs };
}

function makeFile(content, name) {
    const blob = new Blob([content]);
    Object.defineProperty(blob, 'name', { value: name });
    return blob;
}

async function waitEnd(msgs, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const end = msgs.find(m => m.type === 'done' || m.type === 'error');
        if (end) return end;
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('timeout esperando done/error');
}

// Plano z = 0.2x + 0.1y + 100 sobre un cuadrado de 40 m en coordenadas UTM,
// como dos 3DFACE.
function planeDxf() {
    const ox = 350000;
    const oy = 6300000;
    const z = (x, y) => 0.2 * x + 0.1 * y + 100;
    const face = (pts) => {
        let s = '0\n3DFACE\n8\nTERRENO\n';
        const codes = [[10, 20, 30], [11, 21, 31], [12, 22, 32], [13, 23, 33]];
        pts.forEach((p, k) => {
            s += `${codes[k][0]}\n${ox + p[0]}\n${codes[k][1]}\n${oy + p[1]}\n${codes[k][2]}\n${z(p[0], p[1])}\n`;
        });
        return s;
    };
    return '0\nSECTION\n2\nENTITIES\n' +
        face([[0, 0], [40, 0], [40, 40], [40, 40]]) +
        face([[0, 0], [40, 40], [0, 40], [0, 40]]) +
        '0\nENDSEC\n0\nEOF\n';
}

// LAS 1.2, formato 0 (20 bytes por punto), grilla 21×21 de un plano con
// clase 2 (suelo) y algunos puntos de clase 1 elevados que deben filtrarse.
function planeLas() {
    const pts = [];
    for (let j = 0; j <= 20; j++) {
        for (let i = 0; i <= 20; i++) {
            const x = 350000 + i * 2;
            const y = 6300000 + j * 2;
            pts.push([x, y, 0.2 * (i * 2) + 0.1 * (j * 2) + 100, 2]);
        }
    }
    for (let k = 0; k < 30; k++) pts.push([350010 + k, 6300010, 180, 1]);
    const headerSize = 227;
    const recLen = 20;
    const buf = Buffer.alloc(headerSize + recLen * pts.length);
    buf.write('LASF', 0, 'ascii');
    buf.writeUInt8(1, 24);
    buf.writeUInt8(2, 25);
    buf.writeUInt16LE(headerSize, 94);
    buf.writeUInt32LE(headerSize, 96);
    buf.writeUInt32LE(0, 100);
    buf.writeUInt8(0, 104);
    buf.writeUInt16LE(recLen, 105);
    buf.writeUInt32LE(pts.length, 107);
    const scale = 0.001;
    buf.writeDoubleLE(scale, 131);
    buf.writeDoubleLE(scale, 139);
    buf.writeDoubleLE(scale, 147);
    buf.writeDoubleLE(350000, 155);
    buf.writeDoubleLE(6300000, 163);
    buf.writeDoubleLE(0, 171);
    pts.forEach((p, k) => {
        const o = headerSize + k * recLen;
        buf.writeInt32LE(Math.round((p[0] - 350000) / scale), o);
        buf.writeInt32LE(Math.round((p[1] - 6300000) / scale), o + 4);
        buf.writeInt32LE(Math.round(p[2] / scale), o + 8);
        buf.writeUInt8(p[3], o + 15);
    });
    return new Uint8Array(buf);
}

test('DXF con 3DFACE se detecta, se convierte a Dem y reproduce el plano', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(planeDxf(), 'ladera.dxf'), options: { cellSize: 1 } } });
    const end = await waitEnd(msgs);
    assert.equal(end.type, 'done', end.message);
    assert.equal(end.info.format, 'dxf');
    const dem = ctx.SimRocas.Dem.fromTransferable(end.dem);
    const w = dem.localToWorld(10, 10, 0);
    const expected = 0.2 * (w.x - 350000) + 0.1 * (w.y - 6300000) + 100;
    const got = dem.heightAt(10, 10) + dem.originZ;
    assert.ok(Math.abs(got - expected) < 1e-2, `cota ${got} vs ${expected}`);
});

test('LAS se detecta por firma, filtra el suelo y reproduce el plano', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(planeLas(), 'vuelo.las'), options: { cellSize: 2 } } });
    const end = await waitEnd(msgs);
    assert.equal(end.type, 'done', end.message);
    assert.equal(end.info.format, 'las');
    const dem = ctx.SimRocas.Dem.fromTransferable(end.dem);
    let maxErr = 0;
    for (let j = 1; j < dem.rows - 1; j++) {
        for (let i = 1; i < dem.cols - 1; i++) {
            const z = dem.heightAt(i * dem.cellSize, j * dem.cellSize);
            if (!Number.isFinite(z)) continue;
            const w = dem.localToWorld(i * dem.cellSize, j * dem.cellSize, z);
            const expected = 0.2 * (w.x - 350000) + 0.1 * (w.y - 6300000) + 100;
            maxErr = Math.max(maxErr, Math.abs(w.z - expected));
        }
    }
    assert.ok(maxErr < 0.05, `error máximo ${maxErr} m (la vegetación de clase 1 debe filtrarse)`);
});

test('LAZ: un archivo re-nombrado .laz con contenido LAS sin comprimir importa bien', async () => {
    // Antes de laz-perf, todo .laz daba error; ahora solo falla el realmente
    // comprimido (con el WASM ausente; ver tests/importers.laz.test.js).
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(planeLas(), 'vuelo.laz'), options: {} } });
    const end = await waitEnd(msgs);
    assert.equal(end.type, 'done', end.message);
    assert.equal(end.info.format, 'las');
    assert.equal(end.info.stats.pointsTotal, 471); // 441 grilla + 30 vegetación
});

test('texto arbitrario sin formato reconocible no se confunde con DXF', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile('hola mundo\nesto no es un terreno\n', 'notas.dat'), options: {} } });
    const end = await waitEnd(msgs);
    assert.equal(end.type, 'error');
    assert.match(end.message, /no reconocido/);
    assert.match(end.message, /DXF/);
    assert.match(end.message, /LAS/);
});
