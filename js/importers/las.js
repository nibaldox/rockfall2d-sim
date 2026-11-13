globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    SimRocas.importers = SimRocas.importers || {};

    var EXTENSIONS = ['.las'];
    var LAZ_ERROR = 'LAZ comprimido aún no soportado: descomprímalo a LAS (p.ej. con laszip o PDAL) o exporte un DTM GeoTIFF';
    var LAZ_INIT_ERROR = 'No se pudo inicializar el descompresor LAZ (laz-perf): ';
    var MIN_HEADER = 227;
    var MAX_HEADER = 375;
    var HEADER_MIN_SIZE_FIELD = 96; // bytes necesarios para leer header size y offset a datos
    var COUNT_U64_OFFSET = 247;
    // Longitud de registro según formato (formato sin bits de compresión).
    var FORMAT_RECORD_LENGTHS = [20, 28, 26, 34, 28, 34, 30, 36, 38, 34, 40];
    var INITIAL_CAPACITY = 3 * 65536;
    var NOISE_CLASSES = { 7: true, 18: true };

    var lazModulePromise = null; // inicialización WASM cacheada (una por worker)

    function lazPerfAvailable() {
        return typeof globalThis.createLazPerf === 'function';
    }

    // Opciones del glue: locateFile configurable (se apunta a vendor/), y
    // SimRocas.lazPerfModuleOptions para que el host (p. ej. los tests) inyecte
    // instantiateWasm sin modificar el glue vendored.
    function lazModuleOptions() {
        var opts = {};
        var base = (globalThis.SimRocas && globalThis.SimRocas.lazPerfUrl) || null;
        if (base) {
            opts.locateFile = function (path_) {
                return String(base) + path_;
            };
        }
        if (globalThis.SimRocas && typeof globalThis.SimRocas.lazPerfModuleOptions === 'function') {
            var extra = globalThis.SimRocas.lazPerfModuleOptions() || {};
            for (var k in extra) {
                opts[k] = extra[k];
            }
        }
        return opts;
    }

    function getLazModule() {
        if (lazModulePromise === null) {
            // El rechazo queda en caché: los siguientes LAZ ven el mismo error.
            lazModulePromise = Promise.resolve().then(function () {
                return globalThis.createLazPerf(lazModuleOptions());
            });
        }
        return lazModulePromise;
    }

    // Descomprime un LAZ completo a registros crudos. laz-perf espera el
    // archivo ENTERO (cabecera + VLRs + datos) copiado a la memoria WASM.
    async function lazDecompress(bytes, header, totalBytes, onProgress) {
        var mod = null;
        var laszip = null;
        var filePtr = 0;
        var pointPtr = 0;
        try {
            try {
                mod = await getLazModule();
            } catch (initErr) {
                var causaInit = (initErr && initErr.message) ? String(initErr.message) : String(initErr);
                throw new Error(LAZ_INIT_ERROR + causaInit);
            }
            laszip = new mod.LASZip();
            filePtr = mod._malloc(bytes.length);
            if (!filePtr) {
                throw new Error('sin memoria del módulo WASM');
            }
            mod.HEAPU8.set(bytes, filePtr);
            laszip.open(filePtr, bytes.length);
            var count = laszip.getCount();
            if (!(count > 0)) {
                throw new Error('el LAZ no declara puntos');
            }
            var pointLen = laszip.getPointLength() || header.recordLength;
            pointPtr = mod._malloc(pointLen);
            if (!pointPtr) {
                throw new Error('sin memoria del módulo WASM');
            }
            var records = new Uint8Array(count * pointLen);
            for (var i = 0; i < count; i += 1) {
                laszip.getPoint(pointPtr);
                // El heap WASM puede crecer: siempre la vista fresca del módulo.
                var heap = mod.HEAPU8;
                records.set(heap.subarray(pointPtr, pointPtr + pointLen), i * pointLen);
                if (onProgress && totalBytes > 0 && (i % 4096 === 0 || i === count - 1)) {
                    onProgress(Math.min((header.dataStart + (i + 1) * pointLen) / totalBytes, 1));
                }
            }
            return { records: records, count: count, recLen: pointLen };
        } catch (err) {
            if (err && typeof err.message === 'string' && err.message.indexOf(LAZ_INIT_ERROR) === 0) {
                throw err; // ya en español
            }
            var causa = (err && typeof err.message === 'string' && err.message.length)
                ? err.message
                : (err ? String(err) : 'error desconocido');
            throw new Error('No se pudo descomprimir el LAZ: los datos comprimidos están corruptos, el archivo está truncado o el formato no está soportado (' + causa + ').');
        } finally {
            // Libera la memoria WASM al terminar o ante error (delete + free).
            if (mod) {
                try { if (pointPtr) { mod._free(pointPtr); } } catch (e) { /* noop */ }
                try { if (filePtr) { mod._free(filePtr); } } catch (e) { /* noop */ }
                try { if (laszip) { laszip.delete(); } } catch (e) { /* noop */ }
            }
        }
    }

    function isLazExtension(name) {
        if (name == null) {
            return false;
        }
        var lower = String(name).toLowerCase();
        return lower.length >= 4 && lower.indexOf('.laz') === lower.length - 4;
    }

    function hasLasExtension(name) {
        if (name == null) {
            return false;
        }
        var lower = String(name).toLowerCase();
        return lower.length >= 4 && lower.indexOf('.las') === lower.length - 4;
    }

    function toIterable(input) {
        if (ArrayBuffer.isView(input)) {
            return singleChunkIterable(input);
        }
        // instanceof no funciona entre realms; byteLength + slice identifica
        // un ArrayBuffer cross-realm de forma fiable.
        if (typeof input === 'object' && input !== null &&
            typeof input.byteLength === 'number' && typeof input.slice === 'function') {
            return singleChunkIterable(new Uint8Array(input, 0, input.byteLength));
        }
        return input;
    }

    async function* singleChunkIterable(view) {
        yield view;
    }

    SimRocas.importers.las = {
        id: 'las',
        extensions: EXTENSIONS,

        detect(name, headBytes) {
            if (hasLasExtension(name)) {
                return true;
            }
            // .laz se enruta aquí también: parse lanza el error LAZ explícito
            // (de lo contrario el archivo no llegaría a ningún importador).
            if (isLazExtension(name)) {
                return true;
            }
            if (!headBytes || headBytes.length < 4) {
                return false;
            }
            return headBytes[0] === 0x4C && headBytes[1] === 0x41 &&
                headBytes[2] === 0x53 && headBytes[3] === 0x46; // 'LASF'
        },

        async parse(input, options = {}, onProgress = null) {
            var decimate = Math.max(1, Math.floor(options.decimate == null ? 1 : options.decimate));
            var groundOnlyOpt = typeof options.groundOnly === 'boolean' ? options.groundOnly : null;
            var totalBytes = typeof options.totalBytes === 'number' ? options.totalBytes : 0;
            if (isLazExtension(options.name) && !lazPerfAvailable()) {
                throw new Error(LAZ_ERROR);
            }
            var lazMode = false; // se activa por extensión .laz o bits 6-7 del formato

            var pending = new Uint8Array(0);
            var header = null;
            var truncatedBytes = 0;
            var consumed = 0;

            function concat(a, b) {
                if (a.length === 0) {
                    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
                }
                var out = new Uint8Array(a.length + b.length);
                out.set(a, 0);
                out.set(b, a.length);
                return out;
            }

            function appendChunk(chunk) {
                var view = ArrayBuffer.isView(chunk)
                    ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                    : chunk;
                pending = concat(pending, view);
            }

            function checkSignature() {
                if (pending.length >= 4 && (pending[0] !== 0x4C || pending[1] !== 0x41 ||
                    pending[2] !== 0x53 || pending[3] !== 0x46)) {
                    throw new Error('La firma del archivo no es "LASF": no parece un archivo LAS.');
                }
            }

            function tryParseHeader() {
                checkSignature();
                if (pending.length < HEADER_MIN_SIZE_FIELD) {
                    return false;
                }
                var dv = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
                var major = dv.getUint8(24);
                var minor = dv.getUint8(25);
                if (major !== 1 || minor < 1 || minor > 4) {
                    throw new Error('Versión LAS no soportada: ' + major + '.' + minor + '.');
                }
                var headerSize = Math.max(MIN_HEADER, Math.min(MAX_HEADER, dv.getUint16(94, true)));
                if (pending.length < headerSize) {
                    return false;
                }
                var formatByte = dv.getUint8(104);
                if ((formatByte & 0xC0) !== 0) {
                    // bits 6-7: LAZ comprimido. Con laz-perf vendored se
                    // descomprime; sin él, el error en español de siempre.
                    if (!lazPerfAvailable()) {
                        throw new Error(LAZ_ERROR);
                    }
                    lazMode = true;
                }
                var format = formatByte & 0x3F;
                if (format > 10) {
                    throw new Error('Formato de puntos LAS no soportado: ' + format + '.');
                }
                var recordLength = dv.getUint16(105, true);
                var minLen = FORMAT_RECORD_LENGTHS[format];
                if (recordLength < minLen) {
                    throw new Error('La longitud del registro de puntos (' + recordLength +
                        ' bytes) es menor que la exigida por el formato ' + format + ' (' + minLen + ' bytes).');
                }
                var dataStart = dv.getUint32(96, true);
                if (dataStart < headerSize) {
                    throw new Error('El offset a los datos de puntos del LAS es menor que el tamaño de cabecera.');
                }
                var declaredCount = dv.getUint32(107, true);
                if (minor >= 4) {
                    var big = dv.getBigUint64(COUNT_U64_OFFSET, true);
                    if (big > 0n) {
                        declaredCount = Number(big);
                    }
                }
                var scale = [
                    dv.getFloat64(131, true),
                    dv.getFloat64(139, true),
                    dv.getFloat64(147, true)
                ];
                var offset = [
                    dv.getFloat64(155, true),
                    dv.getFloat64(163, true),
                    dv.getFloat64(171, true)
                ];
                for (var c = 0; c < 3; c += 1) {
                    if (!isFinite(scale[c]) || !isFinite(offset[c])) {
                        throw new Error('La cabecera LAS contiene escala u offset no válidos.');
                    }
                }
                header = {
                    major: major,
                    minor: minor,
                    format: format,
                    recordLength: recordLength,
                    declaredCount: declaredCount,
                    dataStart: dataStart,
                    scale: scale,
                    offset: offset
                };
                return true;
            }

            // --- acumulación y decodificación de registros tamaño fijo ---

            var stats = {
                pointsTotal: 0,
                pointsUsed: 0,
                version: null,
                format: null,
                groundOnly: false,
                noGroundClass: false,
                crsHint: null
            };
            var originSet = false;
            var ox = 0;
            var oy = 0;
            var oz = 0;
            var seenClass2 = false;
            var cursor = 0; // offset del próximo registro dentro de pending
            var decimCounter = 0;
            var capacity = INITIAL_CAPACITY;
            var positions = new Float32Array(capacity);
            var classes = new Uint8Array(capacity / 3);

            function ensureCapacity(count) {
                var need = count * 3;
                if (need <= capacity) {
                    return;
                }
                while (capacity < need) {
                    capacity *= 2;
                }
                var ns = new Float32Array(capacity);
                ns.set(positions);
                positions = ns;
                var nc = new Uint8Array(capacity / 3);
                nc.set(classes);
                classes = nc;
            }

            function feedData(endOfStream) {
                var recLen = header.recordLength;
                var start = header.dataStart;
                if (!originSet) {
                    cursor = Math.min(cursor, pending.length);
                }
                cursor = Math.max(cursor, start);
                var nRec = Math.floor((pending.length - cursor) / recLen);
                var remainder = pending.length - cursor - nRec * recLen;
                if (!endOfStream) {
                    // Solo registros completos; los bytes restantes aguardan al
                    // siguiente bloque.
                    if (nRec === 0) {
                        return;
                    }
                } else if (remainder > 0) {
                    truncatedBytes = remainder; // cola < recLen: ignorada
                }
                var dv = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
                var scale = header.scale;
                var offset = header.offset;
                for (var i = 0; i < nRec; i += 1) {
                    var base = cursor + i * recLen;
                    stats.pointsTotal += 1;
                    var cls = header.format <= 5
                        ? (pending[base + 15] & 0x1F)
                        : pending[base + 16];
                    if (NOISE_CLASSES[cls]) {
                        continue; // clase 7 (ruido bajo) y 18 (ruido alto) siempre fuera
                    }
                    if (cls === 2) {
                        seenClass2 = true;
                    }
                    if (decimCounter % decimate !== 0) {
                        decimCounter += 1;
                        continue;
                    }
                    decimCounter += 1;
                    // Coordenada = int32 × scale + offset, calculada en Float64.
                    var wx = (dv.getInt32(base, true) * scale[0]) + offset[0];
                    var wy = (dv.getInt32(base + 4, true) * scale[1]) + offset[1];
                    var wz = (dv.getInt32(base + 8, true) * scale[2]) + offset[2];
                    if (!originSet) {
                        ox = Math.floor(wx);
                        oy = Math.floor(wy);
                        oz = Math.floor(wz);
                        originSet = true;
                    }
                    ensureCapacity(stats.pointsUsed + 1);
                    var pbase = stats.pointsUsed * 3;
                    positions[pbase] = wx - ox;
                    positions[pbase + 1] = wy - oy;
                    positions[pbase + 2] = wz - oz;
                    classes[stats.pointsUsed] = cls;
                    stats.pointsUsed += 1;
                }
                cursor += nRec * recLen;
                if (endOfStream) {
                    // Libera todo lo procesado (el resultado puede exceder en bytes
                    // los registros keep: reducimos la retención al mínimo).
                    pending = new Uint8Array(0);
                }
            }

            try {
                var iterable = toIterable(input);
                var headerDone = false;
                for await (var chunk of iterable) {
                    consumed += chunk.byteLength;
                    appendChunk(chunk);
                    if (!headerDone) {
                        if (tryParseHeader()) {
                            headerDone = true;
                            stats.version = header.major + '.' + header.minor;
                            stats.format = header.format;
                            // Preasignación según el contador de la cabecera.
                            if (header.declaredCount > 0) {
                                ensureCapacity(Math.min(header.declaredCount, 4_194_304));
                            }
                            continue;
                        }
                        if (totalBytes > 0 && onProgress) {
                            onProgress(Math.min(consumed / totalBytes, 1));
                        }
                        continue;
                    }
                    if (lazMode) {
                        // LAZ: no streamable; el descompresor requiere el
                        // archivo completo, que se va acumulando en pending.
                        continue;
                    }
                    feedData(false);
                    if (totalBytes > 0 && onProgress) {
                        onProgress(Math.min(consumed / totalBytes, 1));
                    }
                }
                if (!headerDone) {
                    if (pending.length >= 4) {
                        checkSignature();
                    }
                    throw new Error('La cabecera LAS está incompleta.');
                }
                if (lazMode) {
                    // Arma el archivo entero (cabecera + VLRs + datos) para el
                    // descompresor, descomprime punto a punto con laz-perf y
                    // reconstruye CABECERA + registros crudos para que pending
                    // vuelva a ser un LAS plano que feedData consume con el
                    // MISMO código (clases, decimate, offsets, Float64).
                    var dataStart = header.dataStart;
                    var headBytes = pending.subarray(0, dataStart);
                    var lazBytes = new Uint8Array(pending.length);
                    lazBytes.set(pending, 0);
                    var dec = await lazDecompress(lazBytes, header, totalBytes, onProgress);
                    // la cabecera leída (dataStart, escala, offsets) es la del
                    // propio LAZ: el descompresor recibe el archivo entero.
                    var reconstruct = new Uint8Array(headBytes.length + dec.records.length);
                    reconstruct.set(headBytes, 0);
                    reconstruct.set(dec.records, headBytes.length);
                    pending = reconstruct;
                    // Los registros reconstruidos vienen compactos con la
                    // longitud real descomprimida del LAZ (puede coincidir o
                    // diferir del recLen de la cabecera): fijar el paso.
                    header.recordLength = dec.recLen;
                    cursor = dataStart;
                    feedData(true);
                    pending = new Uint8Array(0);
                } else {
                    feedData(true);
                }
            } catch (err) {
                if (err instanceof RangeError) {
                    throw new Error('No se pudo leer la entrada LAS: ' + err.message);
                }
                throw err;
            }
            if (onProgress && totalBytes > 0) {
                onProgress(1);
            }
            if (stats.pointsTotal === 0) {
                throw new Error('El archivo LAS no contiene puntos de datos.');
            }

            // --- fase 3: filtro de suelo (clase 2) por defecto si existe clase 2 ---
            var filtered = 0;
            if (groundOnlyOpt !== false && seenClass2) {
                var pos = 0;
                for (var g = 0; g < stats.pointsUsed; g += 1) {
                    if (classes[g] !== 2) {
                        continue;
                    }
                    positions[pos] = positions[g * 3];
                    positions[pos + 1] = positions[g * 3 + 1];
                    positions[pos + 2] = positions[g * 3 + 2];
                    pos += 3;
                }
                filtered = pos / 3;
                stats.groundOnly = true;
            } else {
                filtered = stats.pointsUsed;
                stats.groundOnly = false;
            }
            stats.noGroundClass = !seenClass2;
            stats.pointsUsed = filtered;
            positions = positions.slice(0, filtered * 3);

            if (stats.pointsUsed === 0) {
                throw new Error('El archivo LAS no contiene puntos que cumplan el filtro aplicado.');
            }

            return {
                kind: 'points',
                positions: positions,
                origin: { x: ox, y: oy, z: oz },
                stats: stats
            };
        }
    };
})(globalThis.SimRocas);
