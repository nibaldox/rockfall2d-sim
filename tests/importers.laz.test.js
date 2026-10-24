'use strict';

/**
 * T6.4: descompresión LAZ en el importador LAS via laz-perf vendored en
 * vendor/laz-perf/ (script clásico + .wasm de al lado, embind LASZip).
 * Fixture: par equivalente point10.las / point10.las.laz (ver README en
 * tests/fixtures/laz-perf/). El WASM se inyecta al glue con instantiateWasm
 * leyendo el archivo con fs — el glue vendored no se modifica.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createContext, runScript, ROOT } = require('./helpers/load.js');

const LAZ_ERROR = 'LAZ comprimido aún no soportado: descomprímalo a LAS (p.ej. con laszip o PDAL) o exporte un DTM GeoTIFF';
const FIXTURE_LAS = path.join(ROOT, 'tests', 'fixtures', 'laz-perf', 'point10.las');
const FIXTURE_LAZ = path.join(ROOT, 'tests', 'fixtures', 'laz-perf', 'point10.las.laz');
const LAS_BYTES = new Uint8Array(fs.readFileSync(FIXTURE_LAS));
const LAZ_BYTES = new Uint8Array(fs.readFileSync(FIXTURE_LAZ));

function makeImporterCtx({ glue = true, moduleOptions = null } = {}) {
    const ctx = createContext({
        env: 'worker', // la marca web laz-perf exige 'window' o 'importScripts'
        extra: {
            TextDecoder: globalThis.TextDecoder,
            TextEncoder: globalThis.TextEncoder,
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
            importScripts: () => {},
        },
    });
    if (glue) {
        runScript(ctx, 'vendor/laz-perf/laz-perf.js');
    }
    ctx.SimRocas = ctx.SimRocas || {};
    ctx.SimRocas.lazPerfModuleOptions = moduleOptions || (() => ({
        locateFile: (p) => path.join(ROOT, 'vendor', 'laz-perf', p),
        instantiateWasm(imports, receiveInstance) {
            const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'vendor', 'laz-perf', 'laz-perf.wasm')));
            WebAssembly.instantiate(bytes, imports).then((r) => receiveInstance(r.instance, r.module));
            return null;
        },
    }));
    runScript(ctx, 'js/importers/las.js');
    return ctx;
}

function parseIn(ctx, bytes, options = {}, onProgress = null) {
    return ctx.SimRocas.importers.las.parse(bytes, options, onProgress);
}

function chunker(bytes, size) {
    return (async function* () {
        for (let i = 0; i < bytes.length; i += size) {
            yield bytes.subarray(i, Math.min(i + size, bytes.length));
        }
    })();
}

// --- fixture de referencia -------------------------------------------------

test('fixture equivalente: mismo header LAS 1.2 formato 0, clases 1 y 2', () => {
    const dvLaz = new DataView(LAZ_BYTES.buffer, LAZ_BYTES.byteOffset, LAZ_BYTES.byteLength);
    const dvLas = new DataView(LAS_BYTES.buffer, LAS_BYTES.byteOffset, LAS_BYTES.byteLength);
    for (const dv of [dvLaz, dvLas]) { // 'LASF'
        assert.equal(dv.getUint8(0) * 0x1000000 + dv.getUint8(1) * 0x10000 + dv.getUint8(2) * 0x100 + dv.getUint8(3), 0x4C415346);
        assert.equal(dv.getUint8(24), 1);
        assert.equal(dv.getUint8(25), 2);
        assert.equal(dv.getUint8(104) & 0x3F, 0); // formato 0
        assert.equal(dv.getUint32(107, true), 1065);
        assert.equal(dv.getUint16(105, true), 20);
    }
    assert.equal(dvLaz.getUint8(104) & 0xC0, 0x80); // el LAZ marca compresión
    assert.equal(dvLas.getUint8(104) & 0xC0, 0);
});

// --- equivalencia LAZ == LAS ------------------------------------------------

test('parse: el LAZ produce los mismos puntos que su LAS equivalente (filtro por defecto)', async () => {
    const ctx = makeImporterCtx();
    const laz = await parseIn(ctx, LAZ_BYTES, { name: 'point10.laz' });
    const las = await parseIn(ctx, LAS_BYTES, { name: 'point10.las' });
    assert.equal(laz.kind, 'points');
    assert.equal(laz.stats.version, '1.2');
    assert.equal(laz.stats.format, 0);
    assert.equal(laz.stats.pointsTotal, 1065);
    assert.equal(laz.stats.pointsTotal, las.stats.pointsTotal);
    assert.equal(laz.stats.pointsUsed, las.stats.pointsUsed);
    assert.equal(laz.stats.pointsUsed, 276); // clase 2: suelo
    assert.equal(laz.stats.groundOnly, true);
    assert.deepEqual(laz.origin, las.origin);
    assert.deepEqual(laz.positions, las.positions);
});

test('parse: equivalencia con groundOnly false (todas las clases no ruido)', async () => {
    const ctx = makeImporterCtx();
    const laz = await parseIn(ctx, LAZ_BYTES, { name: 'point10.laz', groundOnly: false });
    const las = await parseIn(ctx, LAS_BYTES, { name: 'point10.las', groundOnly: false });
    assert.equal(laz.stats.pointsUsed, 1065);
    assert.equal(laz.stats.pointsUsed, las.stats.pointsUsed);
    assert.equal(laz.stats.groundOnly, false);
    assert.deepEqual(laz.positions, las.positions);
});

test('parse: decimate en LAZ resulta igual que en su LAS equivalente', async () => {
    const ctx = makeImporterCtx();
    const laz = await parseIn(ctx, LAZ_BYTES, { name: 'point10.laz', decimate: 3 });
    const las = await parseIn(ctx, LAS_BYTES, { name: 'point10.las', decimate: 3 });
    assert.equal(laz.stats.pointsTotal, las.stats.pointsTotal);
    assert.equal(laz.stats.pointsUsed, las.stats.pointsUsed);
    assert.deepEqual(laz.positions, las.positions);
});

test('parse: la entrada LAZ como AsyncIterable (chunks) da el mismo resultado', async () => {
    const ctx = makeImporterCtx();
    const ref = await parseIn(ctx, LAZ_BYTES, { name: 'point10.laz' });
    const res = await parseIn(ctx, chunker(LAZ_BYTES, 500), { name: 'point10.laz', totalBytes: LAZ_BYTES.length });
    assert.deepEqual(res.positions, ref.positions);
    assert.deepEqual([res.origin.x, res.origin.y, res.origin.z], [ref.origin.x, ref.origin.y, ref.origin.z]);
});

// --- errores en español ------------------------------------------------------

test('parse: sin el global laz-perf -> error LAZ en español (mensaje exacto)', async () => {
    const ctx = makeImporterCtx({ glue: false });
    await assert.rejects(() => parseIn(ctx, LAZ_BYTES, { name: 'point10.laz' }), (e) => {
        assert.equal(e.message, LAZ_ERROR);
        return true;
    });
    // bits de compresión en un archivo con extensión .las
    const bits = new Uint8Array(LAS_BYTES);
    bits[104] = bits[104] | 0x80;
    await assert.rejects(() => parseIn(ctx, bits, { name: 'point10.las' }), (e) => {
        assert.equal(e.message, LAZ_ERROR);
        return true;
    });
});

test('parse: inicialización del WASM fallida -> error con mensaje en español (error en caché)', async () => {
    const ctx = makeImporterCtx({ moduleOptions: () => ({}) }); // sin instantiateWasm ni fetch en el sandbox
    await assert.rejects(() => parseIn(ctx, LAZ_BYTES, { name: 'point10.laz' }), (e) => {
        assert.match(e.message, /No se pudo inicializar el descompresor LAZ/, e.message);
        return true;
    });
    // la promesa queda en caché: un segundo intento no revienta ni cambia el mensaje
    await assert.rejects(() => parseIn(ctx, LAZ_BYTES, { name: 'point10.laz' }), (e) => {
        assert.ok(e.message.includes('descompresor LAZ'), e.message);
        return true;
    });
});

test('parse: LAZ corrupto (payload a cero) -> error de descompresión en español', async () => {
    const ctx = makeImporterCtx();
    const corrupto = new Uint8Array(LAZ_BYTES);
    corrupto.set(new Uint8Array(corrupto.length - 1301), 1301);
    await assert.rejects(() => parseIn(ctx, corrupto, { name: 'point10.laz' }), (e) => {
        assert.ok(e.message.includes('descomprimir'), e.message);
        return true;
    });
});

test('parse: tras un LAZ corrupto el módulo queda utilizable (delete/free correcto)', async () => {
    const ctx = makeImporterCtx();
    const corrupto = new Uint8Array(LAZ_BYTES);
    corrupto.set(new Uint8Array(corrupto.length - 1301), 1301);
    await assert.rejects(() => parseIn(ctx, corrupto, { name: 'point10.laz' }), (e) => {
        assert.ok(e.message.includes('descomprimir'), e.message);
        return true;
    });
    const ok = await parseIn(ctx, LAZ_BYTES, { name: 'point10.laz' });
    assert.equal(ok.stats.pointsTotal, 1065);
});

// --- worker simulado ---------------------------------------------------------

function makeFile(content, name) {
    const blob = new Blob([content]);
    Object.defineProperty(blob, 'name', { value: name });
    return blob;
}

function makeWorker() {
    const msgs = [];
    const ctx = createContext({
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
                    const p = path.posix.normalize(path.join('js', 'workers', String(f).split('?')[0]));
                    runScript(ctx, p);
                }
            },
        },
    });
    // Inyección del WASM sin tocar el glue ni el worker (igual que arriba).
    ctx.SimRocas = ctx.SimRocas || {};
    ctx.SimRocas.lazPerfModuleOptions = () => ({
        locateFile: (p) => path.join(ROOT, 'vendor', 'laz-perf', p),
        instantiateWasm(imports, receiveInstance) {
            const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'vendor', 'laz-perf', 'laz-perf.wasm')));
            WebAssembly.instantiate(bytes, imports).then((r) => receiveInstance(r.instance, r.module));
            return null;
        },
    });
    runScript(ctx, 'js/workers/import-worker.js');
    return { ctx, msgs };
}

async function waitEnd(msgs, ms = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const end = msgs.find(m => m.type === 'done' || m.type === 'error');
        if (end) return end;
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('timeout esperando done/error');
}

test('worker simulado: un .laz llega a done con DEM válido y formato las', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({
        data: { type: 'import', file: makeFile(LAZ_BYTES, 'point10.laz'), options: {} },
    });
    const end = await waitEnd(msgs);
    assert.equal(end.type, 'done', end.message || 'sin dem');
    assert.equal(end.info.format, 'las');
    assert.equal(end.info.stats.pointsTotal, 1065);
    const dem = ctx.SimRocas.Dem.fromTransferable(end.dem);
    assert.ok(dem.cols >= 2 && dem.rows >= 2, 'grilla mínima');
    // hay alturas finitas dentro de la grilla
    let finite = 0;
    for (let j = 0; j < dem.rows; j++) {
        for (let i = 0; i < dem.cols; i++) {
            if (Number.isFinite(dem.heights[j * dem.cols + i])) finite++;
        }
    }
    assert.ok(finite > 0, 'el DEM tiene alturas');
    // la malla de display es coherente
    assert.ok(end.displayMesh.indices.length > 0);
});

test('worker simulado: si el WASM de laz-perf no carga, solo falla el .laz y un .las sigue a done', async () => {
    const msgs = [];
    const ctx = createContext({
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
                    const p = path.posix.normalize(path.join('js', 'workers', String(f).split('?')[0]));
                    runScript(ctx, p);
                }
            },
        },
    });
    ctx.SimRocas = ctx.SimRocas || {};
    ctx.SimRocas.lazPerfModuleOptions = () => ({}); // el wasm no llegará: error solo al pedir LAZ
    runScript(ctx, 'js/workers/import-worker.js');
    ctx.onmessage({ data: { type: 'import', file: makeFile(LAZ_BYTES, 'point10.laz'), options: {} } });
    const fin1 = await waitEnd(msgs);
    assert.equal(fin1.type, 'error');
    assert.match(fin1.message, /LAZ/);
    // mismo worker: LAS sin comprimir no muere con el fallo del WASM de laz-perf
    const desde = msgs.length;
    ctx.onmessage({ data: { type: 'import', file: makeFile(LAS_BYTES, 'point10.las'), options: {} } });
    let fin2 = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 30000 && !fin2) {
        fin2 = msgs.slice(desde).find(m => m.type === 'done' || m.type === 'error');
        if (!fin2) { await new Promise(r => setTimeout(r, 5)); }
    }
    assert.ok(fin2, 'timeout esperando el segundo import');
    assert.equal(fin2.type, 'done', fin2.message || 'sin dem');
    assert.equal(fin2.info.format, 'las');
});

// --- rendimiento -------------------------------------------------------------

test('RB: descomprime el fixture LAZ rápido; mide puntos/s', async () => {
    const ctx = makeImporterCtx();
    const t0 = performance.now();
    const res = await parseIn(ctx, LAZ_BYTES, { name: 'point10.laz' });
    const dtMs = performance.now() - t0;
    const pps = res.stats.pointsTotal / (dtMs / 1000);
    console.log(`rendimiento LAZ fixture: ${res.stats.pointsTotal} pts en ${dtMs.toFixed(1)} ms => ${pps.toFixed(0)} pts/s`);
    assert.ok(dtMs < 5000, `demasiado lento: ${dtMs.toFixed(0)} ms`);
});
