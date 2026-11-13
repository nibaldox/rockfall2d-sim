globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Importador GeoTIFF (DTM/DSM de vuelos de dron), C4 (ver js/importers/obj.js):
     * - parse(input, options, onProgress) async.
     * - input: ArrayBuffer | Uint8Array | AsyncIterable<Uint8Array> (bloques
     *   arbitrarios, se concatenan en un solo buffer contiguo).
     * - Devuelve { kind: 'grid', dem: Dem, stats: { width, height,
     *   bitsPerSample, sampleFormat, compression, noData, crs, pixelIsArea } }.
     *
     * Requiere el bundle vendorizado vendor/geotiff/geotiff.js (MIT, versión
     * 3.0.5): expone globalThis.GeoTIFF y funciona como script clásico y vía
     * importScripts en un Web Worker. Los decoders (Deflate, LZW, PackBits,
     * JPEG) van embebidos en el propio bundle: no hay fetch de workers ni de
     * decoders desde CDN. Al abrir con fromArrayBuffer no hay I/O externo.
     */

    SimRocas.importers = SimRocas.importers || {};

    // Tolerancia píxel cuadrado: diferencia relativa máxima entre |resX| y |resY|.
    // Los DTM de dron (Pix4D, Metashape, WebODM) tienen píxel cuadrado; el margen
    // 1e-6 relativo cubre el redondeo float64 del geo-transformation.
    const SQ_EPS = 1e-6;
    // Umbral NoData estilo GDAL: valores <= -1e30 o no finitos → NaN.
    const NO_DATA_LIMIT = -1e30;

    // GeoKeys GeoTIFF (tag 34735) que este importador usa.
    const KEY_GT_RASTER_TYPE = 1025;
    const KEY_GEOGRAPHIC_TYPE = 2048;
    const KEY_PROJECTED_CS_TYPE = 3072;

    // Detección estructural de ArrayBuffer / vista, válida entre realms
    // (los contextos vm tienen primordiales propios: instanceof fallaría).
    function isBinaryBuffer(input) {
        if (input === null || typeof input !== 'object') return false;
        if (ArrayBuffer.isView(input)) return true; // revisa un slot interno: cruza realms
        return typeof input.byteLength === 'number' && typeof (input.buffer) === 'undefined'
            && typeof input.split !== 'function'; // ArrayBuffer: byteLength sin length/buffer
    }

    // Recolecta ArrayBuffer | Uint8Array | AsyncIterable<Uint8Array> en un solo
    // Uint8Array contiguo (el bundle acepta un ArrayBuffer único).
    async function collectBytes(input) {
        if (isBinaryBuffer(input)) {
            return input instanceof Uint8Array ? input : new Uint8Array(input);
        }
        if (typeof input[Symbol.asyncIterator] !== 'function') {
            throw new Error('GeoTIFF: input debe ser ArrayBuffer, Uint8Array o AsyncIterable<Uint8Array>');
        }
        let total = 0;
        const chunks = [];
        for await (const chunk of input) {
            const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            chunks.push(u8);
            total += u8.length;
        }
        if (total === 0) {
            throw new Error('GeoTIFF: input vacío (0 bytes)');
        }
        const out = new Uint8Array(total);
        let pos = 0;
        for (const chunk of chunks) {
            out.set(chunk, pos);
            pos += chunk.length;
        }
        return out;
    }

    // Detect por magic: "II*\0" (clásico LE), "MM\0*" (clásico BE),
    // "II+\0" / "MM\0+" (BigTIFF).
    function detectMagic(headBytes) {
        if (!headBytes || headBytes.length < 4) return false;
        const b = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes);
        if (b[0] === 0x49 && b[1] === 0x49) { // little endian: II*\0 o II+\0
            return (b[2] === 42 && b[3] === 0) || (b[2] === 43 && b[3] === 0);
        }
        if (b[0] === 0x4D && b[1] === 0x4D) { // big endian: MM\0* o MM\0+
            return (b[2] === 0 && b[3] === 42) || (b[2] === 0 && b[3] === 43);
        }
        return false;
    }

    function toFiniteNumber(val) {
        if (val === null || val === undefined || val === '') return null;
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Extrae GTRasterTypeGeoKey, ProjectedCSTypeGeoKey y GeographicTypeGeoKey del
     * tag GeoKeyDirectory (34735), de forma manual y tolerante: parseGeoKeyDirectory()
     * de geotiff.js lanza si algún GeoKey no puede resolverse (valores ASCII/doble)
     * y acá solo nos interesan las claves simples de valor numérico.
     */
    function parseGeoKeys(fileDirectory) {
        const out = { rasterType: null, projected: null, geographic: null };
        const raw = fileDirectory.getValue('GeoKeyDirectory');
        if (!raw || raw.length < 8) return out;
        const count = Number(raw[3]) || 0;
        let p = 4;
        for (let k = 0; k < count; k++) {
            const id = raw[p];
            const loc = raw[p + 1];
            const cnt = raw[p + 2];
            const val = raw[p + 3];
            const esSimple = loc === 0 && cnt === 1;
            if (id === KEY_GT_RASTER_TYPE && esSimple) out.rasterType = val;
            else if (id === KEY_GEOGRAPHIC_TYPE && esSimple) out.geographic = val;
            else if (id === KEY_PROJECTED_CS_TYPE && esSimple) out.projected = val;
            p += 4;
        }
        return out;
    }

    function compressionName(code) {
        switch (code) {
            case undefined:
            case null:
            case 1: return 'none';
            case 5: return 'lzw';
            case 6: case 7: return 'jpeg';
            case 8: case 32946: return 'deflate';
            case 32773: return 'packbits';
            case 34887: case 50000: case 50001: return 'lerc';
            default: return 'desconocida(' + code + ')';
        }
    }

    SimRocas.importers.geotiff = {
        id: 'geotiff',
        extensions: ['.tif', '.tiff'],

        detect(name, headBytes) {
            if (typeof name === 'string') {
                const dot = name.lastIndexOf('.');
                if (dot >= 0) {
                    const ext = name.slice(dot).toLowerCase();
                    if (ext === '.tif' || ext === '.tiff') return true;
                }
            }
            return detectMagic(headBytes);
        },

        async parse(input, options = {}, onProgress = null) {
            void options;
            const bytes = await collectBytes(input);
            if (bytes.length === 0) {
                throw new Error('GeoTIFF: input vacío (0 bytes)');
            }

            // Global del bundle: self.GeoTIFF en un Web Worker, globalThis en el
            // navegador y en el sandbox de los tests.
            const gtGlobal = typeof self !== 'undefined' && self && self.GeoTIFF
                ? self.GeoTIFF
                : (typeof globalThis !== 'undefined' && globalThis.GeoTIFF ? globalThis.GeoTIFF : null);
            if (!gtGlobal) {
                throw new Error('GeoTIFF: el bundle vendor/geotiff/geotiff.js no fue cargado (falta el global GeoTIFF)');
            }

            if (onProgress) onProgress(0.05, 'GeoTIFF: cabeceras');
            const tiff = await gtGlobal.fromArrayBuffer(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            );
            const image = await tiff.getImage(0);
            if (onProgress) onProgress(0.25, 'GeoTIFF: imagen leida');

            const width = image.getWidth();
            const height = image.getHeight();
            if (!(width >= 2) || !(height >= 2)) {
                throw new Error('GeoTIFF: el DEM debe tener al menos 2x2 nodos (recibido: '
                    + width + 'x' + height + ')');
            }

            const bitsPerSample = image.getBitsPerSample ? image.getBitsPerSample() : null;
            const sampleFormat = image.getSampleFormat ? image.getSampleFormat() : null;
            const compressionRaw = toFiniteNumber(image.fileDirectory.getValue('Compression')) || 1;

            // --- Geo-transformation: ModelTiepoint (getOrigin: esquina sup-izq) ---
            //     y ModelPixelScale crudo (el signo de resY lo da el tag, no
            //     getResolution(), que lo normaliza a positivo).
            const rawOrigin = image.getOrigin(); // [X, Y, Z]
            const rawScale = image.fileDirectory.getValue('ModelPixelScale');
            if (!rawScale || rawScale.length < 2) {
                throw new Error('GeoTIFF: falta ModelPixelScale (tag 33550) — el archivo no georreferenciado');
            }
            const resX = Math.abs(Number(rawScale[0]));
            const resY = Math.abs(Number(rawScale[1]));
            if (!(resX > 0) || !(resY > 0) || !Number.isFinite(resX) || !Number.isFinite(resY)) {
                throw new Error('GeoTIFF: ModelPixelScale con resolución no finita o <= 0');
            }
            if (Math.abs(resX - resY) > SQ_EPS * Math.max(1, resX, resY)) {
                throw new Error('GeoTIFF: píxel no cuadrado (|resX|=' + resX + ', |resY|=' + resY
                    + ' m). Reescalá el DEM a píxel cuadrado antes de importar (remuestrear a grilla regular).');
            }

            // --- GeoKeys: CRS proyectado obligatorio ---
            const gk = parseGeoKeys(image.fileDirectory);
            if (gk.projected == null && gk.geographic != null) {
                throw new Error('GeoTIFF: el CRS es geográfico (grados, EPSG:'
                    + gk.geographic + '). Reproyectá el DEM a UTM '
                    + '(por ejemplo EPSG:32718/32719 para Chile) antes de importar.');
            }
            const crsCode = gk.projected != null ? gk.projected : gk.geographic;
            const crs = crsCode != null ? 'EPSG:' + crsCode : null;

            // --- NoData del GDAL ---
            const noDataRaw = image.getGDALNoData ? image.getGDALNoData() : null;
            const noDataValue = toFiniteNumber(noDataRaw); // '' o no parseable → null

            // --- Leer banda 0 ---
            if (onProgress) onProgress(0.4, 'GeoTIFF: leyendo banda 0');
            const rasters = await image.readRasters({ interleave: true, samples: [0] });
            const band = rasters instanceof Float32Array ? rasters : rasters[0];
            if (!band || band.length !== width * height) {
                throw new Error('GeoTIFF: inconsistencia al leer la banda 0 (recibidos '
                    + (band ? band.length : 0) + ' de ' + (width * height) + ' valores)');
            }

            // Mapeo dem (sur→norte) → raster:
            //   resY < 0 (norte arriba, caso estándar GDAL): fila j del DEM = fila
            //   raster (height-1-j); resY > 0 (raro, sur arriba): fila j = fila j.
            const resYSigned = Number(rawScale[1]);
            const demRowFromRasterRow = resYSigned < 0
                ? (r) => (height - 1 - r) // raster fila 0 (norte) al final del DEM
                : (r) => r;
            const heights = new Float32Array(width * height);
            for (let r = 0; r < height; r++) {
                const demRow = demRowFromRasterRow(r);
                const base = r * width;
                const demBase = demRow * width;
                for (let i = 0; i < width; i++) {
                    let z = band[base + i];
                    if (!Number.isFinite(z) || z <= NO_DATA_LIMIT
                        || (noDataValue !== null && z === noDataValue)) {
                        z = NaN;
                    }
                    heights[demBase + i] = z;
                }
            }

            // --- PixelIsArea (GTRasterTypeGeoKey 1, default) vs PixelIsPoint (2) ---
            // worldX(i) worldY(r): coordenadas de centro (área) o punto (punto) del
            // píxel, con resY con signo:
            //   worldX(i) = tieX + (i + (area ? 0.5 : 0))·resX
            //   worldY(r) = tieY + (r + (area ? 0.5 : 0))·resY  (resY < 0 = norte arriba)
            // Nodo (0, 0) del DEM (esquina sur-oeste del muestreo):
            const pixelIsArea = gk.rasterType !== 2; // 1 = área (default GDAL); 2 = punto
            const baseRasterRow = resYSigned < 0 ? height - 1 : 0;
            const nodeX0 = rawOrigin[0] + (pixelIsArea ? 0.5 * resX : 0);
            const nodeY0 = rawOrigin[1] + (baseRasterRow + (pixelIsArea ? 0.5 : 0)) * resYSigned;

            const dem = new SimRocas.Dem({
                cols: width,
                rows: height,
                cellSize: resX,
                heights: heights,
                originX: nodeX0,
                originY: nodeY0,
                originZ: 0,
                crs: crs,
            });

            const stats = {
                width: width,
                height: height,
                bitsPerSample: bitsPerSample != null ? bitsPerSample : null,
                sampleFormat: sampleFormat != null ? sampleFormat : null,
                compression: compressionName(compressionRaw),
                noData: noDataValue != null ? noDataValue : (noDataRaw !== '' && noDataRaw != null ? noDataRaw : null),
                crs: crs,
                pixelIsArea: pixelIsArea,
            };

            if (onProgress) onProgress(1, 'GeoTIFF: grid listo');
            return { kind: 'grid', dem: dem, stats: stats };
        },
    };
})(globalThis.SimRocas);
