'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { loadScripts } = require('./helpers/load.js');

// ---------------------------------------------------------------------------
// Contexto: 'worker' (self, sin window) + globals que exige el bundle
// vendor/geotiff/geotiff.js: TextDecoder, TextEncoder, setTimeout, clearTimeout.
// (console y performance ya los aporta el sandbox de helpers/load.js.)
// ---------------------------------------------------------------------------
const FILES = ['vendor/geotiff/geotiff.js', 'js/dem.js', 'js/importers/geotiff.js'];

const ctx = loadScripts(FILES, {
    env: 'worker',
    extra: { TextDecoder, TextEncoder, setTimeout, clearTimeout },
});
assert.equal(typeof ctx.GeoTIFF, 'object', 'el bundle debe exponer el global GeoTIFF');
const GeoTIFF = ctx.GeoTIFF;
const importer = ctx.SimRocas.importers.geotiff;

// ---------------------------------------------------------------------------
// Generador TIFF clasico little-endian de banda simple con extensiones
// GeoTIFF. Sin GDAL: los strips comprimidos se escriben con node:zlib
// (Compression 8 = Adobe Deflate, equivalente a zlib).
// opts: { width, height, values (Float32Array, fila raster 0 = NORTE), resX,
//         resY (con signo; negativo = norte arriba), tie [tieX, tieY],
//         deflated (true → Compression 8), geoKeys (entradas como
//         [keyId, loc, count, value]), nodata (string|null), rowsPerStrip }
// ---------------------------------------------------------------------------
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

    // layout: [header 8][strips, alineados 2][area externa (8B alineada)][IFD]
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

    const entries = []; // { tag, type, val (inline|undefined), arr, offset }
    entries.push({ tag: 256, type: LONG, val: w }); // ImageWidth
    entries.push({ tag: 257, type: LONG, val: h }); // ImageLength
    entries.push({ tag: 258, type: SHORT, val: 32 }); // BitsPerSample
    entries.push({ tag: 259, type: SHORT, val: compression }); // Compression
    entries.push({ tag: 273, type: LONG, arr: stripOffsets }); // StripOffsets
    entries.push({ tag: 277, type: SHORT, val: 1 }); // SamplesPerPixel
    entries.push({ tag: 278, type: SHORT, val: rowsPerStrip }); // RowsPerStrip
    entries.push({ tag: 279, type: LONG, arr: encoded.map((s) => s.length) }); // StripByteCounts
    entries.push({ tag: 339, type: SHORT, arr: [3] }); // SampleFormat=FLOAT
    entries.push({ tag: 33550, type: DOUBLE, arr: [opts.resX, opts.resY, 0] }); // ModelPixelScale
    entries.push({ tag: 33922, type: DOUBLE, arr: [0, 0, 0, opts.tie[0], opts.tie[1], 0] }); // ModelTiepoint
    if (opts.geoKeys && opts.geoKeys.length > 0) {
        const gk = [1, 1, 0, opts.geoKeys.length];
        for (const k of opts.geoKeys) gk.push(...k);
        entries.push({ tag: 34735, type: SHORT, arr: gk }); // GeoKeyDirectory
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
        if (need <= 4) continue; // inline
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
    out[0] = 0x49; out[1] = 0x49; // II
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
            // inline count==1 (uint/float 32 caben; ASCII 4 bytes como maximo)
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
    odv.setUint32(p, 0, true); // next IFD
    return out;
}

const UTM_19S = 32719; // EPSG:32719 (WGS 84 / UTM zona 19 sur)

function areaKeys(projected = UTM_19S) {
    return [
        [1024, 0, 1, 1], // GTModelTypeGeoKey = proyectado
        [1025, 0, 1, 1], // GTRasterTypeGeoKey = PixelIsArea
        [3072, 0, 1, projected], // ProjectedCSTypeGeoKey
    ];
}

function pointKeys(projected = UTM_19S) {
    return [
        [1024, 0, 1, 1],
        [1025, 0, 1, 2], // GTRasterTypeGeoKey = PixelIsPoint
        [3072, 0, 1, projected],
    ];
}

