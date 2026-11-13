'use strict';

/**
 * Tests del Worker de importación de terreno (T2.10, protocolo C5).
 *
 * Contexto 'worker' con shim de importScripts que resuelve rutas relativas a
 * js/workers/ (quitando el sufijo ?v). Los "archivos" son Blob de Node con
 * propiedad name (slice/arrayBuffer/stream de Blob funcionan igual que en un
 * File real para este protocolo).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const path = require('node:path');
const { createContext, runScript } = require('./helpers/load.js');

const WORKER_PATH = 'js/workers/import-worker.js';

// ---------------------------------------------------------------------------
// Entorno: worker simulado
// ---------------------------------------------------------------------------

function makeWorker() {
    const msgs = [];
    const transfers = [];
    let ctx;
    ctx = createContext({
        env: 'worker',
        extra: {
            TextDecoder: globalThis.TextDecoder,
            TextEncoder: globalThis.TextEncoder,
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
            Blob: globalThis.Blob,
            postMessage: (m, transfer) => {
                msgs.push(m);
                if (Array.isArray(transfer) && transfer.length > 0) transfers.push(transfer);
            },
            importScripts: (...files) => {
                for (const f of files) {
                    const rel = path.posix.normalize(path.join('js', 'workers', String(f).split('?')[0]));
                    runScript(ctx, rel);
                }
            },
        },
    });
    runScript(ctx, WORKER_PATH);
    return { ctx, msgs, transfers };
}

function makeFile(content, name) {
    const blob = new Blob([content]);
    blob.name = name;
    return blob;
}

/** Lanza la importación y espera 'done' o 'error' (microtasks del sandbox). */
async function waitDone(msgs, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const done = msgs.find(m => m.type === 'done');
        if (done) return done;
        const err = msgs.find(m => m.type === 'error');
        if (err) return err;
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('timeout esperando done/error del worker');
}

