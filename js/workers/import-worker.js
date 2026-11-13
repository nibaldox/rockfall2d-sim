/**
 * SimRocas 2D — Web Worker de importación de terreno 3D (T2.10, protocolo C5).
 *
 * Detecta el formato del archivo, lee por streaming y delega en los
 * importadores de js/importers/; convierte a Dem (directo para kind 'grid',
 * DemBuilder.fromMesh / fromPoints para mesh / points) y genera la malla de
 * visualización decimada DESDE EL DEM (no desde la malla original). El
 * resultado viaja al hilo principal con transferencia sin copia.
 *
 * El host lo crea como `new Worker('js/workers/import-worker.js?v=N')`,
 * de modo que importScripts resuelve rutas relativas a js/workers/.
 *
 * IN:  { type: 'import', file, options }
 *      options: { cellSize (número > 0; null/ausente = automático),
 *                 upAxis: 'Z'|'Y', pointMode: 'mean'|'min'|'max',
 *                 maxDisplayTriangles: 2e6, maxCells: 25e6 }
 *      file: File o Blob con .name (la extensión ayuda a la detección)
 *      { type: 'stop' } (sin efecto; el host termina el worker afuera)
 * OUT: { type: 'progress', phase: 'read'|'parse'|'raster'|'mesh', progress }
 *      { type: 'done', dem, displayMesh, info } + transfer de 3 buffers:
 *        - dem: Dem.toTransferable() (reconstruible con Dem.fromTransferable)
 *        - displayMesh: { positions: Float32Array xyz LOCALES al DEM,
 *                         indices: Uint32Array, stride }
 *        - info: { format, fileName, fileBytes, cellSize, cols, rows,
 *                  validFraction, bounds, crs, warnings[] (español), stats }
 *      { type: 'error', message } (mensaje en español del Error capturado)
 */

// Cache-busting: el host abre el worker con una consulta (?v=N); se repite
// aquí para que el bundle vendorizado y los módulos se invaliden a la vez.
const _v = (self.location && self.location.search) || '';
importScripts(
    '../../vendor/geotiff/geotiff.js' + _v,
    '../../vendor/delaunator/delaunator.js' + _v,
    '../dem.js' + _v,
    '../dem-builder.js' + _v,
    '../importers/obj.js' + _v,
    '../importers/stl.js' + _v,
    '../importers/ply.js' + _v,
    '../importers/xyz.js' + _v,
    '../importers/asc.js' + _v,
    '../importers/geotiff.js' + _v,
    '../importers/dxf.js' + _v,
    '../importers/las.js' + _v,
);

