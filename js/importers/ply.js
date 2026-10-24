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

    // Tamaño en bytes de cada tipo PLY (aliases normalizados a canónicos)
    const TYPE_SIZES = {
        int8: 1, uint8: 1,
        int16: 2, uint16: 2,
        int32: 4, uint32: 4,
        float32: 4, float64: 8
    };

    function normalizeType(t) {
        switch (t) {
            case 'char': return 'int8';
            case 'uchar': return 'uint8';
            case 'short': return 'int16';
            case 'ushort': return 'uint16';
            case 'int': return 'int32';
            case 'uint': return 'uint32';
            case 'float': return 'float32';
            case 'double': return 'float64';
            default: return t;
        }
    }

    function assertKnownType(type, context) {
        if (!Object.prototype.hasOwnProperty.call(TYPE_SIZES, type)) {
            throw new Error(`El archivo PLY usa un tipo de propiedad desconocido (${type}) en ${context}.`);
        }
    }

    /**
     * Importador PLY (ascii 1.0 y binary_little_endian 1.0).
     *
     * Contrato C4:
     * - parse(input, options, onProgress) con input = ArrayBuffer | Uint8Array |
     *   AsyncIterable<Uint8Array> (bloques arbitrarios).
     * - parseo SIEMPRE en Float64 (Number): coordenadas double sin pérdida;
     *   los ASCII se parsean con Number, nunca con Float32 intermedio.
     * - origin = floor() del PRIMER vértice (tras conversión de ejes).
     * - positions: Float32Array LOCAL (mundo − origin), ejes con Z hacia arriba.
     * - indices: Uint32Array; las caras de n lados se triangulan en abanico.
     */
    SimRocas.importers.ply = {
        id: 'ply',
        extensions: ['.ply'],

        detect(name, headBytes) {
            if (typeof name === 'string') {
                const dot = name.lastIndexOf('.');
                if (dot >= 0 && name.slice(dot).toLowerCase() === '.ply') return true;
            }
            if (!headBytes || headBytes.length === 0) return false;
            const bytes = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes);
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            return /^ply\b/.test(text);
        },

        async parse(input, options = {}, onProgress = null) {
            const upAxis = options.upAxis === 'Y' ? 'Y' : 'Z';
            const totalBytes = typeof options.totalBytes === 'number' && options.totalBytes > 0 ? options.totalBytes : 0;
            const swapY = upAxis === 'Y';

            // Reunir el archivo completo: la cabecera ascii marca el formato y el
            // cuerpo binario se lee con DataView (acceso aleatorio). Los datos
            // de streaming se aplanan antes del parseo.
            let bytes;
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

            function appendChunk(u8) {
                const merged = new Uint8Array(bytes.length + u8.byteLength);
                merged.set(bytes);
                merged.set(u8, bytes.length);
                bytes = merged;
            }

            bytes = new Uint8Array(0);
            if (isBinaryBuffer(input)) {
                const u8 = ArrayBuffer.isView(input)
                    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                    : new Uint8Array(input);
                consumed += u8.byteLength;
                appendChunk(u8);
                notifyProgress();
            } else if (input && typeof input[Symbol.asyncIterator] === 'function') {
                for await (const chunk of input) {
                    const u8 = ArrayBuffer.isView(chunk)
                        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                        : new Uint8Array(chunk);
                    consumed += u8.byteLength;
                    appendChunk(u8);
                    notifyProgress();
                }
            } else {
                throw new Error('Formato de entrada no soportado para el importador PLY.');
            }
            notifyProgress();

            // ---- Cabecera: líneas ascii hasta 'end_header' (len de cabecera indeterminado) ----
            const lineDecoder = new TextDecoder('utf-8', { fatal: false });
            let format = null; // 'ascii' | 'little' | 'big'
            const elements = [];
            let currentElement = null;
            let headerEndIdx = -1;
            {
                let lineStart = 0;
                while (lineStart < bytes.length) {
                    let lineEnd = lineStart;
                    while (lineEnd < bytes.length && bytes[lineEnd] !== 10) lineEnd++;
                    let line = lineDecoder.decode(bytes.subarray(lineStart, lineEnd));
                    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
                        line = line.slice(0, -1); // CRLF
                    }
                    const nextStart = lineEnd + 1;
                    const trimmed = line.trim();
                    if (trimmed.length > 0 && !trimmed.startsWith('comment') && !trimmed.startsWith('obj_info')) {
                        const toks = trimmed.split(/\s+/);
                        if (toks[0] === 'format') {
                            if (toks[1] === 'ascii') format = 'ascii';
                            else if (toks[1] === 'binary_little_endian') format = 'little';
                            else if (toks[1] === 'binary_big_endian') {
                                throw new Error('El importador PLY no soporta el formato binary_big_endian;'
                                    + ' convierte el archivo a binary_little_endian o ascii.');
                            } else {
                                throw new Error(`El archivo PLY declara un formato desconocido: ${toks[1]}.`);
                            }
                        } else if (toks[0] === 'element') {
                            if (toks.length >= 3) {
                                currentElement = { name: toks[1], count: parseInt(toks[2], 10), props: [] };
                                if (!Number.isFinite(currentElement.count) || currentElement.count < 0) currentElement.count = 0;
                                elements.push(currentElement);
                            }
                        } else if (toks[0] === 'property' && currentElement) {
                            if (toks[1] === 'list') {
                                // 'property list <countType> <indexType> <name>'
                                const countType = normalizeType(toks[2]);
                                const indexType = normalizeType(toks[3]);
                                assertKnownType(countType, 'lista de caras');
                                assertKnownType(indexType, 'lista de caras');
                                currentElement.props.push({ list: true, countType, indexType, name: toks[4] || '' });
                            } else {
                                // 'property <type> <name>'
                                const type = normalizeType(toks[1]);
                                assertKnownType(type, 'propiedades');
                                currentElement.props.push({ list: false, type, name: toks[2] });
                            }
                        } else if (toks[0] === 'end_header') {
                            headerEndIdx = nextStart;
                            break;
                        }
                    }
                    lineStart = nextStart;
                }
            }

            if (!format) {
                throw new Error('El archivo PLY no declara un "format" válido.');
            }
            if (headerEndIdx < 0) {
                throw new Error('El archivo PLY no termina la cabecera con "end_header".');
            }

            // ---- Estructuras de salida ----
            let verts = new Float64Array(8 * 3);
            let vertCount = 0; // en floats
            let indices = new Uint32Array(32);
            let idxCount = 0; // en ints
            let triangleCount = 0;
            let first = null;
            let origin = { x: 0, y: 0, z: 0 };

            function ensureVerts(nFloats) {
                if (vertCount + nFloats <= verts.length) return;
                let cap = verts.length * 2;
                while (cap < vertCount + nFloats) cap *= 2;
                const next = new Float64Array(cap);
                next.set(verts.subarray(0, vertCount));
                verts = next;
            }

            function ensureIndices(nInts) {
                if (idxCount + nInts <= indices.length) return;
                let cap = indices.length * 2;
                while (cap < idxCount + nInts) cap *= 2;
                const next = new Uint32Array(cap);
                next.set(indices.subarray(0, idxCount));
                indices = next;
            }

            function storeVertex(x, y, z) {
                let px = x, py = y, pz = z;
                if (swapY) {
                    // (x, y, z) -> (x, -z, y)
                    const ny = -z;
                    pz = y;
                    py = ny;
                }
                if (!first) {
                    first = { x: px, y: py, z: pz };
                    origin = { x: Math.floor(px), y: Math.floor(py), z: Math.floor(pz) };
                }
                ensureVerts(3);
                verts[vertCount++] = px;
                verts[vertCount++] = py;
                verts[vertCount++] = pz;
            }

            function fanTriangles(faceIdx) {
                const n = faceIdx.length;
                for (let k = 1; k + 1 < n; k++) {
                    ensureIndices(3);
                    indices[idxCount++] = faceIdx[0];
                    indices[idxCount++] = faceIdx[k];
                    indices[idxCount++] = faceIdx[k + 1];
                    triangleCount++;
                }
            }

            function faceIndexError(contexte, tok) {
                throw new Error(`El archivo PLY ${contexte} usa un índice fuera de rango o inválido (${tok}).`);
            }

            // ---- Cuerpo según formato ----
            let readScalar; // (type, context) -> number
            let readListCount; // (type, context) -> number
            if (format === 'ascii') {
                const bodyText = lineDecoder.decode(bytes.subarray(headerEndIdx));
                const bodyDecoder = new TextDecoder('utf-8', { fatal: false });
                const toks = bodyDecoder.decode(bytes.subarray(headerEndIdx)).split(/\s+/);
                if (toks.length > 0 && toks[0] === '') toks.shift();
                let pos = 0;
                function takeToken(context) {
                    if (pos >= toks.length) {
                        throw new Error(`El archivo PLY está truncado o incompleto: se agotaron los datos (${context}).`);
                    }
                    return toks[pos++];
                }
                readScalar = function (type, context) {
                    const token = takeToken(context);
                    const val = Number(token);
                    if (!Number.isFinite(val)) {
                        throw new Error(`El archivo PLY contiene un valor inválido (${token}) en ${context}.`);
                    }
                    return val;
                };
                readListCount = readScalar;
                const A = readScalar; // alias interno

                // element vertex + face (recorrido de tokens)
                function parseAsciiBody() {
                    let vertexElem = null;
                    let faceElem = null;
                    for (const e of elements) {
                        if (e.name === 'vertex') vertexElem = e;
                        else if (e.name === 'face') faceElem = e;
                    }
                    if (!vertexElem) {
                        throw new Error('El archivo PLY no declara un elemento vertex.');
                    }
                    const xyz = [-1, -1, -1];
                    for (let p = 0; p < vertexElem.props.length; p++) {
                        const prop = vertexElem.props[p];
                        if (prop.list) {
                            throw new Error('El importador PLY no soporta listas dentro del elemento vertex.');
                        }
                        if (prop.name === 'x') xyz[0] = p;
                        else if (prop.name === 'y') xyz[1] = p;
                        else if (prop.name === 'z') xyz[2] = p;
                    }
                    if (xyz[0] < 0 || xyz[1] < 0 || xyz[2] < 0) {
                        throw new Error('El archivo PLY no declara propiedades x, y y z para el elemento vertex.');
                    }
                    for (let v = 0; v < vertexElem.count; v++) {
                        let x = 0, y = 0, z = 0;
                        for (let p = 0; p < vertexElem.props.length; p++) {
                            const val = A(vertexElem.props[p].type, `vértice ${v}, propiedad ${vertexElem.props[p].name}`);
                            if (p === xyz[0]) x = val;
                            else if (p === xyz[1]) y = val;
                            else if (p === xyz[2]) z = val;
                        }
                        storeVertex(x, y, z);
                    }
                    if (faceElem) {
                        for (let f = 0; f < faceElem.count; f++) {
                            for (let p = 0; p < faceElem.props.length; p++) {
                                const prop = faceElem.props[p];
                                if (!prop.list) {
                                    A(prop.type, `cara ${f}, propiedad ${prop.name}`); // escalar: se salta
                                    continue;
                                }
                                const n = Math.trunc(readListCount(prop.countType, `cara ${f}, longitud de lista`));
                                if (n < 0 || n > 2147483647) {
                                    throw new Error(`El archivo PLY declara una cara ${f} con longitud de lista inválida (${n}).`);
                                }
                                const faceIdx = new Int32Array(n);
                                for (let k = 0; k < n; k++) {
                                    const tok = takeToken(`cara ${f}, vértice ${k}`);
                                    const idx = parseInt(tok, 10);
                                    if (Number.isNaN(idx) || idx < 0 || idx >= vertCount / 3) {
                                        faceIndexError(`cara ${f}`, tok);
                                    }
                                    faceIdx[k] = idx;
                                }
                                fanTriangles(faceIdx);
                                // en un elemento face solo se admite una lista: el resto se salta
                            }
                        }
                    }
                }
                parseAsciiBody();
            } else {
                // binary_little_endian: lector secuencial
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let p = headerEndIdx;
                function takeBytes(n, context) {
                    if (p + n > bytes.length) {
                        throw new Error(`El archivo PLY está truncado o incompleto: faltan bytes (${context}).`);
                    }
                    const start = p;
                    p += n;
                    return start;
                }
                readScalar = function (type, context) {
                    const start = takeBytes(TYPE_SIZES[type], context);
                    switch (type) {
                        case 'int8': return dv.getInt8(start);
                        case 'uint8': return dv.getUint8(start);
                        case 'int16': return dv.getInt16(start, true);
                        case 'uint16': return dv.getUint16(start, true);
                        case 'int32': return dv.getInt32(start, true);
                        case 'uint32': return dv.getUint32(start, true);
                        case 'float32': return dv.getFloat32(start, true);
                        case 'float64': return dv.getFloat64(start, true);
                        default:
                            throw new Error('El importador PLY no reconoce el tipo: ' + type);
                    }
                };
                readListCount = readScalar;

                let vertexElem = null;
                let faceElem = null;
                for (const e of elements) {
                    if (e.name === 'vertex') vertexElem = e;
                    else if (e.name === 'face') faceElem = e;
                }
                if (!vertexElem) {
                    throw new Error('El archivo PLY no declara un elemento vertex.');
                }
                const xyz = [-1, -1, -1];
                for (let i = 0; i < vertexElem.props.length; i++) {
                    const prop = vertexElem.props[i];
                    if (prop.list) {
                        throw new Error('El importador PLY no soporta listas dentro del elemento vertex.');
                    }
                    if (prop.name === 'x') xyz[0] = i;
                    else if (prop.name === 'y') xyz[1] = i;
                    else if (prop.name === 'z') xyz[2] = i;
                }
                if (xyz[0] < 0 || xyz[1] < 0 || xyz[2] < 0) {
                    throw new Error('El archivo PLY no declara propiedades x, y y z para el elemento vertex.');
                }
                for (let v = 0; v < vertexElem.count; v++) {
                    let x = 0, y = 0, z = 0;
                    for (let i = 0; i < vertexElem.props.length; i++) {
                        const val = readScalar(vertexElem.props[i].type, `vértice ${v}, propiedad ${vertexElem.props[i].name}`);
                        if (i === xyz[0]) x = val;
                        else if (i === xyz[1]) y = val;
                        else if (i === xyz[2]) z = val;
                    }
                    storeVertex(x, y, z);
                }
                if (faceElem) {
                    for (let f = 0; f < faceElem.count; f++) {
                        for (let i = 0; i < faceElem.props.length; i++) {
                            const prop = faceElem.props[i];
                            if (!prop.list) {
                                readScalar(prop.type, `cara ${f}, propiedad ${prop.name}`); // escalar: se salta
                                continue;
                            }
                            const n = Math.trunc(readListCount(prop.countType, `cara ${f}, longitud de lista`));
                            if (n < 0 || n > 2147483647) {
                                throw new Error(`El archivo PLY declara una cara ${f} con longitud de lista inválida (${n}).`);
                            }
                            const faceIdx = new Int32Array(n);
                            for (let k = 0; k < n; k++) {
                                const start = takeBytes(TYPE_SIZES[prop.indexType], `cara ${f}, vértice ${k}`);
                                let idx;
                                switch (prop.indexType) {
                                    case 'int8': idx = dv.getInt8(start); break;
                                    case 'uint8': idx = dv.getUint8(start); break;
                                    case 'int16': idx = dv.getInt16(start, true); break;
                                    case 'uint16': idx = dv.getUint16(start, true); break;
                                    case 'int32': idx = dv.getInt32(start, true); break;
                                    case 'uint32': idx = dv.getUint32(start, true); break;
                                    default: faceIndexError(`cara ${f}`, String(n)); return;
                                }
                                if (idx < 0 || idx >= vertCount / 3) {
                                    faceIndexError(`cara ${f}`, String(idx));
                                }
                                faceIdx[k] = idx;
                            }
                            fanTriangles(faceIdx);
                        }
                    }
                }
            }

            if (vertCount === 0 || triangleCount === 0) {
                throw new Error('El archivo PLY no contiene una malla de triángulos válida.');
            }

            // posiciones locales Float32 a partir del Float64 verificado
            const positions = new Float32Array(vertCount);
            for (let i = 0; i < vertCount; i += 3) {
                positions[i] = verts[i] - origin.x;
                positions[i + 1] = verts[i + 1] - origin.y;
                positions[i + 2] = verts[i + 2] - origin.z;
            }

            return {
                kind: 'mesh',
                positions,
                indices: indices.slice(0, idxCount),
                origin,
                upAxis: 'Z',
                stats: {
                    vertices: vertCount / 3,
                    triangles: triangleCount,
                    binary: format !== 'ascii'
                }
            };
        }
    };
})(globalThis.SimRocas);
