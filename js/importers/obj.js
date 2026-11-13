globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    SimRocas.importers = SimRocas.importers || {};

    const PROGRESS_STEP = 0.01; // notificar como máximo cada 1 %

    // Detección estructural de ArrayBuffer / vista, válida entre realms
    // (los contextos vm tienen primordiales propios: instanceof fallaría).
    function isBinaryBuffer(input) {
        if (input === null || typeof input !== 'object') return false;
        if (ArrayBuffer.isView(input)) return true; // revisa un slot interno: cruza realms
        return typeof input.byteLength === 'number' && typeof (input.buffer) === 'undefined'
            && typeof input.split !== 'function'; // ArrayBuffer: byteLength sin length/buffer
    }

    /**
     * Importador OBJ por streaming.
     *
     * Contrato C4:
     * - parse(input, options, onProgress) con input = ArrayBuffer | Uint8Array |
     *   AsyncIterable<Uint8Array> (bloques arbitrarios).
     * - parseo SIEMPRE en Float64 (Number): coordenadas UTM (~6.3e6 m) perderían
     *   ~0.5 m si se redondearan a Float32 antes de restar el origen.
     * - origin = floor() del PRIMER vértice (ya convertido a Z arriba).
     * - positions: Float32Array LOCAL (mundo − origin), ejes con Z hacia arriba.
     * - indices: Uint32Array, triángulos base 0 (n-gonos en abanico).
     */
    SimRocas.importers.obj = {
        id: 'obj',
        extensions: ['.obj'],

        detect(name, headBytes) {
            if (typeof name === 'string') {
                const dot = name.lastIndexOf('.');
                if (dot >= 0 && name.slice(dot).toLowerCase() === '.obj') return true;
            }
            if (!headBytes || headBytes.length === 0) return false;
            const bytes = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes);
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith('v ') || line.startsWith('f ')) return true;
            }
            return false;
        },

        async parse(input, options = {}, onProgress = null) {
            const upAxis = options.upAxis === 'Y' ? 'Y' : 'Z';
            const totalBytes = typeof options.totalBytes === 'number' && options.totalBytes > 0 ? options.totalBytes : 0;
            const swapY = upAxis === 'Y';
            const decoder = new TextDecoder('utf-8', { stream: true });

            let verts = new Float64Array(8 * 3); // triples x,y,z en Float64 (exactitud UTM)
            let vertCount = 0;
            let indices = new Uint32Array(32);
            let triCount = 0;
            let skippedFaces = 0;

            let first = null;      // primer vértice { x, y, z } en Float64, Z arriba
            let origin = { x: 0, y: 0, z: 0 };
            let originSet = false;

            let carry = '';        // línea partida entre bloques
            let faceBuf = new Int32Array(64);
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

            function ensureVerts(nFloats) {
                if (vertCount + nFloats <= verts.length) return;
                let cap = verts.length * 2;
                while (cap < vertCount + nFloats) cap *= 2;
                const next = new Float64Array(cap);
                next.set(verts.subarray(0, vertCount));
                verts = next;
            }

            function ensureIndices(nInts) {
                if (triCount + nInts <= indices.length) return;
                let cap = indices.length * 2;
                while (cap < triCount + nInts) cap *= 2;
                const next = new Uint32Array(cap);
                next.set(indices.subarray(0, triCount));
                indices = next;
            }

            function commitOrigin() {
                if (originSet || !first) return;
                origin = {
                    x: Math.floor(first.x),
                    y: Math.floor(first.y),
                    z: Math.floor(first.z)
                };
                originSet = true;
            }

            function resolveVertIndex(raw) {
                // OBJ: 1-based, o negativo relativo al último vértice conocido
                if (raw > 0) return raw - 1;
                if (raw < 0) return vertCount / 3 + raw;
                return -1;
            }

            function addFace(n) {
                if (n < 3) return; // 'f a b' o 'f a': cara degenerada, no es índice fuera de rango
                // el origen queda fijado en cuanto aparece la primera cara,
                // pero la igualdad de origen a floor(primer vértice) es invariante:
                commitOrigin();
                const a = resolveVertIndex(faceBuf[0]);
                if (a < 0 || a >= vertCount / 3) {
                    skippedFaces++;
                    return;
                }
                for (let k = 1; k + 1 < n; k++) {
                    const b = resolveVertIndex(faceBuf[k]);
                    const c = resolveVertIndex(faceBuf[k + 1]);
                    if (b < 0 || b >= vertCount / 3 || c < 0 || c >= vertCount / 3) {
                        skippedFaces++;
                        return;
                    }
                    ensureIndices(3);
                    indices[triCount++] = a;
                    indices[triCount++] = b;
                    indices[triCount++] = c;
                }
            }

            function handleLine(line) {
                if (line.length < 2) return;
                const c0 = line.charCodeAt(0);
                const c1 = line.charCodeAt(1);
                const s0 = c0 === 118 && (c1 === 32 || c1 === 9); // 'v ' o 'v\t'
                const s1 = c0 === 102 && (c1 === 32 || c1 === 9); // 'f ' o 'f\t'
                if (s0) { // 'v'
                    // tolerante a espacios/tab repetidos tras la directiva
                    const parts = line.split(/[ \t]+/);
                    let p = 1;
                    while (p < parts.length && parts[p].length === 0) p++;
                    const x = parseFloat(parts[p]);
                    const y = parseFloat(parts[p + 1]);
                    const z = parseFloat(parts[p + 2]);
                    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return;
                    let px = x;
                    let py = y;
                    let pz = z;
                    if (swapY) {
                        // (x, y, z) -> (x, -z, y)
                        const ny = -z;
                        pz = y;
                        py = ny;
                    }
                    if (!first) first = { x: px, y: py, z: pz };
                    ensureVerts(3);
                    verts[vertCount++] = px;
                    verts[vertCount++] = py;
                    verts[vertCount++] = pz;
                    return;
                }
                if (s1) { // 'f'
                    const parts = line.split(/[ \t]+/);
                    let m = 0;
                    let invalid = false;
                    for (let i = 1; i < parts.length; i++) {
                        const tok = parts[i];
                        if (tok.length === 0) continue;
                        const slash = tok.indexOf('/');
                        const num = slash < 0 ? tok : tok.slice(0, slash);
                        const parsed = parseVertexIndex(num);
                        // fuera de rango Int32 (se guardaría truncado) o no numérico:
                        // cara inválida -> skippedFaces, no se lanza
                        if (Number.isNaN(parsed) || parsed > 2147483647 || parsed < -2147483648) {
                            invalid = true;
                            break;
                        }
                        if (m === faceBuf.length) {
                            const grown = new Int32Array(faceBuf.length * 2);
                            grown.set(faceBuf);
                            faceBuf = grown;
                        }
                        faceBuf[m++] = parsed;
                    }
                    if (invalid) {
                        skippedFaces++;
                        return;
                    }
                    addFace(m);
                    return;
                }
                // vt, vn, vp, o, g, s, usemtl, mtllib, '#', líneas vacías: ignorar
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
                // ArrayBuffer o vista de CUALQUIER realm: instanceof no funciona
                // cruzado (sandbox vm), por eso la detección es estructural.
                const bytes = ArrayBuffer.isView(input)
                    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                    : new Uint8Array(input);
                consumed += bytes.byteLength;
                consumeText(decoder.decode(bytes, { stream: true }));
                notifyProgress();
            } else if (input && typeof input[Symbol.asyncIterator] === 'function') {
                // AsyncIterable<Uint8Array> (bloques arbitrarios, p. ej. File.stream())
                for await (const chunk of input) {
                    // Uint8Array u otro ArrayBufferLike, de cualquier realm
                    const u8 = ArrayBuffer.isView(chunk)
                        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                        : new Uint8Array(chunk);
                    consumed += u8.byteLength;
                    consumeText(decoder.decode(u8, { stream: true }));
                    notifyProgress();
                }
            } else {
                throw new Error('Formato de entrada no soportado para el importador OBJ.');
            }

            // flush final del decodificador (último byte UTF-8 completo o BOM suelto)
            const tail = decoder.decode();
            if (tail.length > 0) consumeText(tail);
            if (carry.length > 0) {
                if (carry.charCodeAt(carry.length - 1) === 13) carry = carry.slice(0, -1);
                handleLine(carry);
                carry = '';
            }
            notifyProgress();

            commitOrigin();

            if (vertCount === 0 || triCount === 0) {
                throw new Error('El archivo OBJ no contiene una malla de triángulos válida.');
            }

            // Ultimo paso: posiciones locales Float32 a partir del Float64 verificado
            const positions = new Float32Array(vertCount);
            for (let i = 0; i < vertCount; i += 3) {
                positions[i] = verts[i] - origin.x;
                positions[i + 1] = verts[i + 1] - origin.y;
                positions[i + 2] = verts[i + 2] - origin.z;
            }

            return {
                kind: 'mesh',
                positions,
                indices: indices.slice(0, triCount),
                origin,
                upAxis: 'Z',
                stats: {
                    vertices: vertCount / 3,
                    triangles: triCount / 3,
                    skippedFaces
                }
            };
        }
    };

    function parseVertexIndex(token) {
        let i = 0;
        let sign = 1;
        if (token.charCodeAt(0) === 45) { // '-'
            sign = -1;
            i = 1;
        } else if (token.charCodeAt(0) === 43) { // '+'
            i = 1;
        }
        let value = 0;
        let anyDigit = false;
        for (; i < token.length; i++) {
            const d = token.charCodeAt(i) - 48;
            if (d < 0 || d > 9) return NaN; // token no numérico: cara inválida
            value = value * 10 + d;
            anyDigit = true;
        }
        if (!anyDigit) return NaN;
        return sign * value;
    }
})(globalThis.SimRocas);
