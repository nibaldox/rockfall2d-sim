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
     * Importador STL (binario y ASCII).
     *
     * Contrato C4:
     * - parse(input, options, onProgress) con input = ArrayBuffer | Uint8Array |
     *   AsyncIterable<Uint8Array> (bloques arbitrarios).
     * - parseo SIEMPRE en Float64 (Number) antes de restar el origen.
     * - origin = floor() del PRIMER vértice (tras conversión de ejes).
     * - positions: Float32Array LOCAL (mundo − origin), ejes con Z hacia arriba.
     * - indices: Uint32Array con deduplicación exacta de vértices (un STL repite
     *   cada vértice por triángulo; la malla final comparte vértices).
     * - stats: { triangles, vertices, binary, float32Warning }.
     */
    SimRocas.importers.stl = {
        id: 'stl',
        extensions: ['.stl'],

        detect(name, headBytes) {
            if (typeof name === 'string') {
                const dot = name.lastIndexOf('.');
                if (dot >= 0 && name.slice(dot).toLowerCase() === '.stl') return true;
            }
            // Contenido: detectar ASCII solo si arranca con 'solid' y declara 'facet'
            // ('solid' también aparece en cabeceras binarias: sola no basta).
            if (headBytes && headBytes.length > 0) {
                const bytes = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes);
                const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                if (/^\s*solid/.test(text) && /facet/.test(text)) return true;
            }
            return false;
        },

        async parse(input, options = {}, onProgress = null) {
            const upAxis = options.upAxis === 'Y' ? 'Y' : 'Z';
            const totalBytes = typeof options.totalBytes === 'number' && options.totalBytes > 0 ? options.totalBytes : 0;
            const swapY = upAxis === 'Y';

            // Reunir bytes (el STL binario requiere acceso aleatorio al bloque de
            // triángulos; el ASCII usa la misma secuencia ya decodificada).
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
                throw new Error('Formato de entrada no soportado para el importador STL.');
            }
            notifyProgress();

            // Estructuras de salida comunes
            let verts = new Float64Array(8 * 3); // triples x,y,z en Float64
            let vertCount = 0; // en floats
            let indices = new Uint32Array(32);
            let idxCount = 0; // en ints (3 por triángulo)
            let triangleCount = 0;
            let first = null;
            let origin = { x: 0, y: 0, z: 0 };
            let originSet = false;
            let float32Warning = false;
            let binary = false;
            const dedup = new Map(); // clave exacta de bits -> índice de vértice

            // Clave exacta del Float64 (patrón de bits): evita colisiones de
            // normalización y funciona igual para texto reparseado y bits LE.
            const scratch = new Float64Array(3);
            const scratchBits = new Uint32Array(scratch.buffer);
            function vertexKey(x, y, z) {
                scratch[0] = x;
                scratch[1] = y;
                scratch[2] = z;
                return `${scratchBits[0]},${scratchBits[1]},${scratchBits[2]},`
                    + `${scratchBits[3]},${scratchBits[4]},${scratchBits[5]}`;
            }

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

            function addVertex(x, y, z) {
                let px = x;
                let py = y;
                let pz = z;
                if (swapY) {
                    // (x, y, z) -> (x, -z, y)
                    const ny = -z;
                    pz = y;
                    py = ny;
                }
                if (!first) {
                    first = { x: px, y: py, z: pz };
                    origin = { x: Math.floor(px), y: Math.floor(py), z: Math.floor(pz) };
                    originSet = true;
                }
                if (binary && (Math.abs(px) > 1e5 || Math.abs(py) > 1e5 || Math.abs(pz) > 1e5)) {
                    float32Warning = true; // el archivo ya está en Float32
                }
                const key = vertexKey(px, py, pz);
                const seen = dedup.get(key);
                if (seen !== undefined) return seen;
                ensureVerts(3);
                const index = vertCount / 3;
                verts[vertCount++] = px;
                verts[vertCount++] = py;
                verts[vertCount++] = pz;
                dedup.set(key, index);
                return index;
            }

            function addTriangle(a, b, c) {
                ensureIndices(3);
                indices[idxCount++] = a;
                indices[idxCount++] = b;
                indices[idxCount++] = c;
                triangleCount++;
            }

            // ---- Binario: 80 bytes de cabecera + uint32 n + 50 bytes por triángulo ----
            function parseBinary() {
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const n = dv.getUint32(80, true);
                if (bytes.byteLength < 84 + 50 * n) {
                    throw new Error(`El archivo STL está truncado o incompleto: se esperaban`
                        + ` ${84 + 50 * n} bytes para ${n} triángulos y hay ${bytes.byteLength}.`);
                }
                for (let t = 0; t < n; t++) {
                    // offset dentro del bloque: 12 bytes de normal + 9 float + uint16
                    const base = 84 + 50 * t;
                    const a = addVertex(dv.getFloat32(base + 12, true), dv.getFloat32(base + 16, true), dv.getFloat32(base + 20, true));
                    const b = addVertex(dv.getFloat32(base + 24, true), dv.getFloat32(base + 28, true), dv.getFloat32(base + 32, true));
                    const c = addVertex(dv.getFloat32(base + 36, true), dv.getFloat32(base + 40, true), dv.getFloat32(base + 44, true));
                    addTriangle(a, b, c);
                }
            }

            // ---- ASCII: 'vertex x y z' en cada triángulo ----
            function parseAscii() {
                const decoder = new TextDecoder('utf-8', { fatal: false });
                const text = decoder.decode(bytes);
                const lines = text.split(/[ \t]*\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const trimmed = line.trim();
                    if (trimmed.length < 7) continue;
                    const tok = trimmed.split(/[ \t]+/);
                    if (tok[0] !== 'vertex') continue; // facet/normal/outer/endloop/endfacet: ignorar
                    if (tok.length < 4) continue;
                    const x = parseFloat(tok[1]);
                    const y = parseFloat(tok[2]);
                    const z = parseFloat(tok[3]);
                    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
                        throw new Error(`El archivo STL ASCII contiene un vértice inválido`
                            + ` en la línea ${i + 1}: '${trimmed}'.`);
                    }
                    vertStack.push(x, y, z);
                }
            }

            // vértices ASCII consecutivos en orden: cada 3 forman un triángulo
            const vertStack = [];
            function flushAsciiTriangles() {
                const n = Math.floor(vertStack.length / 9);
                for (let t = 0; t < n; t++) {
                    const base = t * 9;
                    const a = addVertex(vertStack[base], vertStack[base + 1], vertStack[base + 2]);
                    const b = addVertex(vertStack[base + 3], vertStack[base + 4], vertStack[base + 5]);
                    const c = addVertex(vertStack[base + 6], vertStack[base + 7], vertStack[base + 8]);
                    addTriangle(a, b, c);
                }
            }

            const len = bytes.byteLength;
            if (len >= 84) {
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const n = dv.getUint32(80, true);
                const expected = 84 + 50 * n;
                if (len === expected) {
                    binary = true;
                    parseBinary();
                } else if (len < expected) {
                    // podría ser un STL ASCII con n coincidente por casualidad:
                    // comprobar señal de texto antes de declarar truncado
                    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(64, len)));
                    if (!/^\s*solid/.test(head)) {
                        throw new Error(`El archivo STL está truncado o incompleto: se esperaban`
                            + ` ${expected} bytes para ${n} triángulos y hay ${len}.`);
                    }
                    binary = false;
                    parseAscii();
                    flushAsciiTriangles();
                } else {
                    // len > expected: probablente ASCII (cuya n del offset 80 es basura)
                    binary = false;
                    parseAscii();
                    flushAsciiTriangles();
                }
            } else {
                binary = false;
                parseAscii();
                flushAsciiTriangles();
            }

            if (triangleCount === 0 || vertCount === 0) {
                throw new Error('El archivo STL no contiene una malla de triángulos válida.');
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
                    triangles: triangleCount,
                    vertices: vertCount / 3,
                    binary,
                    float32Warning
                }
            };
        }
    };
})(globalThis.SimRocas);