// LAZ: descompresión con laz-perf (script clásico + wasm en vendor/). El glue
// no inicializa el WASM al cargarlo; se instancia perezosamente al pedir un
// .laz (promesa cacheada en el importador LAZ). Si falla aquí (glue ausente o
// quebrado), el worker SIGUE funcionando para los demás formatos: el error
// queda para cuando se pida un LAZ (mensaje en español del importador).
try {
    importScripts('../../vendor/laz-perf/laz-perf.js' + _v);
    self.SimRocas.lazPerfUrl = '../../vendor/laz-perf/';
} catch (err) {
    // sin descompresor LAZ: los otros formatos no se ven afectados
}

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Progreso
    // ------------------------------------------------------------------

    // Publica como máximo cada 1% (igual que los importadores).
    const PROGRESS_STEP = 0.01;

    // Los valores de entrada son monótonos (los importadores y los recorridos
    // locales ya lo garantizan); se clampan y solo sale cada >= 1% o el 1 exacto.
    function makePhaseNotifier(post) {
        let last = 0;
        return function (frac) {
            let f = Math.min(1, Math.max(0, Number(frac) || 0));
            if (f < last) { f = last; }
            if (f - last >= PROGRESS_STEP || f >= 1 || (f === 0 && last === 0)) {
                last = f;
                post(f);
            }
        };
    }

    // ------------------------------------------------------------------
    // Detección de formato
    // ------------------------------------------------------------------

    // Los binarios con magic van primero; XYZ al final (detect más laxo).
    const DETECT_ORDER = ['geotiff', 'las', 'stl', 'ply', 'dxf', 'obj', 'asc', 'xyz'];

    const FORMAT_LABELS = {
        geotiff: 'GeoTIFF (.tif/.tiff)',
        las: 'LAS/LAZ (.las/.laz)',
        dxf: 'DXF ASCII (.dxf)',
        stl: 'STL (.stl)',
        ply: 'PLY (.ply)',
        obj: 'OBJ (.obj)',
        asc: 'ASCII Grid ESRI (.asc/.grd)',
        xyz: 'XYZ/nube de puntos (.xyz/.csv/.txt/.pts)',
    };

    function lowerEndsWith(name, ext) {
        return String(name == null ? '' : name).toLowerCase().endsWith(ext);
    }

    // Devuelve el id del importador que atiende el archivo, o null. La
    // extensión tiene prioridad si su importador detecta por contenido;
    // si no, gana el primer detect por contenido en DETECT_ORDER.
    function detectFormat(fileName, headBytes) {
        const importers = self.SimRocas.importers;
        let extHit = null;
        const contentHits = [];
        for (let k = 0; k < DETECT_ORDER.length; k++) {
            const id = DETECT_ORDER[k];
            const imp = importers[id];
            if (!imp || typeof imp.detect !== 'function') { continue; }
            const extMatches = (imp.extensions || []).some(e => lowerEndsWith(fileName, e));
            if (extMatches && extHit === null) { extHit = id; }
            if (imp.detect(fileName, headBytes)) {
                contentHits.push(id);
                if (extMatches) {
                    // extensión + contenido positivo: formato decidido
                    return id;
                }
            }
        }
        if (extHit !== null && contentHits.indexOf(extHit) >= 0) {
            return extHit;
        }
        return contentHits.length > 0 ? contentHits[0] : null;
    }

    function unsupportedFormatError(fileName) {
        const list = DETECT_ORDER.map(id => FORMAT_LABELS[id]).join(', ');
        return 'Formato de archivo no reconocido (' + (fileName || 'sin nombre') +
            '). Formatos soportados: ' + list + '.';
    }

    // ------------------------------------------------------------------
    // Lectura del archivo
    // ------------------------------------------------------------------

    async function readHeadBytes(file) {
        // File.slice(0, 4096).arrayBuffer() del realm del archivo; la vista
        // se crea en este realm (un ArrayBuffer ajeno no da instanceof).
        const buf = await file.slice(0, 4096).arrayBuffer();
        return new Uint8Array(buf);
    }

    // File.stream() no garantiza @@asyncIterator en el objeto según el entorno
    // (los navegadores clásicos exigen getReader()): se envuelve SIEMPRE con
    // getReader(). El iterable devuelto es propio de este realm (los objetos
    // del archivo son de un realm ajeno en tests; nada de instanceof).
    function streamIterable(file) {
        let reader = null;
        let exhausted = false;
        function nextChunk() {
            if (exhausted) {
                return Promise.resolve({ done: true, value: undefined });
            }
            if (reader === null) {
                try {
                    reader = file.stream().getReader();
                } catch (err) {
                    exhausted = true;
                    return Promise.reject(err);
                }
            }
            return reader.read().then(function (r) {
                if (r.done) {
                    exhausted = true;
                    return { done: true, value: undefined };
                }
                return { done: false, value: r.value };
            });
        }
        return {
            [Symbol.asyncIterator]() {
                return {
                    next() { return nextChunk(); },
                    return() {
                        exhausted = true;
                        try { if (reader) { reader.releaseLock(); } } catch (e) { /* noop */ }
                        return Promise.resolve({ done: true, value: undefined });
                    },
                };
            },
        };
    }

    // geotiff/stl: ArrayBuffer completo (binario con acceso aleatorio);
    // las con LAZ (extensión .laz o bits 6-7 del byte de formato): entero
    // también, el descompresor no es streamable; obj/ply/xyz/asc: streaming
    // con AsyncIterable + options.totalBytes.
    const FULL_BUFFER_FORMATS = { geotiff: true, stl: true };

    function looksLaz(name, headBytes) {
        if (lowerEndsWith(name, '.laz')) { return true; }
        return !!(headBytes && headBytes.length > 104 && (headBytes[104] & 0xC0) !== 0);
    }

    async function buildImporterInput(format, file, notifyRead, headBytes) {
        if (FULL_BUFFER_FORMATS[format] || (format === 'las' && looksLaz(file.name, headBytes))) {
            notifyRead(0.5);
            const buf = await file.arrayBuffer();
            notifyRead(1);
            return buf;
        }
        return streamIterable(file);
    }

    // ------------------------------------------------------------------
    // cellSize (opción null = automático)
    // ------------------------------------------------------------------

    // Celdas que haría falta con cellSize cs (grilla mínima 2x2).
    function cellsNeeded(width, height, cs) {
        const cols = Math.max(2, Math.floor(width / cs) + 1);
        const rows = Math.max(2, Math.floor(height / cs) + 1);
        return cols * rows;
    }

    // (ancho, alto) XY de la bbox de positions; null sin datos suficientes.
    function positionsExtent(pos) {
        if (!pos || typeof pos.length !== 'number' || pos.length < 3) { return null; }
        let minX = pos[0], maxX = pos[0], minY = pos[1], maxY = pos[1];
        for (let k = 3; k < pos.length; k += 3) {
            const x = pos[k];
            const y = pos[k + 1];
            if (x < minX) { minX = x; }
            if (x > maxX) { maxX = x; }
            if (y < minY) { minY = y; }
            if (y > maxY) { maxY = y; }
        }
        return { width: maxX - minX, height: maxY - minY };
    }

    // cellSize efectivo: options.cellSize si es > 0; si no, estimateCellSize
    // acotado a >= 0.25 m y ajustado hacia arriba si excede maxCells.
    function chooseCellSize(input, options) {
        const DemBuilder = self.SimRocas.DemBuilder;
        const user = options.cellSize;
        if (typeof user === 'number' && Number.isFinite(user) && user > 0) {
            return user;
        }
        let cs = DemBuilder.estimateCellSize(input);
        if (!Number.isFinite(cs) || cs < 0.25) { cs = 0.25; }
        const ext = positionsExtent(input.positions);
        const maxCells = (typeof options.maxCells === 'number' && options.maxCells > 0)
            ? options.maxCells : 25e6;
        if (ext) {
            while (cellsNeeded(ext.width, ext.height, cs) > maxCells) {
                cs *= 2;
            }
        }
        return cs;
    }

    // ------------------------------------------------------------------
    // Malla de visualización desde el DEM
    // ------------------------------------------------------------------

    // Stride entero mínimo con 2·ceil(cols/s)·ceil(rows/s) <= maxDisplayTriangles.
    function computeStride(cols, rows, maxDisplayTriangles) {
        let s = 1;
        while (s < Math.max(cols, rows) &&
               2 * Math.ceil(cols / s) * Math.ceil(rows / s) > maxDisplayTriangles) {
            s++;
        }
        return s;
    }

    // Submuestreo: vértices en nodos válidos (i/j múltiplos de stride);
    // triángulos solo donde los 3 vértices son válidos (NaN fuera).
    // positions locales al DEM; indices base 0 (Uint32Array con tamaño exacto).
    function makeDisplayMesh(dem, maxDisplayTriangles, notify) {
        const cols = dem.cols;
        const rows = dem.rows;
        const cs = dem.cellSize;
        const heights = dem.heights;
        const stride = computeStride(cols, rows, maxDisplayTriangles);
        const sc = Math.ceil(cols / stride);
        const sr = Math.ceil(rows / stride);
        notify(0.25);

        // Paso 1: vértices válidos (mapa nodo submuestreado -> índice).
        const nodeToVertex = new Int32Array(sc * sr);
        let nValid = 0;
        for (let sj = 0; sj < sr; sj++) {
            const base = (sj * stride) * cols;
            for (let si = 0; si < sc; si++) {
                if (Number.isNaN(heights[base + si * stride])) {
                    nodeToVertex[sj * sc + si] = -1;
                } else {
                    nodeToVertex[sj * sc + si] = nValid++;
                }
            }
        }
        // Paso 2: conteo de triángulos (los 3 vértices deben ser válidos).
        let triCount = 0;
        for (let sj = 0; sj + 1 < sr; sj++) {
            for (let si = 0; si + 1 < sc; si++) {
                const v00 = nodeToVertex[sj * sc + si];
                const v10 = nodeToVertex[sj * sc + si + 1];
                const v01 = nodeToVertex[(sj + 1) * sc + si];
                const v11 = nodeToVertex[(sj + 1) * sc + si + 1];
                if (v00 >= 0 && v10 >= 0 && v11 >= 0) { triCount++; }
                if (v00 >= 0 && v01 >= 0 && v11 >= 0) { triCount++; }
            }
        }
        notify(0.6);

        // Paso 3: posiciones locales del DEM + índices.
        const positions = new Float32Array(nValid * 3);
        const indices = new Uint32Array(triCount * 3);
        let pos = 0;
        for (let sj = 0; sj < sr; sj++) {
            const j = sj * stride;
            const base = j * cols;
            for (let si = 0; si < sc; si++) {
                const v = nodeToVertex[sj * sc + si];
                if (v >= 0) {
                    const i = si * stride;
                    positions[pos++] = i * cs;
                    positions[pos++] = j * cs;
                    positions[pos++] = heights[base + i];
                }
            }
        }
        let iv = 0;
        for (let sj = 0; sj + 1 < sr; sj++) {
            for (let si = 0; si + 1 < sc; si++) {
                const v00 = nodeToVertex[sj * sc + si];
                const v10 = nodeToVertex[sj * sc + si + 1];
                const v01 = nodeToVertex[(sj + 1) * sc + si];
                const v11 = nodeToVertex[(sj + 1) * sc + si + 1];
                if (v00 >= 0 && v10 >= 0 && v11 >= 0) {
                    indices[iv++] = v00;
                    indices[iv++] = v10;
                    indices[iv++] = v11;
                }
                if (v00 >= 0 && v01 >= 0 && v11 >= 0) {
                    indices[iv++] = v00;
                    indices[iv++] = v11;
                    indices[iv++] = v01;
                }
            }
        }
        notify(1);
        return { positions: positions, indices: indices, stride: stride };
    }

    // ------------------------------------------------------------------
    // Handler del protocolo C5
    // ------------------------------------------------------------------

    const DSM_NOTE = 'Si el modelo es un DSM (incluye vegetación o estructuras), las rocas chocarán con ellas. Para caída de rocas use un DTM (terreno desnudo).';
    const FLOAT32_WARNING = 'El STL binario usa precisión simple con coordenadas grandes (UTM): la precisión horizontal puede ser de ~0,5 m. Exporte con origen local o use OBJ/GeoTIFF.';

    function validFractionOf(dem) {
        const h = dem.heights;
        if (!h || h.length === 0) { return 1; }
        let valid = 0;
        for (let k = 0; k < h.length; k++) {
            if (!Number.isNaN(h[k])) { valid++; }
        }
        return valid / h.length;
    }

    function percent(f) {
        return Math.round(f * 1000) / 10;
    }

    function postError(err) {
        const message = (err && err.message) ? String(err.message) : String(err);
        try { self.postMessage({ type: 'error', message: message }, []); } catch (e2) { /* noop */ }
    }

    async function runImport(msg) {
        const file = msg.file;
        const rawOptions = msg.options || {};
        if (!file || typeof file.slice !== 'function') {
            throw new Error('El worker de importación necesita un File/Blob con .name/.slice() (recibido: ' + String(file) + ').');
        }
        const opts = {
            cellSize: rawOptions.cellSize !== undefined ? rawOptions.cellSize : null,
            upAxis: rawOptions.upAxis === 'Y' ? 'Y' : 'Z',
            pointMode: (rawOptions.pointMode === 'min' || rawOptions.pointMode === 'max') ? rawOptions.pointMode : 'mean',
            maxDisplayTriangles: (typeof rawOptions.maxDisplayTriangles === 'number' &&
                Number.isFinite(rawOptions.maxDisplayTriangles) && rawOptions.maxDisplayTriangles > 0)
                ? rawOptions.maxDisplayTriangles : 2e6,
            maxCells: (typeof rawOptions.maxCells === 'number' &&
                Number.isFinite(rawOptions.maxCells) && rawOptions.maxCells > 0)
                ? rawOptions.maxCells : 25e6,
        };

        const post = function (m, transfer) {
            try { self.postMessage(m, transfer || []); } catch (err) { /* sin oyente */ }
        };

        // ---- fase read: detección con los primeros 4 KB ----
        const notifyRead = makePhaseNotifier(f => post({ type: 'progress', phase: 'read', progress: f }));
        notifyRead(0);
        const headBytes = await readHeadBytes(file);
        const format = detectFormat(file.name, headBytes);
        if (format === null) {
            throw unsupportedFormatError(file.name);
        }
        notifyRead(1);

        // ---- fase parse: lectura + importador (streaming) ----
        const importer = self.SimRocas.importers[format];
        const notifyParse = makePhaseNotifier(f => post({ type: 'progress', phase: 'parse', progress: f }));
        const input = await buildImporterInput(format, file, notifyRead, headBytes);
        const parsed = await importer.parse(input, { totalBytes: file.size, upAxis: opts.upAxis, name: file.name }, notifyParse);

        // ---- fase raster: conversión a Dem ----
        const notifyRaster = makePhaseNotifier(f => post({ type: 'progress', phase: 'raster', progress: f }));
        notifyRaster(0);
        let dem = null;
        const stats = Object.assign({}, parsed.stats || {});
        if (parsed.kind === 'grid') {
            dem = parsed.dem;
        } else {
            const DemBuilder = self.SimRocas.DemBuilder;
            const cellSize = chooseCellSize(parsed, opts);
            if (parsed.kind === 'mesh') {
                dem = DemBuilder.fromMesh(parsed, cellSize, { maxCells: opts.maxCells, onProgress: notifyRaster });
            } else {
                dem = DemBuilder.fromPoints(parsed, cellSize, {
                    maxCells: opts.maxCells,
                    mode: opts.pointMode,
                    onProgress: notifyRaster,
                });
            }
        }
        notifyRaster(1);

        // ---- fase mesh: malla de visualización desde el DEM ----
        const notifyMesh = makePhaseNotifier(f => post({ type: 'progress', phase: 'mesh', progress: f }));
        notifyMesh(0);
        const displayMesh = makeDisplayMesh(dem, opts.maxDisplayTriangles, notifyMesh);

        // ---- advertencias (español) ----
        const warnings = [];
        if (stats.float32Warning) {
            warnings.push(FLOAT32_WARNING);
        }
        if (stats.flatWarning) {
            warnings.push('El DXF no tiene cotas (todas las Z son 0): el terreno resultante es plano. Exporte curvas de nivel o caras 3D con elevación.');
        }
        if (stats.noGroundClass) {
            warnings.push('La nube LAS no tiene puntos clasificados como suelo (clase 2): se usaron todos los puntos, incluida la vegetación y estructuras.');
        }
        const validFraction = validFractionOf(dem);
        if (validFraction < 0.5) {
            warnings.push('El DEM tiene muchos huecos (sin dato): solo el ' + percent(validFraction) +
                ' % de la grilla tiene altura. Las rocas se detendrán o caerán al vacío en los huecos y la malla será incompleta.');
        }
        warnings.push(DSM_NOTE);

        // ---- done con transferencia sin copia ----
        const info = {
            format: format,
            fileName: String(file.name == null ? '' : file.name),
            fileBytes: file.size,
            cellSize: dem.cellSize,
            cols: dem.cols,
            rows: dem.rows,
            validFraction: validFraction,
            bounds: dem.bounds(),
            crs: dem.crs,
            warnings: warnings,
            stats: stats,
        };
        const done = {
            type: 'done',
            dem: dem.toTransferable(),
            displayMesh: displayMesh,
            info: info,
        };
        post(done, [dem.heights.buffer, displayMesh.positions.buffer, displayMesh.indices.buffer]);

        // Liberar referencias grandes tras el envío.
        dem = null;
        parsed.positions = null;
        if ('indices' in parsed) { parsed.indices = null; }
        parsed.dem = null;
    }

    // Handler del mensaje; el flujo completo es asincrónico y todo error se
    // reporta como { type: 'error', message } (nunca lanza al host).
    self.onmessage = function (e) {
        const msg = e ? e.data : null;
        if (!msg || typeof msg !== 'object') { return; }
        if (msg.type === 'import') {
            runImport(msg).catch(postError);
        }
        // otros tipos (stop): el host usa worker.terminate() directamente
    };
})();