function findWarnings(msg) {
    assert.ok(msg && msg.type === 'done', 'se esperaba un mensaje done');
    return msg.info.warnings;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Triángulos de un plano inclinado z = 0.5·y local (dos triángulos).
const PLANE_OBJ = [
    'v 0 0 0',
    'v 10 0 0',
    'v 10 10 5',
    'v 0 10 5',
    'f 1 2 3',
    'f 1 3 4',
].join('\n') + '\n';

// STL binario en coordenadas UTM (mismo plano inclinado, z = 100 + 0.5·y_local).
function buildBinaryStl(triangles) {
    const buf = new ArrayBuffer(84 + 50 * triangles.length);
    const dv = new DataView(buf);
    dv.setUint32(80, triangles.length, true);
    let o = 84;
    for (const t of triangles) {
        o += 12; // normal (3 floats, en ceros: no se usa)
        for (const v of t) {
            dv.setFloat32(o, v[0], true);
            dv.setFloat32(o + 4, v[1], true);
            dv.setFloat32(o + 8, v[2], true);
            o += 12;
        }
        dv.setUint16(o, 0, true);
        o += 2;
    }
    return new Uint8Array(buf);
}

function utmPlaneTriangles() {
    return [
        [[500000, 6000000, 100], [500010, 6000000, 100], [500010, 6000010, 105]],
        [[500000, 6000000, 100], [500010, 6000010, 105], [500000, 6000010, 105]],
    ];
}

// Nube 10x10 con separador ';' y coma decimal: z = 100 + 2i + 0.1j (mundo);
// el origen del primer punto (100,5) da originZ = 100 → z local = 2i + 0.1j.
function buildXyzSemicolon() {
    const lines = [];
    for (let j = 0; j < 10; j++) {
        for (let i = 0; i < 10; i++) {
            const z = (100 + 2 * i + 0.1 * j).toFixed(1).replace('.', ',');
            lines.push((500000 + 2 * i) + ';' + (6000000 + 2 * j) + ';' + z);
        }
    }
    return lines.join('\n');
}

// ASC 4x3 directo con hole en (1,1) (nodata_value -9999).
function buildAsc({ withHole = false } = {}) {
    const rowsSouthToNorthFiles = []; // el archivo va norte → sur
    const head = 'ncols 4\nnrows 3\nxllcorner 10\nyllcorner 20\ncellsize 2\nNODATA_value -9999\n';
    // filas del archivo r = 0 (norte) .. 2 (sur); valor = 10*r + c
    const fileRows = [];
    for (let r = 0; r < 3; r++) {
        const vals = [];
        for (let c = 0; c < 4; c++) vals.push(String(10 * r + c));
        if (withHole && r === 2) vals[1] = '-9999'; // DEM fila 0 (sur), col 1
        fileRows.push(vals.join(' '));
    }
    return head + fileRows.join('\n') + '\n';
}

// Generador TIFF clásico (copia mínima de tests/importers.geotiff.test.js).
function writeTiff(opts) {
    const w = opts.width;
    const h = opts.height;
    const values = opts.values;
    const rowsPerStrip = opts.rowsPerStrip || h;
    const stripCount = Math.ceil(h / rowsPerStrip);
    const compression = opts.deflated ? 8 : 1;

    const planes = new Uint8Array(values.buffer, 0, w * h * 4);
    const strips = [];
    for (let s = 0; s < stripCount; s++) {
        const r0 = s * rowsPerStrip;
        const r1 = Math.min(r0 + rowsPerStrip, h);
        strips.push(planes.subarray(r0 * w * 4, r1 * w * 4));
    }
    const encoded = strips.map((c) => (opts.deflated ? zlib.deflateSync(c) : c));

    let off = 8;
    const stripOffsets = [];
    for (const st of encoded) {
        if (off & 1) off++;
        stripOffsets.push(off);
        off += st.length;
    }
    let extOff = (off + 7) & ~7;
    const SHORT = 3, LONG = 4, DOUBLE = 12, ASCII = 2;
    const typeSize = { 3: 2, 4: 4, 12: 8, 2: 1 };

    const entries = [];
    entries.push({ tag: 256, type: LONG, val: w });
    entries.push({ tag: 257, type: LONG, val: h });
    entries.push({ tag: 258, type: SHORT, val: 32 });
    entries.push({ tag: 259, type: SHORT, val: compression });
    entries.push({ tag: 273, type: LONG, arr: stripOffsets });
    entries.push({ tag: 277, type: SHORT, val: 1 });
    entries.push({ tag: 278, type: SHORT, val: rowsPerStrip });
    entries.push({ tag: 279, type: LONG, arr: encoded.map((s) => s.length) });
    entries.push({ tag: 339, type: SHORT, arr: [3] });
    entries.push({ tag: 33550, type: DOUBLE, arr: [opts.resX, opts.resY, 0] });
    entries.push({ tag: 33922, type: DOUBLE, arr: [0, 0, 0, opts.tie[0], opts.tie[1], 0] });
    if (opts.geoKeys && opts.geoKeys.length > 0) {
        const gk = [1, 1, 0, opts.geoKeys.length];
        for (const k of opts.geoKeys) gk.push(...k);
        entries.push({ tag: 34735, type: SHORT, arr: gk });
    }
    if (opts.nodata != null) {
        entries.push({ tag: 42113, type: ASCII, arr: [...Buffer.from(String(opts.nodata) + '\0', 'utf8')] });
    }
    entries.sort((a, b) => a.tag - b.tag);

    let eoff = extOff;
    const extBlobs = [];
    for (const en of entries) {
        if (en.val !== undefined) continue;
        const need = en.arr.length * typeSize[en.type];
        if (need <= 4) continue;
        if (en.type === DOUBLE) eoff = (eoff + 7) & ~7;
        else if (eoff & 1) eoff++;
        en.offset = eoff;
        const blob = new Uint8Array(need);
        const dv = new DataView(blob.buffer);
        for (let k = 0; k < en.arr.length; k++) {
            if (en.type === DOUBLE) dv.setFloat64(k * 8, en.arr[k], true);
            else if (en.type === SHORT) dv.setUint16(k * 2, en.arr[k], true);
            else if (en.type === LONG) dv.setUint32(k * 4, en.arr[k], true);
            else blob[k] = en.arr[k];
        }
        extBlobs.push(blob);
        eoff += need;
    }
    const ifdOffset = eoff;
    const total = ifdOffset + 2 + entries.length * 12 + 4;

    const out = new Uint8Array(total);
    const odv = new DataView(out.buffer);
    out[0] = 0x49; out[1] = 0x49;
    odv.setUint16(2, 42, true);
    odv.setUint32(4, ifdOffset, true);
    for (let s = 0; s < encoded.length; s++) {
        out.set(encoded[s], stripOffsets[s]);
    }
    for (const en of entries) {
        if (en.offset !== undefined) out.set(extBlobs.shift(), en.offset);
    }
    odv.setUint16(ifdOffset, entries.length, true);
    let p = ifdOffset + 2;
    for (const en of entries) {
        const n = en.val !== undefined ? 1 : en.arr.length;
        odv.setUint16(p, en.tag, true);
        odv.setUint16(p + 2, en.type, true);
        odv.setUint32(p + 4, n, true);
        if (en.val !== undefined) {
            if (en.type === SHORT) odv.setUint16(p + 8, en.val, true);
            else if (en.type === LONG) odv.setUint32(p + 8, en.val, true);
        } else if (n * typeSize[en.type] <= 4) {
            for (let k = 0; k < n; k++) {
                if (en.type === SHORT) odv.setUint16(p + 8 + k * 2, en.arr[k], true);
                else if (en.type === LONG) odv.setUint32(p + 8 + k * 4, en.arr[k], true);
                else out[p + 8 + k] = en.arr[k];
            }
        } else {
            odv.setUint32(p + 8, en.offset, true);
        }
        p += 12;
    }
    odv.setUint32(p, 0, true);
    return out;
}

function geotiffBytes() {
    const W = 5, H = 4;
    const values = new Float32Array(W * H);
    for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) values[r * W + c] = 100 * r + c;
    }
    return writeTiff({
        width: W, height: H, values, resX: 10, resY: -10, tie: [500000, 6000005],
        geoKeys: [[1024, 0, 1, 1], [1025, 0, 1, 1], [3072, 0, 1, 32719]],
    });
}