// 5 cols x 4 rows: valores raster[r][c] = 100*r + c (r = fila desde NORTE).
const W = 5;
const H = 4;
function baseValues() {
    const v = new Float32Array(W * H);
    for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
            v[r * W + c] = 100 * r + c;
        }
    }
    return v;
}

function parse(bytes, options = {}, onProgress = null) {
    return importer.parse(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), options, onProgress);
}

// ---------------------------------------------------------------------------

test('detect: acepta por extension y por magic TIFF/BigTIFF', () => {
    assert.equal(importer.id, 'geotiff');
    assert.deepEqual([...importer.extensions], ['.tif', '.tiff']);
    assert.equal(importer.detect('muesta.tif'), true);
    assert.equal(importer.detect('muesta.TIFF'), true);
    assert.equal(importer.detect('num.dat', new Uint8Array([0x49, 0x49, 42, 0])), true); // II*\0
    assert.equal(importer.detect('num.dat', new Uint8Array([0x4D, 0x4D, 0, 42])), true); // MM\0*
    assert.equal(importer.detect('num.dat', new Uint8Array([0x49, 0x49, 43, 0])), true); // BigTIFF LE
    assert.equal(importer.detect('num.dat', new Uint8Array([0x4D, 0x4D, 0, 43])), true); // BigTIFF BE
    assert.equal(importer.detect('num.dat', new TextEncoder().encode('v 1.0')), false);
    assert.equal(importer.detect('num.dat', new Uint8Array(0)), false);
});

test('parse: valores exactos y orientacion norte arriba (PixelIsArea)', async () => {
    const values = baseValues();
    // tie = esquina NOROESTE del raster; resY = -10 (fila 0 = norte).
    const bytes = writeTiff({
        width: W, height: H, values, resX: 10, resY: -10, tie: [500000, 6000005],
        geoKeys: areaKeys(), nodata: '-9999',
    });
    const result = await parse(bytes);
    assert.equal(result.kind, 'grid');
    const dem = result.dem;
    // La fila 0 del DEM (sur) = fila raster H-1 (la mas al sur).
    assert.equal(dem.heights[0 * W + 0], 100 * (H - 1) + 0); // 300
    assert.equal(dem.heights[0 * W + 2], 302);
    assert.equal(dem.heights[(H - 1) * W + 2], 2); // norte: fila raster 0
    assert.equal(dem.heights[(H - 1) * W + 4], 4);
    // Origen: nodo (0,0) = centro del pixel sur-oeste = tie + (0.5, (H-0.5))*res
    assert.equal(dem.cols, W);
    assert.equal(dem.rows, H);
    assert.equal(dem.cellSize, 10);
    assert.equal(dem.originX, 500000 + 0.5 * 10); // 500005
    assert.equal(dem.originY, 6000005 - (H - 0.5) * 10); // 6000005 - 45 = 5999960
    assert.equal(dem.originZ, 0);
    assert.equal(dem.crs, 'EPSG:' + UTM_19S);
    // Nodo (2, 1) → mundo.
    const w21 = dem.localToWorld(2 * 10, 1 * 10);
    assert.equal(w21.x, 500025);
    assert.equal(w21.y, 5999980);
    // Float64 exacto en el origen, Float32 en local (comprobación válida entre realms).
    assert.equal(Object.prototype.toString.call(dem.heights), '[object Float32Array]');
    // stats
    assert.equal(result.stats.width, W);
    assert.equal(result.stats.height, H);
    assert.equal(result.stats.bitsPerSample, 32);
    assert.equal(result.stats.sampleFormat, 3);
    assert.equal(result.stats.crs, 'EPSG:' + UTM_19S);
    assert.equal(result.stats.pixelIsArea, true);
});

test('parse: mismo raster con Deflate (Compression 8) da el DEM identico', async () => {
    const values = baseValues();
    const bytes = writeTiff({
        width: W, height: H, values, resX: 10, resY: -10, tie: [500000, 6000005],
        geoKeys: areaKeys(), deflated: true, rowsPerStrip: 2,
    });
    const result = await parse(bytes);
    assert.equal(result.stats.compression, 'deflate');
    // expect de DEM en orden sur→norte (fila DEM j = raster fila H-1-j)
    const expected = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            expected[j * W + i] = values[(H - 1 - j) * W + i];
        }
    }
    assert.deepEqual([...result.dem.heights], [...expected]);
    // orientacion: fila DEM 0 (sur) = raster fila 3
    assert.equal(result.dem.heights[0], 300);
    assert.equal(result.dem.heights[(H - 1) * W + 4], 4);
});

