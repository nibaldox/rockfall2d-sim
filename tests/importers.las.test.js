'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { loadScripts } = require('./helpers/load.js');

const ctx = loadScripts(['js/importers/las.js'], { env: 'node', extra: {} });
const importer = ctx.SimRocas.importers.las;

const LAZ_ERROR = 'LAZ comprimido aún no soportado: descomprímalo a LAS (p.ej. con laszip o PDAL) o exporte un DTM GeoTIFF';

// --- construcción de archivos LAS sintéticos ---

const SCALE = [0.001, 0.001, 0.001];
const OFFSET = [500000, 6020000, 300];

function makeHeader(opts = {}) {
    const minor = opts.minor == null ? 2 : opts.minor;
    const headerSize = minor >= 4 ? 375 : 227;
    const nPoints = opts.nPoints == null ? 0 : opts.nPoints;
    const format = opts.format == null ? 1 : opts.format;
    const recordLen = opts.recordLen == null ? 28 : opts.recordLen;
    const buf = Buffer.alloc(headerSize);
    buf.write('LASF', 0, 'latin1');
    buf.writeUInt8(1, 24);
    buf.writeUInt8(minor, 25);
    buf.writeUInt16LE(headerSize, 94);
    buf.writeUInt32LE(headerSize, 96); // offset a datos de puntos (sin VLRs)
    buf.writeUInt32LE(0, 100);
    buf.writeUInt8(format, 104);
    buf.writeUInt16LE(recordLen, 105);
    buf.writeUInt32LE(nPoints, 107);
    for (let c = 0; c < 3; c += 1) {
        buf.writeDoubleLE(SCALE[c], 131 + 8 * c);
        buf.writeDoubleLE(OFFSET[c], 155 + 8 * c);
    }
    if (minor >= 4) {
        buf.writeBigUInt64LE(BigInt(nPoints), 247);
    }
    return buf;
}

function makePoint(format, recordLen, world, cls) {
    const buf = Buffer.alloc(recordLen);
    for (let c = 0; c < 3; c += 1) {
        buf.writeInt32LE(Math.round((world[c] - OFFSET[c]) / SCALE[c]), c * 4);
    }
    if (format >= 6) {
        buf.writeUInt8(cls, 16);
    } else {
        buf.writeUInt8(cls, 15);
    }
    return buf;
}

function buildLas({ minor = 2, format = 1, points, formatByte = null }) {
    const recordLen = format >= 6 ? 30 : 28;
    const head = makeHeader({ minor, format, recordLen, nPoints: points.length });
    const body = Buffer.concat(points.map((p) => makePoint(format, recordLen, p.w, p.cls)));
    const buf = Buffer.concat([head, body]);
    if (formatByte !== null) {
        buf[104] = formatByte;
    }
    return buf;
}

function chunker(bytes, size) {
    return (async function* () {
        for (let i = 0; i < bytes.length; i += size) {
            yield bytes.subarray(i, Math.min(i + size, bytes.length));
        }
    })();
}

function parse(buf, options = {}, onProgress = null) {
    const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return importer.parse(view, options, onProgress);
}

// --- tests ---

test('detect: acepta .las y contenido LASF; enrutado de .laz hacia este importador', () => {
    assert.equal(importer.id, 'las');
    assert.deepEqual([...importer.extensions], ['.las']);
    assert.equal(importer.detect('nube.las'), true);
    assert.equal(importer.detect('NUBE.LAS', null), true);
    assert.equal(importer.detect('nube.laz'), true);
    const lasf = new Uint8Array(227);
    new TextEncoder().encodeInto('LASF', lasf);
    assert.equal(importer.detect('nube.dat', lasf), true);
    assert.equal(importer.detect('nube.dat', new Uint8Array([1, 2, 3, 4])), false);
});

test('parse: v1.2 formato 1, coordenadas UTM exactas, origin floor del primer punto', async () => {
    const pts = [
        { w: [510000.25, 6020000.75, 300.5], cls: 2 },
        { w: [510001.25, 6020001.75, 300.75], cls: 1 },
        { w: [510002.25, 6020002.75, 301.25], cls: 7 },
        { w: [510003.25, 6020003.75, 301.75], cls: 2 }
    ];
    const result = await parse(buildLas({ minor: 2, format: 1, points: pts }));
    assert.equal(result.kind, 'points');
    assert.equal(result.stats.version, '1.2');
    assert.equal(result.stats.format, 1);
    assert.equal(result.stats.pointsTotal, 4);
    assert.equal(result.stats.pointsUsed, 2); // solo clase 2; clase 7 excluida
    assert.equal(result.stats.groundOnly, true);
    assert.equal(result.stats.noGroundClass, false);
    assert.equal(result.stats.crsHint, null);
    assert.equal(result.origin.x, 510000);
    assert.equal(result.origin.y, 6020000);
    assert.equal(result.origin.z, 300);
    const expected = [
        0.25, 0.75, 0.5,
        3.25, 3.75, 1.75
    ];
    for (let i = 0; i < expected.length; i += 1) {
        assert.ok(Math.abs(result.positions[i] - expected[i]) < 1e-3, `pos ${i}: ${result.positions[i]} vs ${expected[i]}`);
    }
});