// Grilla OBJ 800x800 (spacing 1 m) generada en memoria (~45 MB).
function buildGridObjText(n) {
    const parts = [];
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            parts.push('v ' + i + ' ' + j + ' ' + (i + j) * 0.01);
        }
    }
    for (let j = 0; j + 1 < n; j++) {
        const r0 = j * n + 1;
        const r1 = (j + 1) * n + 1;
        for (let i = 0; i + 1 < n; i++) {
            const a = r0 + i;
            const b = r0 + i + 1;
            const c = r1 + i + 1;
            const d = r1 + i;
            parts.push('f ' + a + ' ' + b + ' ' + c);
            parts.push('f ' + a + ' ' + c + ' ' + d);
        }
    }
    return parts.join('\n') + '\n';
}

// OBJ plano → DEM 3x3 (cellSize sugerido 5), nodos en {0,5,10} → z = 0.5·y local.
// dem llega como toTransferable(); se reconstruye con Dem.fromTransferable.
function assertPlaneDem(ctx, transferable) {
    const dem = ctx.SimRocas.Dem.fromTransferable(transferable);
    assert.equal(dem.cols, 3);
    assert.equal(dem.rows, 3);
    assert.equal(dem.cellSize, 5);
    for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
            const h = dem.heightAt(i * 5, j * 5);
            assert.ok(Math.abs(h - 0.5 * (j * 5)) <= 1e-3,
                `heightAt(${i * 5},${j * 5}) = ${h}, esperado ${0.5 * j * 5}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

test('OBJ plano → done con DEM coherente, displayMesh válida y nota DSM', async () => {
    const { ctx, msgs, transfers } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(PLANE_OBJ, 'plano.obj'), options: {} } });
    const done = await waitDone(msgs);
    assert.equal(done.type, 'done');
    assert.equal(done.info.format, 'obj');
    assert.equal(done.info.fileName, 'plano.obj');
    assert.equal(done.info.fileBytes, PLANE_OBJ.length);
    assert.equal(done.info.cols, 3);
    assert.equal(done.info.rows, 3);
    assert.equal(done.info.validFraction, 1);
    assert.equal(done.info.crs, null);

    assertPlaneDem(ctx, done.dem);

    // displayMesh: nodos válidos, triángulos con índices en rango
    const dm = done.displayMesh;
    assert.equal(dm.positions.length, 3 * done.info.cols * done.info.rows);
    const vcount = dm.positions.length / 3;
    assert.ok(dm.indices.length === 8 * 3, `índices: ${dm.indices.length}`);
    for (let k = 0; k < dm.indices.length; k++) {
        assert.ok(dm.indices[k] < vcount, `índice ${dm.indices[k]} fuera de rango`);
    }
    // coordenadas locales al DEM: el vértice de la esquina este-norte está en (10, 10, 5)
    assert.equal(dm.positions[(vcount - 1) * 3], 10);
    assert.equal(dm.positions[(vcount - 1) * 3 + 1], 10);
    assert.equal(dm.positions[(vcount - 1) * 3 + 2], 5);

    // lista de transferencia: heights, positions, indices (sin copia)
    assert.equal(transfers.length, 1);
    const tr = transfers[0];
    assert.equal(tr.length, 3);
    assert.strictEqual(tr[0], done.dem.heights.buffer);
    assert.strictEqual(tr[1], dm.positions.buffer);
    assert.strictEqual(tr[2], dm.indices.buffer);

    // advertencias: nota DSM siempre; sin advertencia float32
    const warnings = findWarnings(done);
    assert.ok(warnings.some(w => /DSM/.test(w) && /DTM/.test(w)));
    assert.ok(!warnings.some(w => /precisión simple/.test(w)));
});

test('XYZ con separador ; y coma decimal → done con bining al nodo', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(buildXyzSemicolon(), 'nube.xyz'), options: {} } });
    const done = await waitDone(msgs);
    assert.equal(done.type, 'done');
    assert.equal(done.info.format, 'xyz');
    assert.equal(done.info.cellSize, 2);
    assert.equal(done.info.cols, 10);
    assert.equal(done.info.rows, 10);
    assert.equal(done.info.validFraction, 1);
    // z local = 2i + 0.1j en cada nodo
    const dem = ctx.SimRocas.Dem.fromTransferable(done.dem);
    for (const [i, j] of [[0, 0], [4, 4], [9, 9]]) {
        const h = dem.heightAt(i * 2, j * 2);
        assert.ok(Math.abs(h - (2 * i + 0.1 * j)) <= 1e-3,
            `heightAt(${i * 2},${j * 2}) = ${h}, esperado ${2 * i + 0.1 * j}`);
    }
    assert.equal(done.info.stats.points, 100);
    assert.equal(done.info.stats.separator, ';');
    assert.equal(done.info.stats.decimalComma, true);
    assert.ok(done.info.warnings.some(w => /DSM/.test(w)));
});

test('ASC directo → done con DEM del grid (kind grid)', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(buildAsc(), 'terreno.asc'), options: {} } });
    const done = await waitDone(msgs);
    assert.equal(done.type, 'done');
    assert.equal(done.info.format, 'asc');
    assert.equal(done.info.cellSize, 2);
    assert.equal(done.info.cols, 4);
    assert.equal(done.info.rows, 3);
    assert.equal(done.info.validFraction, 1);
    // fila del DEM j = fila del archivo (nrows-1-j): fila 0 del DEM (sur) = 20 21 22 23
    assert.equal(done.dem.heights[0], 20);
    assert.equal(done.dem.heights[3], 23);
    // fila 2 del DEM (norte) = fila 0 del archivo = 0 1 2 3
    assert.equal(done.dem.heights[2 * 4 + 1], 1);
    assert.equal(done.dem.heights[2 * 4 + 2], 2);
    assert.equal(done.dem.originX, 10 + 1); // xllcorner + cellSize/2
});

test('STL binario con coordenadas UTM → advertencia de precisión float32', async () => {
    const { ctx, msgs } = makeWorker();
    const stlBytes = buildBinaryStl(utmPlaneTriangles());
    ctx.onmessage({ data: { type: 'import', file: makeFile(stlBytes, 'terreno.stl'), options: {} } });
    const done = await waitDone(msgs);
    assert.equal(done.type, 'done');
    assert.equal(done.info.format, 'stl');
    const warnings = findWarnings(done);
    assert.ok(warnings.some(w => /precisión simple/.test(w) && /UTM/.test(w)),
        'falta la advertencia float32: ' + JSON.stringify(warnings));
    // el DEM sigue siendo coherente con el plano (z local = 0.5·y)
    const dem = ctx.SimRocas.Dem.fromTransferable(done.dem);
    assert.ok(Math.abs(dem.heightAt(5, 5) - 2.5) <= 1e-3);
    assert.ok(Math.abs(dem.heightAt(9.9, 0.1) - 0.05) <= 1e-3);
});

test('GeoTIFF sintético → done con DEM exacto y CRS', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(geotiffBytes(), 'dtm.tif'), options: {} } });
    const done = await waitDone(msgs);
    assert.equal(done.type, 'done');
    assert.equal(done.info.format, 'geotiff');
    assert.equal(done.info.cellSize, 10);
    assert.equal(done.info.cols, 5);
    assert.equal(done.info.rows, 4);
    assert.equal(done.info.crs, 'EPSG:32719');
    // fila DEM 0 (sur) = fila raster 3
    assert.equal(done.dem.heights[0], 300);
    // fila DEM 3 (norte) = fila raster 0; fila DEM 2 = fila raster 1
    assert.equal(done.dem.heights[3 * 5 + 2], 2);
    assert.equal(done.dem.heights[2 * 5 + 2], 102);
    assert.equal(done.info.stats.crs, 'EPSG:32719');
});

test('formato desconocido → error en español con lista de formatos soportados', async () => {
    const { ctx, msgs } = makeWorker();
    const garbage = new Uint8Array(64);
    for (let k = 0; k < garbage.length; k++) garbage[k] = (k * 37 + 11) % 251;
    ctx.onmessage({ data: { type: 'import', file: makeFile(garbage, 'misterio.dat'), options: {} } });
    const err = await waitDone(msgs);
    assert.equal(err.type, 'error');
    assert.match(err.message, /no reconocido/);
    assert.match(err.message, /Formatos soportados/);
    for (const token of ['OBJ', 'STL', 'PLY', 'XYZ', 'ASCII', 'GeoTIFF']) {
        assert.ok(err.message.includes(token), 'el mensaje debe listar ' + token);
    }
});

test('progreso: fases con valores monótonos crecientes y en orden read → parse → raster → mesh', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({ data: { type: 'import', file: makeFile(PLANE_OBJ, 'plano.obj'), options: {} } });
    await waitDone(msgs);
    const events = msgs.filter(m => m.type === 'progress');
    assert.ok(events.length >= 4, 'debe haber mensajes de progreso');
    const order = [];
    const byPhase = {};
    for (const m of events) {
        assert.ok(/^(read|parse|raster|mesh)$/.test(m.phase), `fase inválida: ${m.phase}`);
        assert.ok(Number.isFinite(m.progress) && m.progress >= 0 && m.progress <= 1,
            `progress inválido: ${m.progress}`);
        if (!byPhase[m.phase]) { byPhase[m.phase] = []; order.push(m.phase); }
        byPhase[m.phase].push(m.progress);
    }
    // orden de primera aparición
    assert.deepEqual(order.filter((p, i) => order.indexOf(p) === i), ['read', 'parse', 'raster', 'mesh']);
    // monotónico (no estricto) por fase
    for (const phase of Object.keys(byPhase)) {
        for (let k = 1; k < byPhase[phase].length; k++) {
            assert.ok(byPhase[phase][k] >= byPhase[phase][k - 1],
                `fase ${phase} no monótona: ${byPhase[phase][k - 1]} → ${byPhase[phase][k]}`);
        }
        assert.equal(byPhase[phase][byPhase[phase].length - 1], 1, `fase ${phase} termina en 1`);
    }
});

test('maxDisplayTriangles pequeño fuerza stride > 1', async () => {
    const { ctx, msgs } = makeWorker();
    ctx.onmessage({
        data: {
            type: 'import',
            file: makeFile(PLANE_OBJ, 'plano.obj'),
            options: { maxDisplayTriangles: 10 },
        },
    });
    const done = await waitDone(msgs);
    assert.equal(done.type, 'done');
    const dm = done.displayMesh;
    assert.ok(dm.stride > 1, 'stride debe ser > 1, es ' + dm.stride);
    // menos triángulos que con stride 1 (8 triángulos)
    assert.ok(dm.indices.length / 3 < 8);
    const vcount = dm.positions.length / 3;
    for (let k = 0; k < dm.indices.length; k++) {
        assert.ok(dm.indices[k] < vcount);
    }
});

test('displayMesh: los triángulos que tocan nodos NaN se excluyen', async () => {
    const { ctx, msgs } = makeWorker();
    // ASC 4x3: 12 nodos, hole en DEM (1,1); stride 1 → quads con 3 vértices válidos
    ctx.onmessage({ data: { type: 'import', file: makeFile(buildAsc({ withHole: true }), 'terreno.asc'), options: {} } });
    const done = await waitDone(msgs);
    const dm = done.displayMesh;
    const vcount = dm.positions.length / 3;
    assert.equal(vcount, 11, 'solo los nodos válidos tienen vértice');
    // posición del nodo NaN: (1*2, 1*2) local... esquina: el nodo inválido está en (x=2, y=0)
    assert.ok(!dm.positions.some((v, i) => i % 3 === 0 && v === 2 && dm.positions[i + 1] === 0),
        'no debe existir vértice en (2,0)');
    // índices válidos y ningún triángulo usando el vértice faltante
    for (let k = 0; k < dm.indices.length; k++) {
        assert.ok(dm.indices[k] < vcount);
        assert.ok(dm.indices[k] >= 0);
    }
    // el aviso de huecos aparece si la fracción válida es baja; aquí 11/12 no aplica,
    // pero ningún Warning float32 ni de huecos debe estar
    assert.ok(!done.info.warnings.some(w => /precisión simple/.test(w)));
});

test('validFraction < 0.5 genera aviso de muchos huecos', async () => {
    const { ctx, msgs } = makeWorker();
    // ASC 4x3 con NODATA casi en todas las filas: deja 5 valores válidos de 12
    const asc = 'ncols 4\nnrows 3\nxllcorner 10\nyllcorner 20\ncellsize 2\nNODATA_value -9999\n'
        + '-9999 -9999 -9999 -9999\n-9999 -9999 -9999 -9999\n5 6 7 8\n';
    ctx.onmessage({ data: { type: 'import', file: makeFile(asc, 'roto.asc'), options: {} } });
    const done = await waitDone(msgs);
    assert.equal(done.type, 'done');
    assert.ok(done.info.validFraction < 0.5);
    assert.ok(done.info.warnings.some(w => /hueco|sin dato/i.test(w)),
        'falta el aviso de huecos: ' + JSON.stringify(done.info.warnings));
});

test('rendimiento: OBJ de grilla 800x800 (~45 MB) → done en < 15 s', { timeout: 90000 }, async () => {
    const { ctx, msgs } = makeWorker();
    const text = buildGridObjText(800);
    const file = makeFile(text, 'grande.obj');
    assert.ok(file.size > 20 * 1024 * 1024, 'fixture debe superar los 20 MB');

    const rss0 = process.memoryUsage().rss;
    const t0 = Date.now();
    ctx.onmessage({ data: { type: 'import', file: file, options: { cellSize: 1 } } });
    const done = await waitDone(msgs, 60000);
    const dt = Date.now() - t0;
    const rss1 = process.memoryUsage().rss;

    assert.equal(done.type, 'done');
    assert.equal(done.info.cellSize, 1);
    assert.equal(done.info.cols, 800);
    assert.equal(done.info.rows, 800);
    assert.equal(done.dem.heights.length, 640000);
    // coherencia de altura en un punto: z = (x + y) * 0.01
    const demPerf = ctx.SimRocas.Dem.fromTransferable(done.dem);
    const hMid = demPerf.heightAt(400, 400);
    assert.ok(Math.abs(hMid - 8) <= 1e-3, `heightAt(400,400) = ${hMid}, esperado 8`);

    console.log('perf import-worker: ' + dt + ' ms | rss antes=' +
        (rss0 / 1048576).toFixed(0) + ' MB, después=' + (rss1 / 1048576).toFixed(0) +
        ' MB, delta=' + ((rss1 - rss0) / 1048576).toFixed(0) + ' MB');
    assert.ok(dt < 15000, 'la importación tardó ' + dt + ' ms (> 15 s)');
});
