globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Conversión de entradas de importación (malla de triángulos, nube de puntos)
     * a un Dem regular. Ver contrato e historia en docs/plan.md (T2.3, T2.4).
     */

    // Set de redondeo de cellSize sugerido, en metros.
    const CELL_SIZES = [0.1, 0.25, 0.5, 1, 2, 5];

    const DEFAULT_MAX_CELLS = 25e6;
    const DEFAULT_FILL_RADIUS = 3;

    function isPlainNumber(v) {
        return typeof v === 'number' && Number.isFinite(v);
    }

    /** Duck typing (los sanbox objects vienen de otro realm; nada de instanceof). */
    function isTypedLike(v) {
        return v !== null && typeof v === 'object' && isPlainNumber(v.length) && v.length > 0 &&
            typeof v[0] === 'number';
    }

    function isPositiveInt(v) {
        return Number.isInteger(v) && v > 0;
    }

    function requireFinitePositive(value, label) {
        if (!isPlainNumber(value) || value <= 0) {
            throw new Error('DemBuilder: ' + label + ' debe ser finito y > 0 (recibido: ' + value + ')');
        }
    }

    /**
     * Valida las dimensiones de la grilla contra maxCells. Devuelve true o lanza
     * Error en español sugiriendo un cellSize mayor que haga caber la grilla.
     */
    function checkGridSize(cols, rows, cellSize, width, height, maxCells, label) {
        const total = cols * rows;
        if (total <= maxCells) {
            return true;
        }
        // cellSize mínimo para que la grilla quepa (por área de la bbox)
        let minCs = Math.sqrt((width + cellSize) * (height + cellSize) / maxCells);
        minCs = Math.max(minCs, cellSize);
        minCs = Math.ceil(minCs * 100) / 100; // a 2 decimales, hacia arriba
        throw new Error(
            'DemBuilder.' + label + ': la grilla de ' + cols + 'x' + rows + ' celdas (' + total +
            ') excede maxCells (= ' + maxCells + ' celdas). Use un cellSize >= ' + minCs +
            ' m (mínimo recomendado para esta extensión).'
        );
    }

    /**
     * Origen del DEM: origin de la entrada + (minX, minY) local, redondeado hacia
     * abajo a múltiplo de cellSize en coordenadas MUNDO (alignment entre fuentes).
     * Devuelve el offset LOCAL del origen de grilla respecto a origin de la entrada:
     * el nodo (0,0) está en local (baseX, baseY).
     */
    function alignedBase(origin, minX, minY, cellSize) {
        const wx = Math.floor((origin.x + minX) / cellSize) * cellSize;
        const wy = Math.floor((origin.y + minY) / cellSize) * cellSize;
        return { x: wx - origin.x, y: wy - origin.y };
    }

    /**
     * Búsqueda binaria del índice de redondeo hacia arriba al primero del set >= v.
     * (CELL_SIZES está ordenado crecientemente.)
     */
    function suggestCellSize(raw) {
        if (!Number.isFinite(raw)) {
            throw new Error('DemBuilder.estimateCellSize: la entrada no permite estimar un cellSize');
        }
        const target = Math.max(raw, 0.1);
        for (let k = 0; k < CELL_SIZES.length; k++) {
            if (CELL_SIZES[k] >= target) {
                return CELL_SIZES[k];
            }
        }
        return CELL_SIZES[CELL_SIZES.length - 1];
    }

    const DemBuilder = {

        /**
         * Rasteriza una malla de triángulos sobre los NODOS de la grilla con
         * z-buffer de envolvente de altura MÁXIMA (donde hay superposición, gana
         * la cota más alta). Rasterizado por bbox del triángulo: por cada triángulo se
         * recorren solo los nodos de su envolvente XY y se usan coordenadas bariocéntricas
         * con pequeña tolerancia de borde (los nodos exactamente sobre una arista
         * o esquina comparten cota entre triángulos adyacentes).
         *
         * @param {object} mesh Entrada del importador:
         *   { kind: 'mesh', positions: Float32Array (xyz locales, Z arriba),
         *     indices: Uint32Array (triángulos), origin: {x, y, z} }
         * @param {number} cellSize Tamaño de celda en metros (> 0).
         * @param {object} [options]
         * @param {number} [options.maxCells=25e6] Límite de celdas de la grilla.
         * @param {function(number): void} [options.onProgress] Fracción [0,1).
         * @returns {SimRocas.Dem}
         */
        fromMesh: function (mesh, cellSize, options = {}) {
            requireFinitePositive(cellSize, 'cellSize');
            if (!mesh || mesh.kind !== 'mesh' || !isTypedLike(mesh.positions) ||
                !isTypedLike(mesh.indices) || mesh.positions.length < 9 ||
                mesh.indices.length < 3 || mesh.indices.length % 3 !== 0) {
                throw new Error('DemBuilder.fromMesh: se esperaba una malla { kind: "mesh", positions: Float32Array, indices: Uint32Array, origin }');
            }
            const origin = mesh.origin;
            if (!origin || !isPlainNumber(origin.x) || !isPlainNumber(origin.y) || !isPlainNumber(origin.z)) {
                throw new Error('DemBuilder.fromMesh: mesh.origin { x, y, z } es requerido y numérico');
            }

            // Bbox XY de las posiciones (locales).
            const pos = mesh.positions;
            let minX = pos[0];
            let maxX = pos[0];
            let minY = pos[1];
            let maxY = pos[1];
            for (let k = 3; k < pos.length; k += 3) {
                if (pos[k] < minX) { minX = pos[k]; }
                if (pos[k] > maxX) { maxX = pos[k]; }
                if (pos[k + 1] < minY) { minY = pos[k + 1]; }
                if (pos[k + 1] > maxY) { maxY = pos[k + 1]; }
            }

            const maxCells = options.maxCells !== undefined ? options.maxCells : DEFAULT_MAX_CELLS;
            RequirePositiveInt(maxCells, 'maxCells');
            // Grilla mínima 2x2: Dem exige >= 2 nodos por eje (mallas y nubes de un solo nodo).
            const cols = Math.max(2, Math.floor((maxX - minX) / cellSize) + 1);
            const rows = Math.max(2, Math.floor((maxY - minY) / cellSize) + 1);
            checkGridSize(cols, rows, cellSize,
                Math.max(maxX - minX, cellSize), Math.max(maxY - minY, cellSize), maxCells, 'fromMesh');

            const base = alignedBase(origin, minX, minY, cellSize);
            const heights = new globalThis.Float32Array(cols * rows);
            heights.fill(NaN);

            const idx = mesh.indices;
            const numTriangles = idx.length / 3;
            const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

            // z-buffer: envolvente de ALTURA MÁXIMA (rasterizado por vértices)
            for (let t = 0; t < numTriangles; t++) {
                const i0 = idx[t * 3];
                const i1 = idx[t * 3 + 1];
                const i2 = idx[t * 3 + 2];
                const x1 = pos[i0 * 3];
                const y1 = pos[i0 * 3 + 1];
                const z1 = pos[i0 * 3 + 2];
                const x2 = pos[i1 * 3];
                const y2 = pos[i1 * 3 + 1];
                const z2 = pos[i1 * 3 + 2];
                const x3 = pos[i2 * 3];
                const y3 = pos[i2 * 3 + 1];
                const z3 = pos[i2 * 3 + 2];

                // área 2 (con signo): no degenerado, y den vecindad
                const den = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
                if (den === 0) {
                    continue; // triángulo degenerado, no aporta altura
                }

                // Envolvente XY del triángulo, en índices de nodo (locales).
                const txMin = Math.min(x1, x2, x3) - base.x;
                const txMax = Math.max(x1, x2, x3) - base.x;
                const tyMin = Math.min(y1, y2, y3) - base.y;
                const tyMax = Math.max(y1, y2, y3) - base.y;
                let iMin = Math.floor(txMin / cellSize);
                let iMax = Math.ceil(txMax / cellSize);
                let jMin = Math.floor(tyMin / cellSize);
                let jMax = Math.ceil(tyMax / cellSize);
                if (iMin < 0) { iMin = 0; }
                if (jMin < 0) { jMin = 0; }
                if (iMax > cols - 1) { iMax = cols - 1; }
                if (jMax > rows - 1) { jMax = rows - 1; }

                // Tolerancia de borde: sobre aristas compartidas, ambos triángulos
                // pueden dar cotas idénticas (la interpolación coincide).
                const tol = 1e-9;

                for (let j = jMin; j <= jMax; j++) {
                    const py = base.y + j * cellSize;
                    const dPy3 = py - y3;
                    const row = j * cols;
                    for (let i = iMin; i <= iMax; i++) {
                        const px = base.x + i * cellSize;
                        const dPx3 = px - x3;
                        // bariocéntricos normalizados (divididos por den)
                        const w1 = ((y2 - y3) * dPx3 + (x3 - x2) * dPy3) / den;
                        if (w1 < -tol) { continue; }
                        const w2 = ((y3 - y1) * dPx3 + (x1 - x3) * dPy3) / den;
                        if (w2 < -tol) { continue; }
                        const w3 = 1 - w1 - w2;
                        if (w3 < -tol) { continue; }
                        const z = w1 * z1 + w2 * z2 + w3 * z3;
                        const gi = row + i;
                        // z-buffer: envolvente de ALTURA MÁXIMA
                        const prev = heights[gi];
                        if (Number.isNaN(prev) || z > prev) {
                            heights[gi] = z;
                        }
                    }
                }

                if (onProgress !== null && (t & 8191) === 8191) {
                    onProgress(t / numTriangles);
                }
            }
            if (onProgress !== null) {
                onProgress(1);
            }

            return new SimRocas.Dem({
                cols: cols,
                rows: rows,
                cellSize: cellSize,
                heights: heights,
                originX: origin.x + base.x,
                originY: origin.y + base.y,
                originZ: origin.z,
            });
        },

        /**
         * Bining de una nube de puntos al nodo más cercano (mode 'min' | 'mean'
         * (defecto) | 'max') y relleno de huecos pequeños: cada nodo sin dato cuyo
         * vecino válido más cercano esté a <= fillRadius celdas se rellena por IDW
         * (potencia 2) con los nodos válidos dentro de ese radio. Huecos mayores
         * quedan NaN.
         *
         * @param {object} points Entrada del importador:
         *   { kind: 'points', positions: Float32Array (xyz locales), origin: {x, y, z} }
         * @param {number} cellSize Tamaño de celda en metros (> 0).
         * @param {object} [options]
         * @param {number} [options.maxCells=25e6] Límite de celdas de la grilla.
         * @param {string} [options.mode='mean'] 'min' | 'mean' | 'max'.
         * @param {number} [options.fillRadius=3] Radio de relleno (celdas).
         * @param {function(number): void} [options.onProgress] Fracción [0,1).
         * @returns {SimRocas.Dem}
         */
        fromPoints: function (points, cellSize, options = {}) {
            requireFinitePositive(cellSize, 'cellSize');
            if (!points || points.kind !== 'points' || !isTypedLike(points.positions) ||
                points.positions.length < 3 || points.positions.length % 3 !== 0) {
                throw new Error('DemBuilder.fromPoints: se esperaba { kind: "points", positions: Float32Array, origin }');
            }
            const origin = points.origin;
            if (!origin || !isPlainNumber(origin.x) || !isPlainNumber(origin.y) || !isPlainNumber(origin.z)) {
                throw new Error('DemBuilder.fromPoints: points.origin { x, y, z } es requerido y numérico');
            }
            const mode = options.mode !== undefined && options.mode !== null ? options.mode : 'mean';
            if (mode !== 'min' && mode !== 'mean' && mode !== 'max') {
                throw new Error('DemBuilder.fromPoints: mode debe ser "min", "mean" o "max" (recibido: ' + mode + ')');
            }
            const fillRadius = options.fillRadius !== undefined ? options.fillRadius : DEFAULT_FILL_RADIUS;
            if (!isPlainNumber(fillRadius) || fillRadius < 0) {
                throw new Error('DemBuilder.fromPoints: fillRadius debe ser finito y >= 0 en celdas (recibido: ' + fillRadius + ')');
            }
            const maxCells = options.maxCells !== undefined ? options.maxCells : DEFAULT_MAX_CELLS;
            RequirePositiveInt(maxCells, 'maxCells');

            // Bbox XY de los puntos (locales; igual alineación que fromMesh).
            const pos = points.positions;
            const numPoints = pos.length / 3;
            let minX = pos[0];
            let maxX = pos[0];
            let minY = pos[1];
            let maxY = pos[1];
            for (let k = 3; k < pos.length; k += 3) {
                if (pos[k] < minX) { minX = pos[k]; }
                if (pos[k] > maxX) { maxX = pos[k]; }
                if (pos[k + 1] < minY) { minY = pos[k + 1]; }
                if (pos[k + 1] > maxY) { maxY = pos[k + 1]; }
            }

            // Grilla mínima 2x2: Dem exige >= 2 nodos por eje (nubes de un solo nodo).
            const cols = Math.max(2, Math.floor((maxX - minX) / cellSize) + 1);
            const rows = Math.max(2, Math.floor((maxY - minY) / cellSize) + 1);
            checkGridSize(cols, rows, cellSize,
                Math.max(maxX - minX, cellSize), Math.max(maxY - minY, cellSize), maxCells, 'fromPoints');

            const base = alignedBase(origin, minX, minY, cellSize);
            const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

            // Bining: sumas + conteos para 'mean'; cmin/cmax directos para min/max.
            const sums = new globalThis.Float64Array(cols * rows);
            const counts = new globalThis.Int32Array(cols * rows);
            const zmin = new globalThis.Float32Array(cols * rows);
            const zmax = new globalThis.Float32Array(cols * rows);
            for (let p = 0; p < numPoints; p++) {
                const px = pos[p * 3];
                const py = pos[p * 3 + 1];
                const pz = pos[p * 3 + 2];
                if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
                    continue; // punto sin cota usable
                }
                const fi = Math.round((px - base.x) / cellSize);
                const fj = Math.round((py - base.y) / cellSize);
                if (fi < 0 || fi >= cols || fj < 0 || fj >= rows) {
                    continue; // fuera de la grilla
                }
                const gi = fj * cols + fi;
                if (mode === 'min') {
                    if (counts[gi] === 0 || pz < zmin[gi]) {
                        zmin[gi] = pz;
                    }
                } else if (mode === 'max') {
                    if (counts[gi] === 0 || pz > zmax[gi]) {
                        zmax[gi] = pz;
                    }
                } else {
                    sums[gi] += pz;
                }
                counts[gi]++;

                if (onProgress !== null && (p & 16383) === 16383) {
                    onProgress(p / numPoints);
                }
            }
            if (onProgress !== null) {
                onProgress(0.5);
            }

            const heights = new globalThis.Float32Array(cols * rows);
            heights.fill(NaN);
            if (mode === 'min') {
                for (let k = 0; k < heights.length; k++) {
                    heights[k] = counts[k] > 0 ? zmin[k] : NaN;
                }
            } else if (mode === 'max') {
                for (let k = 0; k < heights.length; k++) {
                    heights[k] = counts[k] > 0 ? zmax[k] : NaN;
                }
            } else {
                for (let k = 0; k < heights.length; k++) {
                    heights[k] = counts[k] > 0 ? sums[k] / counts[k] : NaN;
                }
            }

            // Relleno de huecos pequeños por IDW (potencia 2) con los nodos
            // válidos a <= fillRadius celdas.
            if (fillRadius > 0) {
                _fillHoles(heights, cols, rows, fillRadius);
            }

            if (onProgress !== null) {
                onProgress(1);
            }

            return new SimRocas.Dem({
                cols: cols,
                rows: rows,
                cellSize: cellSize,
                heights: heights,
                originX: origin.x + base.x,
                originY: origin.y + base.y,
                originZ: origin.z,
            });
        },

        /**
         * Sugerencia de cellSize a partir de la entrada: para malla, ~ la longitud
         * media de arista; para nube de puntos, sqrt(area_bbox / n). Redondeada al
         * set 0.1/0.25/0.5/1/2/5 m, mínimo 0.1 m.
         *
         * @param {object} input { kind:'mesh', positions, indices, origin }
         *   o bien { kind:'points', positions, origin }.
         * @returns {number} cellSize sugerido en metros.
         */
        estimateCellSize: function (input) {
            if (!input || (input.kind !== 'mesh' && input.kind !== 'points')) {
                throw new Error('DemBuilder.estimateCellSize: se esperaba una entrada { kind: "mesh" | "points" }');
            }
            const pos = input.positions;
            if (!pos || pos.length < 9) {
                throw new Error('DemBuilder.estimateCellSize: la entrada no tiene suficientes posiciones');
            }
            if (input.kind === 'mesh') {
                if (!(input.indices) || !isTypedLike(input.indices) || input.indices.length < 3) {
                    throw new Error('DemBuilder.estimateCellSize: se esperaba indices: Uint32Array para kind "mesh"');
                }
                const idx = input.indices;
                let avg = 0;
                let count = 0;
                const numTriangles = idx.length / 3;
                // Muestreo uniforme de triángulos para no pagar O(numTriangles) completo
                // en mallas enormes (el promedio converge con ~4096 muestras).
                const stride = Math.max(1, Math.floor(numTriangles / 4096));
                for (let t = 0; t < numTriangles; t += stride) {
                    const a = idx[t * 3] * 3;
                    const b = idx[t * 3 + 1] * 3;
                    const c = idx[t * 3 + 2] * 3;
                    avg += Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
                    avg += Math.hypot(pos[b] - pos[c], pos[b + 1] - pos[c + 1], pos[b + 2] - pos[c + 2]);
                    avg += Math.hypot(pos[a] - pos[c], pos[a + 1] - pos[c + 1], pos[a + 2] - pos[c + 2]);
                    count += 3;
                }
                if (count === 0) {
                    throw new Error('DemBuilder.estimateCellSize: la malla no tiene triángulos');
                }
                return suggestCellSize(avg / count);
            }
            // puntos: sqrt(area_bbox / n)
            let minX = pos[0];
            let maxX = pos[0];
            let minY = pos[1];
            let maxY = pos[1];
            for (let k = 3; k < pos.length; k += 3) {
                if (pos[k] < minX) { minX = pos[k]; }
                if (pos[k] > maxX) { maxX = pos[k]; }
                if (pos[k + 1] < minY) { minY = pos[k + 1]; }
                if (pos[k + 1] > maxY) { maxY = pos[k + 1]; }
            }
            const n = pos.length / 3;
            return suggestCellSize(Math.sqrt((maxX - minX) * (maxY - minY) / n));
        },
    };

    /** Lanza Error en español si value no es un entero > 0. */
    function RequirePositiveInt(value, label) {
        if (!isPositiveInt(value)) {
            throw new Error('DemBuilder.' + label + ': maxCells debe ser un entero > 0 (recibido: ' + value + ')');
        }
    }

    /**
     * Relleno de huecos in-place: los nodos NaN se rellenan por IDW (potencia 2)
     * si hay al menos un nodo valido a <= radius celdas (vecindad Chebyshev en índices).
     */
    function _fillHoles(heights, cols, rows, radius) {
        // Lista de huecos para no tocarlos en la pasada de vecinos.
        const holes = [];
        for (let k = 0; k < heights.length; k++) {
            if (Number.isNaN(heights[k])) {
                holes.push(k);
            }
        }
        if (holes.length === 0) {
            return;
        }
        const ir = Math.ceil(radius);
        const fills = new globalThis.Float64Array(holes.length);
        for (let h = 0; h < holes.length; h++) {
            const k = holes[h];
            const j = (k / cols) | 0;
            const i = k - j * cols;
            const jMin = Math.max(0, j - ir);
            const jMax = Math.min(rows - 1, j + ir);
            const iMin = Math.max(0, i - ir);
            const iMax = Math.min(cols - 1, i + ir);
            const r2 = radius * radius;
            let num = 0;
            let den = 0;
            for (let jj = jMin; jj <= jMax; jj++) {
                const dj = jj - j;
                const rowOff = jj * cols;
                for (let ii = iMin; ii <= iMax; ii++) {
                    const di = ii - i;
                    const d2 = di * di + dj * dj;
                    if (d2 > r2) {
                        continue;
                    }
                    const z = heights[rowOff + ii];
                    if (Number.isNaN(z)) {
                        continue;
                    }
                    num += z / d2;
                    den += 1 / d2;
                }
            }
            fills[h] = den > 0 ? num / den : NaN;
        }
        for (let h = 0; h < holes.length; h++) {
            heights[holes[h]] = fills[h];
        }
    }

    SimRocas.DemBuilder = DemBuilder;
})(globalThis.SimRocas);
