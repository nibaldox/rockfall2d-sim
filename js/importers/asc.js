globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    SimRocas.importers = SimRocas.importers || {};

    const PROGRESS_STEP = 0.01; // notificar como máximo cada 1 %

    // Detección estructural de ArrayBuffer / vista, válida entre realms
    // (los contextos vm tienen primordiales propios: instanceof fallaría).
    function isBinaryBuffer(input) {
        if (input === null || typeof input !== 'object') return false;
        if (ArrayBuffer.isView(input)) return true;
        return typeof input.byteLength === 'number' && typeof (input.buffer) === 'undefined'
            && typeof input.split !== 'function';
    }

    /**
     * Importador ESRI ASCII Grid (.asc / .grd).
     *
     * Contrato C4:
     * - parse(input, options, onProgress) con input = ArrayBuffer | Uint8Array |
     *   AsyncIterable<Uint8Array> (bloques arbitrarios).
     * - Streaming por bloques con TextDecoder (líneas partidas entre bloques ok).
     * - Cabecera: ncols, nrows, xllcorner|xllcenter, yllcorner|yllcenter,
     *   cellsize (o dx y dy iguales), NODATA_value opcional.
     * - Las filas del archivo van de NORTE a SUR; la fila j del Dem (sur→norte)
     *   es la fila (nrows − 1 − j) del archivo.
     * - El Dem trabaja sobre NODOS: con xllcorner los valores son centros de
     *   celda, así que el nodo (i, j) está en xll + (i + 0.5)·cellSize; con
     *   xllcenter el nodo está en xll + i·cellSize.
     * - originX/originY = coordenada mundo del nodo (0,0) en Float64;
     *   originZ = 0; NODATA → NaN.
     * - Devuelve { kind: 'grid', dem: SimRocas.Dem }: requiere js/dem.js cargado.
     */
    SimRocas.importers.asc = {
        id: 'asc',
        extensions: ['.asc', '.grd'],

        detect(name, headBytes) {
            let hasExt = false;
            if (typeof name === 'string') {
                const dot = name.lastIndexOf('.');
                const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
                hasExt = ext === '.asc' || ext === '.grd';
            }
            if (hasExt && (!headBytes || headBytes.length === 0)) return true;
            if (!headBytes || headBytes.length === 0) return false;
            const bytes = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes);
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            return /\bncols\b/.test(text) && /\bnrows\b/.test(text);
        },

        async parse(input, options = {}, onProgress = null) {
            const totalBytes = typeof options.totalBytes === 'number' && options.totalBytes > 0 ? options.totalBytes : 0;
            if (typeof SimRocas.Dem !== 'function') {
                throw new Error('El importador ASC requiere SimRocas.Dem: carga js/dem.js antes de js/importers/asc.js.');
            }

            let consumed = 0;
            let lastNotified = 0;

            function notifyProgress() {
                if (!onProgress) return;
                let frac;
                if (totalBytes > 0) {
                    frac = Math.min(1, consumed / totalBytes);
                } else {
                    frac = 1; // sin total conocido: solo señal de avance completo
                }
                if (frac - lastNotified >= PROGRESS_STEP || frac >= 1) {
                    lastNotified = frac;
                    try {
                        onProgress(frac);
                    } catch (err) {
                        // el progreso no debe interrumpir el parseo
                    }
                }
            }

            const decoder = new TextDecoder('utf-8', { stream: true });
            let carry = '';

            const header = {
                ncols: -1, nrows: -1,
                xll: 0, yll: 0, cornerMode: true, hasX: false, hasY: false,
                cellSize: -1, dx: NaN, dy: NaN, nodata: NaN,
                complete: false
            };
            let heights = null;
            let cols = 0, rows = 0;
            let cursor = 0;      // índice en heights (orden del ARCHIVO: norte→sur)
            let written = 0;     // valores válidos escritos

            function readValueLine(token) {
                if (cursor >= heights.length) {
                    throw new Error('El archivo ESRI ASCII Grid tiene más valores que ncols × nrows.');
                }
                const v = Number(token);
                if (!Number.isFinite(v)) {
                    throw new Error(`El archivo ESRI ASCII Grid contiene un valor inválido: '${token}'.`);
                }
                // NODATA (y cualquier nº no finito) → NaN
                const value = Number.isNaN(header.nodata) || v !== header.nodata ? v : NaN;
                // el archivo va de NORTE a SUR: fila del archivo r -> fila del Dem (rows − 1 − r)
                const fileRow = Math.floor(cursor / cols);
                const col = cursor - fileRow * cols;
                heights[(rows - 1 - fileRow) * cols + col] = value;
                cursor++;
                written++;
            }

            function isHeaderKey(key) {
                switch (key) {
                    case 'ncols': case 'nrows':
                    case 'xllcorner': case 'xllcenter':
                    case 'yllcorner': case 'yllcenter':
                    case 'cellsize': case 'dx': case 'dy':
                    case 'nodata_value': case 'nodata':
                        return true;
                    default: return false;
                }
            }

            function applyHeaderKey(key, value) {
                switch (key) {
                    case 'ncols': header.ncols = value; break;
                    case 'nrows': header.nrows = value; break;
                    case 'xllcorner': header.xll = value; header.cornerMode = true; header.hasX = true; break;
                    case 'xllcenter': header.xll = value; header.cornerMode = false; header.hasX = true; break;
                    case 'yllcorner': header.yll = value; header.cornerMode = true; header.hasY = true; break;
                    case 'yllcenter': header.yll = value; header.cornerMode = false; header.hasY = true; break;
                    case 'cellsize': header.cellSize = value; break;
                    case 'dx': header.dx = value; break;
                    case 'dy': header.dy = value; break;
                    case 'nodata_value': case 'nodata': header.nodata = value; break;
                }
                if (Number.isFinite(header.dx) && Number.isFinite(header.dy) && header.dx !== header.dy) {
                    throw new Error('El archivo ESRI ASCII Grid declara dx y dy distintos;'
                        + ' solo se soportan celdas cuadradas.');
                }
            }

            function markHeaderComplete() {
                if (header.complete) return;
                const cellOk = header.cellSize > 0
                    || (Number.isFinite(header.dx) && Number.isFinite(header.dy) && header.dx === header.dy);
                if (header.ncols >= 2 && header.nrows >= 2 && cellOk && header.hasX && header.hasY) {
                    if (!(header.cellSize > 0)) header.cellSize = header.dx;
                    cols = header.ncols;
                    rows = header.nrows;
                    heights = new Float32Array(cols * rows);
                    header.complete = true;
                }
            }

            function handleLine(line) {
                const trimmed = line.trim();
                if (trimmed.length === 0) return;
                // las líneas de cabecera pueden aparecer en cualquier orden y la
                // NODATA_value suele ir tras cellsize: se reconocen por clave
                const sp = trimmed.indexOf(' ');
                {
                    const key = trimmed.slice(0, sp).toLowerCase();
                    if (sp > 0 && isHeaderKey(key)) {
                        const value = Number(trimmed.slice(sp + 1).trim());
                        if (!Number.isFinite(value)) {
                            throw new Error(`La cabecera del archivo ESRI ASCII Grid es inválida: '${trimmed}'.`);
                        }
                        applyHeaderKey(key, value);
                        markHeaderComplete();
                        return;
                    }
                }
                if (!header.complete) {
                    throw new Error(`La cabecera del archivo ESRI ASCII Grid es inválida: '${trimmed}'.`);
                }
                // cuerpo: valores separados por espacios
                const parts = trimmed.split(/\s+/);
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i].length > 0) readValueLine(parts[i]);
                }
            }

            function consumeText(text) {
                const joined = carry + text;
                let start = 0;
                let idx = joined.indexOf('\n', start);
                while (idx >= 0) {
                    let line = joined.slice(start, idx);
                    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
                        line = line.slice(0, -1); // CRLF
                    }
                    handleLine(line);
                    start = idx + 1;
                    idx = joined.indexOf('\n', start);
                }
                carry = joined.slice(start);
            }

            if (isBinaryBuffer(input)) {
                const bytes = ArrayBuffer.isView(input)
                    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                    : new Uint8Array(input);
                consumed += bytes.byteLength;
                consumeText(decoder.decode(bytes, { stream: true }));
                notifyProgress();
            } else if (input && typeof input[Symbol.asyncIterator] === 'function') {
                for await (const chunk of input) {
                    const u8 = ArrayBuffer.isView(chunk)
                        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                        : new Uint8Array(chunk);
                    consumed += u8.byteLength;
                    consumeText(decoder.decode(u8, { stream: true }));
                    notifyProgress();
                }
            } else {
                throw new Error('Formato de entrada no soportado para el importador ASC.');
            }

            // flush final del decodificador y de la última línea sin \n
            const tail = decoder.decode();
            if (tail.length > 0) consumeText(tail);
            if (carry.length > 0) {
                let line = carry;
                if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
                handleLine(line);
                carry = '';
            }
            notifyProgress();

            if (!header.complete) {
                throw new Error('La cabecera del archivo ESRI ASCII Grid es inválida: faltan'
                    + ' ncols, nrows, xllcorner/xllcenter, yllcorner/yllcenter y cellsize (o dx y dy).');
            }
            if (cursor < heights.length) {
                throw new Error(`El archivo ESRI ASCII Grid está truncado o incompleto: se esperaban`
                    + ` ${heights.length} valores y hay ${written}.`);
            }

            // coordenada mundo del nodo (0,0), que es la esquina SUR-OESTE
            const half = header.cornerMode ? header.cellSize / 2 : 0;
            const originX = header.xll + half;
            const originY = header.yll + half;

            // fila j del Dem (sur→norte) = fila del archivo (nrows − 1 − j)
            const dem = new SimRocas.Dem({
                cols, rows,
                cellSize: header.cellSize,
                heights,
                originX, originY,
                originZ: 0,
                crs: typeof options.crs === 'string' ? options.crs : null
            });

            return { kind: 'grid', dem };
        }
    };
})(globalThis.SimRocas);