test('parse: v1.4 formato 6 lee contador uint64 del offset 247', async () => {
    const pts = [
        { w: [510000.125, 6020000.375, 300.25], cls: 6 },
        { w: [510001.125, 6020001.375, 301.25], cls: 1 }
    ];
    const result = await parse(buildLas({ minor: 4, format: 6, points: pts }));
    assert.equal(result.stats.version, '1.4');
    assert.equal(result.stats.format, 6);
    assert.equal(result.stats.pointsTotal, 2);
    assert.equal(result.stats.pointsUsed, 2);
    assert.equal(result.origin.x, 510000);
    assert.ok(Math.abs(result.positions[0] - 0.125) < 1e-3);
    assert.ok(Math.abs(result.positions[2] - 0.25) < 1e-3);
});

test('parse: filtro de suelo mezcla clases 1, 2 y 7 -> solo clase 2', async () => {
    const pts = [
        { w: [510000.5, 6020000.5, 300.5], cls: 1 },
        { w: [510001.5, 6020001.5, 300.5], cls: 2 },
        { w: [510002.5, 6020002.5, 300.5], cls: 7 },
        { w: [510003.5, 6020003.5, 300.5], cls: 2 },
        { w: [510004.5, 6020004.5, 300.5], cls: 1 }
    ];
    const result = await parse(buildLas({ points: pts }));
    assert.equal(result.stats.pointsUsed, 2);
    assert.equal(result.positions[0], 1.5); // primer punto de suelo es el índice 1
    assert.equal(result.positions[3], 3.5);
});

test('parse: sin clase 2 -> usa todos (excepto ruido) y activa noGroundClass', async () => {
    const pts = [
        { w: [510000.5, 6020000.5, 300.5], cls: 1 },
        { w: [510001.5, 6020001.5, 300.5], cls: 7 },
        { w: [510002.5, 6020002.5, 300.5], cls: 18 },
        { w: [510003.5, 6020003.5, 300.5], cls: 6 }
    ];
    const result = await parse(buildLas({ points: pts }));
    assert.equal(result.stats.pointsUsed, 2); // clases 1 y 6; 7 y 18 excluidos
    assert.equal(result.stats.groundOnly, false);
    assert.equal(result.stats.noGroundClass, true);
    assert.equal(result.positions[0], 0.5);
    assert.equal(result.positions[3], 3.5);
});

test('parse: groundOnly explícito false conserva todas las clases no ruido', async () => {
    const pts = [
        { w: [510000.5, 6020000.5, 300.5], cls: 1 },
        { w: [510001.5, 6020001.5, 300.5], cls: 2 },
        { w: [510002.5, 6020002.5, 300.5], cls: 7 }
    ];
    const result = await parse(buildLas({ points: pts }), { groundOnly: false });
    assert.equal(result.stats.pointsUsed, 2);
    assert.equal(result.stats.groundOnly, false);
    assert.equal(result.stats.noGroundClass, false);
});

test('parse: opciones decimate conserva 1 de cada N', async () => {
    const pts = [];
    for (let i = 0; i < 10; i += 1) {
        pts.push({ w: [510000 + 0.5 + i, 6020000.5, 300.5], cls: 2 });
    }
    const result = await parse(buildLas({ points: pts }), { decimate: 3 });
    assert.equal(result.stats.pointsTotal, 10);
    assert.equal(result.stats.pointsUsed, 4); // índices útiles 0, 3, 6, 9
    assert.equal(result.positions[0], 0.5);
    assert.ok(Math.abs(result.positions[3] - 3.5) < 1e-3);
    assert.ok(Math.abs(result.positions[6] - 6.5) < 1e-3);
    assert.ok(Math.abs(result.positions[9] - 9.5) < 1e-3);
});

test('parse: decimate con mezcla de clases y filtro de suelo', async () => {
    const cls = [2, 1, 2, 7, 2, 1, 2];
    const pts = cls.map((c, i) => ({ w: [510000.5 + i, 6020000.5, 300.5], cls: c }));
    const result = await parse(buildLas({ points: pts }), { decimate: 2 });
    assert.equal(result.stats.pointsTotal, 7);
    assert.equal(result.stats.pointsUsed, 2); // útiles (no ruido) 0..5 -> índices pares 0,2,4 -> clases 2,2,2
});

