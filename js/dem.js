globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Modelo digital de elevación: grilla regular de nodos sobre el plano XY.
     * node (i, j): i en [0, cols-1] (eje X, oeste→este), j en [0, rows-1] (eje Y, sur→norte).
     * Coordenadas locales: x = i * cellSize, y = j * cellSize, z = heights[j * cols + i]
     * (Float32; NaN = sin dato). Mundo: worldX = originX + x, etc. (origen en Float64).
     */
    class Dem {
        /**
         * @param {object} opts
         * @param {number} opts.cols Número de nodos por fila (>= 2).
         * @param {number} opts.rows Número de nodos por columna (>= 2).
         * @param {number} opts.cellSize Tamaño de celda en metros (> 0, finito).
         * @param {Float32Array} opts.heights Alturas locales, cols*rows, fila j * cols + i (NaN = sin dato).
         * @param {number} [opts.originX=0] Origen de mundo (local → mundo) en X.
         * @param {number} [opts.originY=0] Origen de mundo en Y.
         * @param {number} [opts.originZ=0] Origen de mundo en Z.
         * @param {string|null} [opts.crs=null] Identificador del sistema de referencia.
         */
        constructor({ cols, rows, cellSize, heights, originX = 0, originY = 0, originZ = 0, crs = null }) {
            if (!Number.isInteger(cols) || cols < 2) {
                throw new Error('Dem: cols debe ser un entero >= 2 (recibido: ' + cols + ')');
            }
            if (!Number.isInteger(rows) || rows < 2) {
                throw new Error('Dem: rows debe ser un entero >= 2 (recibido: ' + rows + ')');
            }
            if (!Number.isFinite(cellSize) || cellSize <= 0) {
                throw new Error('Dem: cellSize debe ser finito y > 0 (recibido: ' + cellSize + ')');
            }
            if (!heights || heights.length !== cols * rows) {
                throw new Error('Dem: heights debe tener exactamente cols * rows = ' + (cols * rows) + ' elementos');
            }
            this.cols = cols;
            this.rows = rows;
            this.cellSize = cellSize;
            this.originX = originX;
            this.originY = originY;
            this.originZ = originZ;
            this.crs = crs;
            this.heights = heights;
        }

        /** Índice de nodo: heights[j * cols + i]. */
        _index(i, j) {
            return j * this.cols + i;
        }

        /**
         * Celda que contiene a x (i tal que x ∈ [i*cs, (i+1)*cs]), acotada a la última celda
         * en los bordes superior/derecho exactos. Devuelve null si x está fuera de la grilla.
         * @returns {[number, number]|null} [i, j] de la celda.
         */
        _cell(x, y) {
            const cs = this.cellSize;
            const maxX = (this.cols - 1) * cs;
            const maxY = (this.rows - 1) * cs;
            if (!(x >= 0 && x <= maxX) || !(y >= 0 && y <= maxY)) {
                return null;
            }
            let i = Math.floor(x / cs);
            let j = Math.floor(y / cs);
            if (x === maxX) { i = this.cols - 2; }
            if (y === maxY) { j = this.rows - 2; }
            return [i, j];
        }

        /**
         * Altura bilineal dentro de la celda [i,i+1]x[j,j+1]. Sin asignar en el camino rápido.
         */
        _bilinear(i, j, fx, fy) {
            const h = this.heights;
            const w = this.cols;
            const z00 = h[j * w + i];
            const z10 = h[j * w + i + 1];
            const z01 = h[(j + 1) * w + i];
            const z11 = h[(j + 1) * w + i + 1];
            const za = z00 + fx * (z10 - z00);
            const zb = z01 + fx * (z11 - z01);
            return za + fy * (zb - za);
        }

        /**
         * Altura local z en (x, y), interpolación bilineal entre los 4 nodos de la celda.
         * NaN si (x, y) está fuera de la grilla o algún nodo implicado es NaN.
         * @param {number} x Coordenada local X.
         * @param {number} y Coordenada local Y.
         * @returns {number}
         */
        heightAt(x, y) {
            const cell = this._cell(x, y);
            if (cell === null) {
                return NaN;
            }
            const cs = this.cellSize;
            return this._bilinear(cell[0], cell[1], (x - cell[0] * cs) / cs, (y - cell[1] * cs) / cs);
        }

        /**
         * Normal unitaria {nx, ny, nz} con nz > 0 a partir del gradiente de la superficie
         * bilineal en (x, y). Opcionalmente escribe en `out` para evitar asignación.
         * Devuelve null si heightAt(x, y) es NaN.
         * @param {number} x Coordenada local X.
         * @param {number} y Coordenada local Y.
         * @param {{nx?: number, ny?: number, nz?: number}} [out] Objeto destino opcional.
         * @returns {{nx: number, ny: number, nz: number}|null}
         */
        normalAt(x, y, out = null) {
            const cell = this._cell(x, y);
            if (cell === null) {
                return null;
            }
            const cs = this.cellSize;
            const i = cell[0];
            const j = cell[1];
            const fx = (x - i * cs) / cs;
            const fy = (y - j * cs) / cs;
            const h = this.heights;
            const w = this.cols;
            const z00 = h[j * w + i];
            const z10 = h[j * w + i + 1];
            const z01 = h[(j + 1) * w + i];
            const z11 = h[(j + 1) * w + i + 1];
            // Gradiente del parche bilineal: gx interpolando a lo largo de Y, gy a lo largo de X
            const gx = ((1 - fy) * (z10 - z00) + fy * (z11 - z01)) / cs;
            const gy = ((1 - fx) * (z01 - z00) + fx * (z11 - z10)) / cs;
            if (!Number.isFinite(gx) || !Number.isFinite(gy)) {
                return null;
            }
            const len = Math.sqrt(gx * gx + gy * gy + 1);
            if (out) {
                out.nx = -gx / len;
                out.ny = -gy / len;
                out.nz = 1 / len;
                return out;
            }
            return { nx: -gx / len, ny: -gy / len, nz: 1 / len };
        }

        /** true si hay dato en (x, y) (heightAt no es NaN). */
        contains(x, y) {
            return !Number.isNaN(this.heightAt(x, y));
        }

        /**
         * Extensión de la grilla en coordenadas locales; minZ/maxZ ignoran NaN.
         * @returns {{minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number}}
         */
        bounds() {
            const h = this.heights;
            let minZ = NaN;
            let maxZ = NaN;
            for (let k = 0; k < h.length; k++) {
                const z = h[k];
                if (Number.isNaN(z)) {
                    continue;
                }
                if (Number.isNaN(minZ)) {
                    minZ = z;
                    maxZ = z;
                } else if (z < minZ) {
                    minZ = z;
                } else if (z > maxZ) {
                    maxZ = z;
                }
            }
            return {
                minX: 0,
                maxX: (this.cols - 1) * this.cellSize,
                minY: 0,
                maxY: (this.rows - 1) * this.cellSize,
                minZ: minZ,
                maxZ: maxZ,
            };
        }

        /** Local (x, y, z por defecto 0) → mundo {x, y, z}. Exacto en Float64. */
        worldToLocal(X, Y, Z = 0) {
            return { x: X - this.originX, y: Y - this.originY, z: Z - this.originZ };
        }

        /** Local {x, y, z por defecto 0} → mundo {x, y, z}. Exacto en Float64. */
        localToWorld(x, y, z = 0) {
            return { x: x + this.originX, y: y + this.originY, z: z + this.originZ };
        }

        /**
         * Muestrea a lo largo del segmento (x1,y1)→(x2,y2) cada `spacing` metros, incluyendo
         * ambos extremos. Devuelve el PRIMER tramo contiguo con datos como
         * [{x: distancia desde (x1,y1), y: cota local z}]; [] si no hay datos.
         * @param {number} x1
         * @param {number} y1
         * @param {number} x2
         * @param {number} y2
         * @param {number} spacing Separamiento en metros (> 0).
         * @returns {Array<{x: number, y: number}>}
         */
        sampleProfile(x1, y1, x2, y2, spacing) {
            if (!Number.isFinite(spacing) || spacing <= 0) {
                throw new Error('Dem: spacing debe ser finito y > 0 (recibido: ' + spacing + ')');
            }
            const dx = x2 - x1;
            const dy = y2 - y1;
            const length = Math.hypot(dx, dy);
            if (!(length > 0)) {
                return [];
            }
            const ux = dx / length;
            const uy = dy / length;
            const steps = Math.floor(length / spacing);
            const out = [];
            let started = false;
            const emit = (d) => {
                const z = this.heightAt(x1 + ux * d, y1 + uy * d);
                if (Number.isNaN(z)) {
                    return started ? 1 : 0; // 1 = fin del tramo, 0 = aún en NaN inicial
                }
                out.push({ x: d, y: z });
                started = true;
                return 0;
            };
            for (let k = 0; k <= steps; k++) {
                if (emit(k * spacing) === 1) {
                    return out;
                }
            }
            // extremo exacto (a distancia length), caso length no múltiplo de spacing
            if (length - steps * spacing > 0) {
                if (emit(length) === 1) {
                    return out;
                }
            }
            return out;
        }

        /**
         * Versión apta para postMessage con transfer:
         * { cols, rows, cellSize, originX, originY, originZ, crs, heights } (heights compartido).
         */
        toTransferable() {
            return {
                cols: this.cols,
                rows: this.rows,
                cellSize: this.cellSize,
                originX: this.originX,
                originY: this.originY,
                originZ: this.originZ,
                crs: this.crs,
                heights: this.heights,
            };
        }

        /**
         * Reconstruye un Dem a partir del objeto de toTransferable().
         * @param {{cols: number, rows: number, cellSize: number, originX?: number, originY?: number,
         *           originZ?: number, crs?: string|null, heights: Float32Array}} obj
         * @returns {Dem}
         */
        static fromTransferable(obj) {
            return new Dem({
                cols: obj.cols,
                rows: obj.rows,
                cellSize: obj.cellSize,
                heights: obj.heights,
                originX: obj.originX !== undefined ? obj.originX : 0,
                originY: obj.originY !== undefined ? obj.originY : 0,
                originZ: obj.originZ !== undefined ? obj.originZ : 0,
                crs: obj.crs !== undefined ? obj.crs : null,
            });
        }

        /**
         * Utilidad para tests y generadores: construye un Dem evaluando fn(x local, y local)
         * en cada nodo. dx/dy son offsets locales del origen.
         * @param {number} cols
         * @param {number} rows
         * @param {number} cellSize
         * @param {(x: number, y: number) => number} fn
         * @param {{x?: number, y?: number, z?: number}} [origin]
         * @returns {Dem}
         */
        static fromFunction(cols, rows, cellSize, fn, origin = { x: 0, y: 0, z: 0 }) {
            const ox = origin.x || 0;
            const oy = origin.y || 0;
            const oz = origin.z || 0;
            const heights = new Float32Array(cols * rows);
            for (let j = 0; j < rows; j++) {
                for (let i = 0; i < cols; i++) {
                    heights[j * cols + i] = fn(i * cellSize, j * cellSize);
                }
            }
            return new Dem({
                cols: cols,
                rows: rows,
                cellSize: cellSize,
                heights: heights,
                originX: ox,
                originY: oy,
                originZ: oz,
            });
        }
    }

    SimRocas.Dem = Dem;
})(globalThis.SimRocas);