test('parse: compression "none" queda en stats', async () => {
    const bytes = writeTiff({
        width: W, height: H, values: baseValues(), resX: 10, resY: -10,
        tie: [500000, 6000005], geoKeys: areaKeys(),
    });
    const result = await parse(bytes);
    assert.equal(result.stats.compression, 'none');
});

test('parse: GDAL_NODATA -9999 → NaN y mantiene valores finitos', async () => {
    const values = baseValues();
    values[1] = -9999; // raster fila 0, col 1
    values[6] = -1e31; // <= -1e30 → NaN tambien
    values[7] = Infinity;
    const bytes = writeTiff({
        width: W, height: H, values, resX: 10, resY: -10, tie: [500000, 6000005],
        geoKeys: areaKeys(), nodata: '-9999',
    });
    const result = await parse(bytes);
    assert.equal(result.dem.heights[(H - 1) * W + 1], NaN); // -9999: raster (0,1) → DEM fila 3
    assert.equal(result.dem.heights[0 * W + 1], 301); // fila DEM 0 (sur) = raster 3, sin tocar
    // -1e31 y Infinity → NaN (raster idx 6/7 → DEM fila 2, col 1/2)
    assert.equal(result.dem.heights[(H - 2) * W + 1], NaN); // raster (1,1) = -1e31
    assert.equal(result.dem.heights[(H - 2) * W + 2], NaN); // raster (1,2) = Infinity
    assert.equal(result.stats.noData, -9999);
});

test('parse: PixelIsPoint (GTRasterTypeGeoKey 2) alinea el nodo con el punto', async () => {
    const bytes = writeTiff({
        width: W, height: H, values: baseValues(), resX: 10, resY: -10,
        tie: [500000, 6000005], geoKeys: pointKeys(),
    });
    const result = await parse(bytes);
    assert.equal(result.stats.pixelIsArea, false);
    // PixelIsPoint: esquina sin medio-pixel.
    assert.equal(result.dem.originX, 500000);
    assert.equal(result.dem.originY, 6000005 - (H - 1) * 10); // 5999965
    const wjTop = result.dem.localToWorld(4 * 10, (H - 1) * 10);
    assert.equal(wjTop.x, 500040);
    assert.equal(wjTop.y, 6000005);
});

test('parse: resY > 0 (sur arriba) invierte el mapeo de filas', async () => {
    // ResY positiva: raster fila 0 = sur → DEM fila 0 = raster fila 0.
    const values = baseValues();
    const bytes = writeTiff({
        width: W, height: H, values, resX: 10, resY: 10, tie: [500000, 5999965],
        geoKeys: areaKeys(),
    });
    const result = await parse(bytes);
    assert.equal(result.dem.heights[0], 0); // raster fila 0 (sur) al sur del DEM
    assert.equal(result.dem.heights[(H - 1) * W + 3], 303);
    // Nodo (0,0) = centro del pixel sur-oeste: tie + 0.5*res en Y hacia norte.
    assert.equal(result.dem.originX, 500005);
    assert.equal(result.dem.originY, 5999965 + 5);
});

test('parse: píxel no cuadrado lanza Error en español', async () => {
    const bytes = writeTiff({
        width: W, height: H, values: baseValues(), resX: 10, resY: 15,
        tie: [500000, 6000005], geoKeys: areaKeys(),
    });
    await assert.rejects(() => parse(bytes), (err) => {
        // los errores se crean dentro del sandbox vm: instanceof falla cruzando realms
        assert.equal(typeof err, 'object');
        assert.match(String(err.message), /no cuadrado/);
        return true;
    });
    // margen relativo 1e-6: 0.01/1000 = 1e-5 > 1e-6 → tambien error
    const bytes2 = writeTiff({
        width: W, height: H, values: baseValues(), resX: 1000, resY: 1000.01,
        tie: [500000, 6000005], geoKeys: areaKeys(),
    });
    await assert.rejects(() => parse(bytes2), /no cuadrado/);
});

