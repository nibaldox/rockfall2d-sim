globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    SimRocas.importers = SimRocas.importers || {};

    const PROGRESS_STEP = 0.01; // notificar como máximo cada 1 %

    // Sentinel de DXF binario ("AutoCAD Binary DXF\r\n\x1A\x00")
    const BINARY_SENTINEL = 'AutoCAD Binary DXF';
    const MSG_BINARIO = 'DXF binario no soportado; exporte como DXF ASCII';
    const MSG_VACIO = 'El archivo DXF no contiene malla de triángulos válida '
        + '(se esperaban 3DFACE, polyface o curvas de nivel con cota).';

    // Detección estructural de ArrayBuffer / vista, válida entre realms
    // (los contextos vm tienen primordiales propios: instanceof fallaría).
    function isBinaryBuffer(input) {
        if (input === null || typeof input !== 'object') return false;
        if (ArrayBuffer.isView(input)) return true; // revisa un slot interno: cruza realms
        return typeof input.byteLength === 'number' && typeof input.buffer === 'undefined'
            && typeof input.split !== 'function'; // ArrayBuffer: byteLength sin length/buffer
    }

    function toUint8(chunk) {
        return ArrayBuffer.isView(chunk)
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : new Uint8Array(chunk);
    }

    function looksBinaryDXF(bytes) {
        if (bytes.length < BINARY_SENTINEL.length) return false;
        let text = '';
        for (let i = 0; i < BINARY_SENTINEL.length; i++) text += String.fromCharCode(bytes[i]);
        return text === BINARY_SENTINEL;
    }

    function isCodeLine(line) {
        const t = line.trim();
        if (t.length === 0) return false;
        for (let i = 0; i < t.length; i++) {
            const d = t.charCodeAt(i) - 48;
            if (d < 0 || d > 9) return false;
        }
        return true;
    }

    SimRocas.importers.dxf = {
        id: 'dxf',
        extensions: ['.dxf'],

        detect(name, headBytes) {
            if (typeof name === 'string') {
                const dot = name.lastIndexOf('.');
                if (dot >= 0 && name.slice(dot).toLowerCase() === '.dxf') return true;
            }
            if (!headBytes || headBytes.length === 0) return false;
            const bytes = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes);
            if (looksBinaryDXF(bytes)) return false; // binario: no es DXF ASCII
            // Contenido: un DXF ASCII empieza con pares (código, valor); el
            // primer par significativo es `0` / `SECTION` (opcionalmente
            // precedido de comentarios `999`). Texto arbitrario no califica.
            let head = '';
            const n = Math.min(bytes.length, 4096);
            for (let k = 0; k < n; k++) head += String.fromCharCode(bytes[k]);
            const lines = head.split(/\r?\n/).map(s => s.trim());
            let k = 0;
            while (k + 1 < lines.length && lines[k] === '999') k += 2;
            return k + 1 < lines.length && lines[k] === '0' && lines[k + 1].toUpperCase() === 'SECTION';
        },

        /**
         * Importador DXF ASCII por streaming de pares (código de grupo, valor).
         *
         * Contrato C4:
         * - parse(input, options, onProgress), input = ArrayBuffer |
         *   Uint8Array | AsyncIterable<Uint8Array> (bloques arbitrarios).
         * - Coordenadas UTM parseadas siempre en Float64 (Number); origin =
         *   floor() del PRIMER punto; positions Float32Array LOCAL
         *   (mundo − origin), Z arriba.
         * - 3DFACE (4.º vértice ≠ 3.º → 2 triángulos) y POLYLINE polyface
         *   (flag 64, face records flag 128 con refs 71-74) → triángulos
         *   directos.
         * - LWPOLYLINE (elevación código 38), POLYLINE 3D (bit 8 de flag 70) o
         *   2D con cota (código 30 de la POLYLINE), LINE y POINT → vértices con
         *   cota, densificados a options.densify (defecto 2 m), dedup exacto en
         *   XY y triangulación en planta con Delaunator (vendor); triángulos
         *   con arista > options.maxEdge (defecto 20 × mediana) descartados.
         * - Sin ninguna cota → stats.flatWarning = true.
         * - DXF binario → Error en español.
         */
        async parse(input, options = {}, onProgress = null) {
            const densify = typeof options.densify === 'number' && options.densify > 0
                ? options.densify : 2;
            const maxEdgeOpt = typeof options.maxEdge === 'number' && options.maxEdge > 0
                ? options.maxEdge : null;
            const totalBytes = typeof options.totalBytes === 'number' && options.totalBytes > 0
                ? options.totalBytes : 0;
            const decoder = new TextDecoder('utf-8', { stream: true });

            // ---------- estado del stream ----------
            let carry = '';
            let pendingCode = null; // código esperando el par (par partido entre bloques)
            let section = null;
            let secPending = false;
            let consumed = 0;
            let lastNotified = 0;

            // ---------- estado de entidades ----------
            let cur = null;   // entidad abierta con campos crudos (strings)
            let poly = null;  // POLYLINE activa (recibe VERTEX y SEQEND)
            let first = null; // primer punto visto (fija el origin)

            function notifyProgress() {
                if (!onProgress) return;
                let frac;
                if (totalBytes > 0) {
                    frac = Math.min(1, consumed / totalBytes);
                } else {
                    frac = 1;
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

            // colectores: todas las coordenadas en Float64 (Number)
            const facePts = [];  // caras: 9 números consecutivos por triángulo
            const contourPts = []; // curvas/líneas/puntos: x,y,z consecutivos (mundo)
            const stats = {
                faces: 0,
                polylines: 0,
                vertices: 0,
                triangles: 0,
                triangulated: false,
                skippedEntities: 0
            };
            let anyZ = false;

            function recordPoint(dst, x, y, z) {
                if (first === null) first = { x, y, z };
                dst.push(x, y, z);
                if (z !== 0) anyZ = true;
            }

            // densifica [p0 -> p1] (sin repetir extremos; el llamador los agrega)
            function densifySeg(dst, x0, y0, z0, x1, y1, z1) {
                const dx = x1 - x0;
                const dy = y1 - y0;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist <= densify) return;
                const dz = z1 - z0;
                const n = Math.ceil(dist / densify);
                for (let i = 1; i < n; i++) {
                    const f = i / n;
                    recordPoint(dst, x0 + dx * f, y0 + dy * f, z0 + dz * f);
                }
            }

            function addFaceTri(dst, p0, p1, p2) {
                dst.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
            }

            function flush3DFACE() {
                const v = cur.verts; // 0-4 vértices {x,y,z}
                const nPts = v.length;
                if (first === null && nPts > 0) {
                    first = { x: v[0].x, y: v[0].y, z: v[0].z }; // floor del 1.º vértice
                    if (v[0].z !== 0) anyZ = true;
                }
                if (nPts === 3) {
                    stats.faces++;
                    addFaceTri(facePts, v[0], v[1], v[2]);
                    return;
                }
                if (nPts === 4) {
                    const same = v[2].x === v[3].x && v[2].y === v[3].y && v[2].z === v[3].z;
                    stats.faces++;
                    addFaceTri(facePts, v[0], v[1], v[2]);
                    if (!same) {
                        // quad: 4.º vértice distinto del 3.º → 2 triángulos
                        addFaceTri(facePts, v[0], v[2], v[3]);
                    }
                    return;
                }
                stats.skippedEntities++; // 3DFACE degenerado (< 3 vértices)
            }

            function flushLINE() {
                if (cur.pts.length !== 2) {
                    stats.skippedEntities++;
                    return;
                }
                const [p0, p1] = cur.pts;
                recordPoint(contourPts, p0.x, p0.y, p0.z);
                densifySeg(contourPts, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
                recordPoint(contourPts, p1.x, p1.y, p1.z);
            }

            function flushPOINT() {
                if (cur.pts.length !== 1) {
                    stats.skippedEntities++;
                    return;
                }
                const p = cur.pts[0];
                recordPoint(contourPts, p.x, p.y, p.z);
            }

            function flushLWPOLYLINE() {
                const v = cur.verts;
                if (v.length < 2) {
                    stats.skippedEntities++;
                    return;
                }
                stats.polylines++;
                for (let i = 0; i < v.length; i++) {
                    if (i === 0) {
                        recordPoint(contourPts, v[0].x, v[0].y, cur.elev);
                    } else {
                        densifySeg(contourPts, v[i - 1].x, v[i - 1].y, cur.elev,
                            v[i].x, v[i].y, cur.elev);
                        recordPoint(contourPts, v[i].x, v[i].y, cur.elev);
                    }
                }
            }

            function vertexCoord(v, kx, ky, kz) {
                const x = parseFloat(v[kx]);
                const y = parseFloat(v[ky]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                let z = parseFloat(v[kz]);
                if (!Number.isFinite(z)) z = 0;
                return { x, y, z };
            }

            function flushPolyline(pl) {
                const v = pl.verts;
                const hasRefs = (p) => p.r0 !== undefined || p.r1 !== undefined
                    || p.r2 !== undefined || p.r3 !== undefined; // face record: tiene 71-74
                if (pl.flag & 64) {
                    // polyface mesh: face records (refs 71-74 1-based, flag 128
                    // o 128|64=192 según el generador); vértices con flag 64/192
                    let faceCount = 0;
                    for (const p of v) {
                        if (!hasRefs(p)) continue;
                        faceCount++;
                        const idx = [];
                        for (let i = 0; i < 4; i++) {
                            let r = parseInt(p['r' + i], 10);
                            if (Number.isNaN(r) || r === 0) continue;
                            if (r < 0) r = -r; // arista invisible: cara igual
                            idx.push(r - 1);
                        }
                        if (idx.length < 3) continue;
                        // fan del polígono referenciado (3 o 4 vértices; ref 4.ª
                        // igual a la 3.ª → solo 1 triángulo). Cada triángulo se
                        // emite como 3 vértices consecutivos; el dedup XY del
                        // buildMesh colapsa las esquinas compartidas.
                        const fan = (idx.length === 4 && idx[3] !== idx[2])
                            ? [[0, 1, 2], [0, 2, 3]]
                            : [[0, 1, 2]];
                        for (const t of fan) {
                            const c = [];
                            for (const k of t) {
                                const pV = v[idx[k]];
                                if (!pV) break;
                                const pt = vertexCoord(pV, 'x0', 'y0', 'z0');
                                if (!pt) break;
                                c.push(pt);
                            }
                            if (c.length !== 3) continue;
                            if (first === null) {
                                first = { x: c[0].x, y: c[0].y, z: c[0].z };
                            }
                            for (const pt2 of c) {
                                if (pt2.z !== 0) anyZ = true;
                            }
                            addFaceTri(facePts, c[0], c[1], c[2]);
                        }
                    }
                    if (faceCount === 0) {
                        stats.skippedEntities++;
                        return;
                    }
                    stats.faces += faceCount;
                    return;
                }
                // polilínea normal: cota por vértice (3D) o elevación (2D, código 30)
                stats.polylines++;
                const useVertZ = (pl.flag & 8) !== 0;
                let prev = null;
                let used = 0;
                for (let i = 0; i < v.length; i++) {
                    const p = v[i];
                    if (hasRefs(p)) continue; // face record del polyface
                    const x = parseFloat(p.x0), y = parseFloat(p.y0);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    let z = parseFloat(p.z0);
                    if (!Number.isFinite(z) || !useVertZ) z = pl.elev;
                    if (prev === null) {
                        recordPoint(contourPts, x, y, z);
                    } else {
                        densifySeg(contourPts, prev.x, prev.y, prev.z, x, y, z);
                        recordPoint(contourPts, x, y, z);
                    }
                    prev = { x, y, z };
                    used++;
                }
                if (used < 2) {
                    // menos de 2 vértices útiles: sin curva de nivel asociada
                    if (used === 0) stats.skippedEntities++;
                }
            }

            function finishVertex() {
                if (!poly) return; // VERTEX fuera de POLYLINE: ignorar
                poly.verts.push({
                    x0: cur.x0, y0: cur.y0, z0: cur.z0,
                    flag: cur.flag,
                    r0: cur.r0, r1: cur.r1, r2: cur.r2, r3: cur.r3
                });
            }

            function finalizeEntity() {
                if (!cur) return;
                if (cur.type === 'POLYLINE') {
                    // POLYLINE sin SEQEND (archivo truncado): procesar igual
                    if (poly === cur) {
                        const pl = poly;
                        poly = null;
                        cur = null;
                        flushPolyline(pl);
                        return;
                    }
                }
                switch (cur.type) {
                    case '3DFACE': {
                        const v = [];
                        for (let i = 0; i < 4; i++) {
                            const x = cur['x' + i], y = cur['y' + i];
                            if (x === undefined && y === undefined) continue;
                            const c = vertexCoord(cur, 'x' + i, 'y' + i, 'z' + i);
                            if (c) v.push(c);
                        }
                        cur.verts = v;
                        flush3DFACE();
                        break;
                    }
                    case 'LWPOLYLINE': {
                        const v = [];
                        const xs = cur.vsX, ys = cur.vsY;
                        const n = Math.min(xs.length, ys.length);
                        for (let i = 0; i < n; i++) {
                            const x = parseFloat(xs[i]), y = parseFloat(ys[i]);
                            if (Number.isFinite(x) && Number.isFinite(y)) {
                                v.push({ x, y });
                            }
                        }
                        cur.verts = v;
                        flushLWPOLYLINE();
                        break;
                    }
                    case 'LINE': {
                        const pts = [];
                        for (let i = 0; i < 2; i++) {
                            const c = vertexCoord(cur, 'x' + i, 'y' + i, 'z' + i);
                            if (c) pts.push(c);
                        }
                        cur.pts = pts;
                        flushLINE();
                        break;
                    }
                    case 'POINT': {
                        const c = vertexCoord(cur, 'x0', 'y0', 'z0');
                        cur.pts = c ? [c] : [];
                        flushPOINT();
                        break;
                    }
                    case 'VERTEX': finishVertex(); break;
                    case 'POLYLINE': // ya manejado arriba
                        break;
                    default:
                        stats.skippedEntities++;
                }
                cur = null;
            }

            function handleValue(code, valueStr) {
                if (code === 0) {
                    const val = valueStr.trim().toUpperCase();
                    if (val === 'SECTION') { secPending = true; return; }
                    if (val === 'ENDSEC') { if (cur) finalizeEntity(); section = null; return; }
                    if (val === 'EOF') { return; }
                    if (val === 'VERTEX' && poly) {
                        // subentidad VERTEX de la POLYLINE abierta: no cerrarla
                        if (cur && cur !== poly) finalizeEntity();
                        cur = { type: 'VERTEX' };
                        return;
                    }
                    if (val === 'SEQEND' && poly) {
                        if (cur && cur !== poly) finalizeEntity();
                        const pl = poly;
                        poly = null;
                        cur = null;
                        flushPolyline(pl);
                        return;
                    }
                    // cerrar la entidad abierta (incluido VERTEX)
                    if (cur) finalizeEntity();
                    switch (val) {
                        case 'POLYLINE':
                            poly = { type: 'POLYLINE', flag: 0, elev: 0, verts: [] };
                            cur = poly;
                            return;
                        case 'VERTEX':
                        case 'SEQEND':
                            // huérfanos (sin POLYLINE abierta): ignorar
                            return;
                        case '3DFACE':
                        case 'LINE':
                        case 'POINT':
                        case 'LWPOLYLINE':
                            if (section !== 'ENTITIES') return;
                            cur = { type: val, flag: 0, elev: 0 };
                            if (val === 'LWPOLYLINE') { cur.vsX = []; cur.vsY = []; }
                            return;
                        default:
                            if (section === 'ENTITIES') stats.skippedEntities++;
                            return;
                    }
                }
                if (secPending) {
                    // pareja 2/«ENTITIES» tras 0/SECTION: nombre de la sección
                    section = valueStr.trim().toUpperCase();
                    secPending = false;
                    return;
                }
                if (cur) {
                    switch (cur.type) {
                        case 'POLYLINE':
                            if (code === 70) cur.flag = parseInt(valueStr, 10) || 0;
                            else if (code === 30) cur.elev = parseFloat(valueStr) || 0;
                            return;
                        case 'VERTEX':
                            if (code === 70) cur.flag = parseInt(valueStr, 10) || 0;
                            else if (code >= 71 && code <= 74) {
                                cur['r' + (code - 71)] = valueStr;
                                cur.flag |= 128; // face record
                            } else if (code === 10) cur.x0 = valueStr;
                            else if (code === 20) cur.y0 = valueStr;
                            else if (code === 30) cur.z0 = valueStr;
                            return;
                        case 'LWPOLYLINE':
                            if (code === 10) cur.vsX.push(valueStr);
                            else if (code === 20) cur.vsY.push(valueStr);
                            else if (code === 38) cur.elev = parseFloat(valueStr) || 0;
                            return;
                        case '3DFACE':
                        case 'LINE':
                        case 'POINT':
                            if (code >= 10 && code <= 13) cur['x' + (code - 10)] = valueStr;
                            else if (code >= 20 && code <= 23) cur['y' + (code - 20)] = valueStr;
                            else if (code >= 30 && code <= 33) cur['z' + (code - 30)] = valueStr;
                            return;
                        default:
                            return;
                    }
                }
            }

            function consumeText(text) {
                const joined = carry + text;
                const lines = [];
                let start = 0;
                let idx = joined.indexOf('\n', start);
                while (idx >= 0) {
                    let line = joined.slice(start, idx);
                    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
                        line = line.slice(0, -1); // CRLF
                    }
                    lines.push(line);
                    start = idx + 1;
                    idx = joined.indexOf('\n', start);
                }
                carry = joined.slice(start);
                // recorridas por índice (shift() sería O(n²) en bloques grandes)
                let i = 0;
                // si el bloque anterior dejó un código pendiente de valor:
                if (pendingCode !== null) {
                    if (i < lines.length) {
                        handleValue(pendingCode, lines[i]);
                        i++;
                        pendingCode = null;
                    } else {
                        return; // el código pendiente sigue esperando su valor
                    }
                }
                while (i + 1 < lines.length) {
                    const codeLine = lines[i];
                    if (!isCodeLine(codeLine)) { i++; continue; }
                    const valueLine = lines[i + 1];
                    i += 2;
                    handleValue(parseInt(codeLine.trim(), 10), valueLine);
                }
                if (i === lines.length - 1 && isCodeLine(lines[i])) {
                    pendingCode = parseInt(lines[i].trim(), 10);
                }
            }

            // ---------- lectura de entrada ----------

            if (isBinaryBuffer(input)) {
                const bytes = ArrayBuffer.isView(input)
                    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                    : new Uint8Array(input);
                consumed = bytes.byteLength;
                if (looksBinaryDXF(bytes)) {
                    throw new Error(MSG_BINARIO);
                }
                consumeText(decoder.decode(bytes, { stream: true }));
                notifyProgress();
            } else if (input && typeof input[Symbol.asyncIterator] === 'function') {
                let blocks = 0;
                let head = null; // primeros bytes para el sentinel binario
                let binChecked = false;
                for await (const chunk of input) {
                    const u8 = toUint8(chunk);
                    blocks++;
                    consumed += u8.byteLength;
                    if (head === null) {
                        head = u8.subarray(0, Math.min(u8.length, 64));
                    } else if (head.length < 64) {
                        const need = 64 - head.length;
                        const next = new Uint8Array(Math.min(64, head.length + u8.length));
                        next.set(head, 0);
                        next.set(u8.subarray(0, Math.min(u8.length, need)), head.length);
                        head = next;
                    }
                    if (!binChecked) {
                        if (looksBinaryDXF(head)) {
                            throw new Error(MSG_BINARIO);
                        }
                        if (head.length >= BINARY_SENTINEL.length) binChecked = true;
                    }
                    consumeText(decoder.decode(u8, { stream: true }));
                    notifyProgress();
                }
            } else {
                throw new Error('Formato de entrada no soportado para el importador DXF.');
            }

            const tail = decoder.decode();
            if (tail.length > 0) consumeText(tail);
            notifyProgress();

            if (cur) finalizeEntity();

            // ---------- construcción de la malla ----------

            if (first === null) {
                throw new Error(MSG_VACIO);
            }
            const origin = {
                x: Math.floor(first.x),
                y: Math.floor(first.y),
                z: Math.floor(first.z)
            };

            // tabla de vértices con dedup exacto en XY (la 1.ª excepción gana la Z)
            const ptIndex = new Map();
            const pts = []; // triples x, y, z en Float64 (mundo)
            function addPt(x, y, z) {
                const k = x + '|' + y;
                let i = ptIndex.get(k);
                if (i === undefined) {
                    i = pts.length / 3;
                    ptIndex.set(k, i);
                    pts.push(x, y, z);
                }
                return i;
            }

            const directIndices = [];
            for (let i = 0; i < facePts.length; i += 3) {
                directIndices.push(addPt(facePts[i], facePts[i + 1], facePts[i + 2]));
            }
            const contourStart = pts.length / 3;
            for (let i = 0; i < contourPts.length; i += 3) {
                addPt(contourPts[i], contourPts[i + 1], contourPts[i + 2]);
            }

            const nPts = pts.length / 3;
            stats.vertices = nPts;

            let indices;
            if (contourStart < nPts && nPts >= 3) {
                // hay curvas de nivel / líneas / puntos: triangulamos TODO en XY
                if (typeof Delaunator !== 'function') {
                    throw new Error(
                        'Falta vendor/delaunator/delaunator.js (global Delaunator) '
                        + 'para triangular las curvas de nivel del DXF.'
                    );
                }
                const coords = new Float64Array(nPts * 2);
                for (let i = 0; i < nPts; i++) {
                    coords[i * 2] = pts[i * 3];
                    coords[i * 2 + 1] = pts[i * 3 + 1];
                }
                let delTris;
                try {
                    const del = new Delaunator(coords);
                    delTris = del.triangles;
                    stats.triangulated = true;
                } catch (err) {
                    throw new Error('La triangulación Delaunator falló para este DXF.');
                }
                // mediana de aristas de la triangulación
                const edges = [];
                for (let t = 0; t < delTris.length; t += 3) {
                    edges.push(
                        hypot2(delTris[t], delTris[t + 1]),
                        hypot2(delTris[t + 1], delTris[t + 2]),
                        hypot2(delTris[t + 2], delTris[t])
                    );
                }
                edges.sort((p, q) => p - q);
                const median = edges.length > 0 ? edges[Math.floor(edges.length / 2)] : 0;
                const threshold = maxEdgeOpt !== null ? maxEdgeOpt : 20 * median;
                const kept = [];
                for (let t = 0; t < delTris.length; t += 3) {
                    const a = delTris[t], b = delTris[t + 1], c = delTris[t + 2];
                    if (hypot2(a, b) > threshold) continue;
                    if (hypot2(b, c) > threshold) continue;
                    if (hypot2(c, a) > threshold) continue;
                    kept.push(a, b, c);
                }
                indices = new Uint32Array(kept);
            } else {
                // solo caras 3DFACE/polyface: triángulos directos, sin filtro
                indices = new Uint32Array(directIndices);
            }

            if (indices.length === 0) {
                throw new Error(MSG_VACIO);
            }
            stats.triangles = indices.length / 3;
            if (!anyZ) stats.flatWarning = true;

            // posiciones locales Float32 a partir del Float64 verificado
            const positions = new Float32Array(nPts * 3);
            for (let i = 0; i < nPts; i++) {
                positions[i * 3] = pts[i * 3] - origin.x;
                positions[i * 3 + 1] = pts[i * 3 + 1] - origin.y;
                positions[i * 3 + 2] = pts[i * 3 + 2] - origin.z;
            }

            function hypot2(i, j) {
                const dx = pts[i * 3] - pts[j * 3];
                const dy = pts[i * 3 + 1] - pts[j * 3 + 1];
                return Math.sqrt(dx * dx + dy * dy);
            }

            return {
                kind: 'mesh',
                positions,
                indices,
                origin,
                upAxis: 'Z',
                stats
            };
        }
    };
})(globalThis.SimRocas);