test('parse: streaming en bloques de 1, 7 y 4096 bytes -> resultados idénticos', async () => {
    const pts = [];
    for (let i = 0; i < 100; i += 1) {
        pts.push({
            w: [510000.25 + i * 0.5, 6020000.75 + i * 0.25, 300.5 + (i % 7) * 1.125],
            cls: [2, 1, 7, 18][i % 4]
        });
    }
    const buf = buildLas({ points: pts });
    const expected = await parse(buf);
    for (const size of [1, 7, 4096]) {
        const result = await importer.parse(chunker(new Uint8Array(buf), size), { totalBytes: buf.length }, null);
        assert.equal(result.stats.pointsTotal, expected.stats.pointsTotal, `chunkSize=${size}`);
        assert.equal(result.stats.pointsUsed, expected.stats.pointsUsed, `chunkSize=${size}`);
        assert.equal(result.origin.x, expected.origin.x, `chunkSize=${size}`);
        assert.equal(result.origin.y, expected.origin.y, `chunkSize=${size}`);
        assert.equal(result.origin.z, expected.origin.z, `chunkSize=${size}`);
        assert.equal(result.positions.length, expected.positions.length, `chunkSize=${size}`);
        let mismatch = -1;
        for (let i = 0; i < expected.positions.length; i += 1) {
            if (result.positions[i] !== expected.positions[i]) { mismatch = i; break; }
        }
        assert.equal(mismatch, -1, `chunkSize=${size} primer mismatch en ${mismatch}`);
    }
});

test('parse: streaming con onProgress(totalBytes) avanza y termina en 1', async () => {
    const pts = [{ w: [510000.5, 6020000.5, 300.5], cls: 2 }, { w: [510001.5, 6020000.5, 300.5], cls: 2 }];
    const buf = buildLas({ points: pts });
    const prog = [];
    await importer.parse(chunker(new Uint8Array(buf), 20), { totalBytes: buf.length }, (p) => prog.push(p));
    assert.ok(prog[0] > 0 && prog[0] < 1);
    assert.equal(prog[prog.length - 1], 1);
});

test('parse: bit 7 del byte de formato (comprimido) -> error LAZ', async () => {
    await assert.rejects(() => parse(buildLas({ points: [], formatByte: 0x80 | 1 })), (e) => {
        assert.equal(e.message, LAZ_ERROR);
        return true;
    });
    await assert.rejects(() => parse(buildLas({ points: [], formatByte: 0x40 | 1 })), (e) => {
        assert.equal(e.message, LAZ_ERROR);
        return true;
    });
});

test('parse: extensión .laz por options.name -> error LAZ con mensaje exacto', async () => {
    const pts = [{ w: [510000.5, 6020000.5, 300.5], cls: 2 }];
    await assert.rejects(() => parse(buildLas({ points: pts }), { name: 'nube.laz' }), (e) => {
        assert.equal(e.message, LAZ_ERROR);
        return true;
    });
});

test('parse: firma inválida -> error en español', async () => {
    const buf = buildLas({ points: [] });
    buf.write('RASF', 0, 'latin1');
    await assert.rejects(() => parse(buf), (e) => {
        assert.ok(e.message.includes('LASF'), e.message);
        return true;
    });
});

test('parse: formato no válido y cabecera incompleta -> errores en español', async () => {
    await assert.rejects(() => parse(buildLas({ points: [], formatByte: 11 })), (e) => {
        assert.ok(e.message.includes('Formato'), e.message);
        return true;
    });
    var buf = buildLas({ points: [{ w: [500000.5, 6020000.5, 300.5], cls: 2 }], formatByte: 1 });
    buf.writeUInt16LE(300, 94);
    await assert.rejects(() => parse(buf), (e) => {
        assert.ok(e.message.includes('incompleta'), e.message);
        return true;
    });
});

test('parse: archivo sin puntos de datos -> error en español', async () => {
    await assert.rejects(() => parse(buildLas({ points: [] })), (e) => {
        assert.ok(e.message.includes('puntos de datos'), e.message);
        return true;
    });
});

test('RB: rendimiento 5.000.000 de puntos formato 1 < 10 s', async () => {
    const N = 5_000_000;
    const recordLen = 28;
    const header = makeHeader({ minor: 2, format: 1, recordLen, nPoints: N });
    const body = new Uint8Array(N * recordLen);
    const dv = new DataView(body.buffer);
    for (let i = 0; i < N; i += 1) {
        const off = i * recordLen;
        dv.setInt32(off, 10000 + (i % 4000), true);                 // x mundo ~ 510010
        dv.setInt32(off + 4, 750 + Math.floor(i / 1000), true);     // y mundo
        dv.setInt32(off + 8, 500 + (i % 37), true);                 // z mundo
        dv.setUint8(off + 15, i % 3 === 0 ? 2 : 1);                 // clasificación
    }
    const bytes = new Uint8Array(Buffer.concat([header, new Uint8Array(body)]));
    const sizeMb = bytes.length / (1024 * 1024);
    const t0 = performance.now();
    const result = await parse(bytes);
    const dtMs = performance.now() - t0;
    const mbps = sizeMb / (dtMs / 1000);
    console.log(`rendimiento: ${sizeMb.toFixed(1)} MB en ${(dtMs / 1000).toFixed(2)} s => ${mbps.toFixed(0)} MB/s`);
    assert.equal(result.stats.pointsTotal, N);
    assert.equal(result.stats.pointsUsed, Math.ceil(N / 3));
    assert.ok(dtMs / 1000 < 10, `demasiado lento: ${dtMs.toFixed(0)} ms`);
});