test('parse: CRS geográfico (grados) lanza Error pidiendo reproyectar', async () => {
    const bytes = writeTiff({
        width: W, height: H, values: baseValues(), resX: 0.0001, resY: -0.0001,
        tie: [-70.5, -33.4],
        geoKeys: [[2048, 0, 1, 4326]], // GeographicTypeGeoKey, sin Projected
    });
    await assert.rejects(() => parse(bytes), (err) => {
        assert.equal(typeof err, 'object');
        assert.match(String(err.message), /geogr.fico/);
        assert.match(String(err.message), /Reproyect|UTM/);
        return true;
    });
});

test('parse: acepta Uint8Array, ArrayBuffer y AsyncIterable de bloques', async () => {
    const values = baseValues();
    const bytes = writeTiff({
        width: W, height: H, values, resX: 10, resY: -10, tie: [500000, 6000005],
        geoKeys: areaKeys(),
    });
    // Uint8Array
    const a = await parse(bytes);
    assert.equal(a.dem.heights[0], 300);
    // ArrayBuffer subyacente
    const b = await importer.parse(bytes.buffer.slice(0));
    assert.equal(b.dem.heights[0], 300);
    // AsyncIterable en bloques arbitrarios de 7 bytes
    async function* chunks() {
        for (let i = 0; i < bytes.length; i += 7) {
            yield bytes.subarray(i, Math.min(i + 7, bytes.length));
        }
    }
    const c = await importer.parse(chunks());
    assert.equal(c.dem.heights[0], 300);
    assert.deepEqual([...c.dem.heights], [...a.dem.heights]);
    // input invalido
    await assert.rejects(() => importer.parse('tiff'), /ArrayBuffer, Uint8Array o AsyncIterable/);
    await assert.rejects(() => importer.parse(new Uint8Array(0)), /vac/);
});

test('parse: NaN reales del raster quedan NaN y stats.noData null sin GDAL_NODATA', async () => {
    // Un GeoTIFF sin GDAL_NODATA: un valor NaN del raster se mantiene como NaN.
    const values = baseValues();
    values[11] = NaN;
    const bytes = writeTiff({
        width: W, height: H, values, resX: 10, resY: -10, tie: [500000, 6000005],
        geoKeys: areaKeys(),
    });
    const result = await parse(bytes);
    // raster 11 = fila 2, col 1 → DEM fila H-1-2 = 1, col 1
    assert.equal(result.dem.heights[1 * W + 1], NaN);
    assert.equal(result.stats.noData, null);
});

test('parse: onProgress recibe fraccion creciente y termina en 1', async () => {
    const bytes = writeTiff({
        width: W, height: H, values: baseValues(), resX: 10, resY: -10,
        tie: [500000, 6000005], geoKeys: areaKeys(),
    });
    const events = [];
    await parse(bytes, {}, (ratio) => events.push(ratio));
    assert.ok(events.length >= 2);
    assert.ok(events.every((r) => r >= 0 && r <= 1));
    assert.equal(events[events.length - 1], 1);
    // monotonico no estricto
    for (let k = 1; k < events.length; k++) {
        assert.ok(events[k] >= events[k - 1]);
    }
});

test('parse: toTransferable del Dem resultante es valido', async () => {
    const bytes = writeTiff({
        width: W, height: H, values: baseValues(), resX: 10, resY: -10,
        tie: [500000, 6000005], geoKeys: areaKeys(),
    });
    const result = await parse(bytes);
    const plainDem = ctx.SimRocas.Dem.fromTransferable(result.dem.toTransferable());
    assert.deepEqual([...plainDem.heights], [...result.dem.heights]);
    assert.equal(plainDem.originX, result.dem.originX);
});

test('bundle: expone fromArrayBuffer/writeArrayBuffer (sin CDN)', () => {
    assert.equal(typeof GeoTIFF.fromArrayBuffer, 'function');
    assert.equal(typeof GeoTIFF.writeArrayBuffer, 'function');
});
