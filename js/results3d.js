globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Rásteres de resultados 3D (contrato C7).
     *
     * Results3D.build(dem, rocks, { cellSize = dem.cellSize }) → rásteres
     * alineados al DEM (mismo origen mundo: nodo (0,0) en (originX, originY)):
     * - passCount (Uint32): nº de rocas distintas que pasan por cada celda.
     *   Cada roca cuenta como máximo 1 vez por celda: se rasterizan los
     *   segmentos de trayectoria consecutivos con un DDA/Amanatides-Woo 2D
     *   en planta (celda (i, j) con i en [0, cols-1], j en [0, rows-1]).
     * - maxEnergyKJ (Float32): ½·m·v² con el `speed` del cuádruplo de
     *   trayectoria y la masa de la roca (rock.mass), máximo por celda. El
     *   contrato no registra ½mv² en la trayectoria, solo speed: se deriva
     *   aquí. Si la roca no expone `mass`, se aporta 0 J.
     * - maxBounceHeight (Float32): z − dem.heightAt(x,y) − rock.radius por
     *   punto (altura sobre el terreno bajo la roca), máximo por celda, ≥ 0.
     * - stopCount (Uint32): posiciones finales con stopReason === 'rest'.
     * - reachProbability (Float32) = passCount / nº de rocas.
     *
     * Results3D.toAsc(raster, dem, field) → texto ESRI ASCII Grid con
     * xllcenter/yllcenter en coordenadas MUNDO (origen del DEM), filas de
     * norte a sur y NODATA_value -9999 donde passCount === 0 para los campos
     * de energía/altura.
     */

    const NODATA = -9999;

    function validateOptions(cellSize) {
        if (!Number.isFinite(cellSize) || cellSize <= 0) {
            throw new Error('Results3D: cellSize debe ser finito y > 0 (recibido: ' + cellSize + ')');
        }
    }

    /**
     * DDA 2D (Amanatides-Woo) en planta: visita las celdas atravesadas por el
     * segmento (x0,y0)→(x1,y1) en la grilla de celdas cellSize con origen (0,0).
     * Cada celda in-bounds se marca una vez por roca vía sello (stamp).
     */
    function rasterizeSegment(stampGrid, stamp, passCount, cols, rows, cellSize, x0, y0, x1, y1) {
        const maxX = cols * cellSize;
        const maxY = rows * cellSize;
        let i = Math.floor(x0 / cellSize);
        let j = Math.floor(y0 / cellSize);
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.hypot(dx, dy);
        const visit = (ci, cj) => {
            if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) {
                return;
            }
            const idx = cj * cols + ci;
            if (stampGrid[idx] !== stamp) {
                stampGrid[idx] = stamp;
                passCount[idx]++;
            }
        };
        visit(i, j);
        if (length < 1e-12) {
            return;
        }
        const stepI = dx > 0 ? 1 : -1;
        const stepJ = dy > 0 ? 1 : -1;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const tDeltaI = absDx > 0 ? cellSize / absDx : Infinity;
        const tDeltaJ = absDy > 0 ? cellSize / absDy : Infinity;
        // distancia t (en [0, 1] sobre el segmento) hasta la primera frontera de celda
        let tMaxI = absDx > 0
            ? (dx > 0 ? (i + 1) * cellSize - x0 : x0 - i * cellSize) / absDx
            : Infinity;
        let tMaxJ = absDy > 0
            ? (dy > 0 ? (j + 1) * cellSize - y0 : y0 - j * cellSize) / absDy
            : Infinity;
        for (;;) {
            if (tMaxI <= tMaxJ) {
                if (tMaxI > 1) {
                    return;
                }
                i += stepI;
                tMaxI += tDeltaI;
            } else {
                if (tMaxJ > 1) {
                    return;
                }
                j += stepJ;
                tMaxJ += tDeltaJ;
            }
            // celda siguiente fuera del ráster: la trayectoria ya no vuelve a entrar
            if (i < 0 || i >= cols || j < 0 || j >= rows) {
                return;
            }
            visit(i, j);
        }
    }

    /**
     * Actualiza maxEnergyKJ y maxBounceHeight de la celda de un punto de trayectoria.
     * Energía = ½·mass·v² (kJ); altura = z − terreno − radio (≥ 0).
     */
    function processPoint(x, y, z, v, mass, radius, cellSize, cols, rows, dem, maxEnergyKJ, maxBounceHeight) {
        const cellI = Math.floor(x / cellSize);
        const cellJ = Math.floor(y / cellSize);
        if (cellI < 0 || cellI >= cols || cellJ < 0 || cellJ >= rows) {
            return;
        }
        const idx = cellJ * cols + cellI;
        if (Number.isFinite(v) && mass > 0) {
            const energyKJ = 0.5 * mass * v * v / 1000;
            if (energyKJ > maxEnergyKJ[idx]) {
                maxEnergyKJ[idx] = energyKJ;
            }
        }
        const ground = dem.heightAt(x, y);
        if (Number.isFinite(ground) && Number.isFinite(z)) {
            const h = z - ground - radius;
            const clamped = h > 0 ? h : 0;
            if (clamped > maxBounceHeight[idx]) {
                maxBounceHeight[idx] = clamped;
            }
        }
    }

    /**
     * Construye los rásteres de resultados a partir de las trayectorias de las rocas.
     * @param {SimRocas.Dem} dem DEM de referencia (origen y extensión).
     * @param {Array} rocks Objetos con la forma del contrato C7 (trajectory como
     *   cuádruplos (x, y, z, speed), mass, radius, stopReason, finalX/finalY).
     * @param {{cellSize?: number}} [options] cellSize del ráster (defecto dem.cellSize).
     * @returns {{cols: number, rows: number, cellSize: number, originX: number, originY: number,
     *            passCount: Uint32Array, maxEnergyKJ: Float32Array, maxBounceHeight: Float32Array,
     *            stopCount: Uint32Array, reachProbability: Float32Array, nRocks: number}}
     */
    function build(dem, rocks, options) {
        if (!dem || typeof dem.cellSize !== 'number' || !Array.isArray(rocks)) {
            throw new Error('Results3D.build: se requiere un Dem y un array de rocas');
        }
        const cellSize = options && options.cellSize !== undefined ? options.cellSize : dem.cellSize;
        validateOptions(cellSize);
        const extX = (dem.cols - 1) * dem.cellSize;
        const extY = (dem.rows - 1) * dem.cellSize;
        const cols = Math.max(1, Math.ceil(extX / cellSize) + 1);
        const rows = Math.max(1, Math.ceil(extY / cellSize) + 1);
        const n = cols * rows;
        const passCount = new Uint32Array(n);
        const maxEnergyKJ = new Float32Array(n);
        const maxBounceHeight = new Float32Array(n);
        const stopCount = new Uint32Array(n);
        const stampGrid = new Int32Array(n);
        let stamp = 0;
        const nRocks = rocks.length;

        for (let r = 0; r < nRocks; r++) {
            const rock = rocks[r];
            stamp++;
            const traj = rock.getTrajectory ? rock.getTrajectory() : rock.trajectory;
            const len = rock.trajectoryLength !== undefined ? rock.trajectoryLength : (traj ? traj.length / 4 : 0);
            const mass = typeof rock.mass === 'number' && Number.isFinite(rock.mass) ? rock.mass : 0;
            const radius = typeof rock.radius === 'number' && Number.isFinite(rock.radius) ? rock.radius : 0;
            const quads = traj.length / 4 >= len ? len : traj.length / 4;
            if (quads < 1) {
                continue;
            }
            let prevX = traj[0];
            let prevY = traj[1];
            rasterizeSegment(stampGrid, stamp, passCount, cols, rows, cellSize, prevX, prevY, prevX, prevY);
            processPoint(prevX, prevY, traj[2], traj[3], mass, radius, cellSize, cols, rows, dem, maxEnergyKJ, maxBounceHeight);
            for (let k = 1; k < quads; k++) {
                const q = k * 4;
                const x = traj[q];
                const y = traj[q + 1];
                const z = traj[q + 2];
                const v = traj[q + 3];
                rasterizeSegment(stampGrid, stamp, passCount, cols, rows, cellSize, prevX, prevY, x, y);
                prevX = x;
                prevY = y;
                processPoint(x, y, z, v, mass, radius, cellSize, cols, rows, dem, maxEnergyKJ, maxBounceHeight);
            }
            // parada (reposo): cuenta una celda por roca
            if (rock.stopReason === 'rest' && Number.isFinite(rock.finalX) && Number.isFinite(rock.finalY)) {
                const si = Math.floor(rock.finalX / cellSize);
                const sj = Math.floor(rock.finalY / cellSize);
                if (si >= 0 && si < cols && sj >= 0 && sj < rows) {
                    stopCount[sj * cols + si]++;
                }
            }
        }

        const reachProbability = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            reachProbability[k] = nRocks > 0 ? passCount[k] / nRocks : 0;
        }

        return {
            cols: cols,
            rows: rows,
            cellSize: cellSize,
            originX: dem.originX,
            originY: dem.originY,
            passCount: passCount,
            maxEnergyKJ: maxEnergyKJ,
            maxBounceHeight: maxBounceHeight,
            stopCount: stopCount,
            reachProbability: reachProbability,
            nRocks: nRocks,
        };
    }

    function formatValue(value, decimals) {
        if (decimals <= 0) {
            return String(value);
        }
        return value.toFixed(decimals);
    }

    /**
     * Exporta un campo del resultado como texto ESRI ASCII Grid.
     * Origen (xllcenter/yllcenter) = coordenadas MUNDO del nodo (0,0) del DEM.
     * Filas de NORTE a SUR. Para campos de energía/altura, NODATA_value -9999
     * donde passCount === 0.
     * @param {object} raster Resultado de Results3D.build.
     * @param {SimRocas.Dem} dem DEM de referencia (origen mundo).
     * @param {'passCount'|'maxEnergyKJ'|'maxBounceHeight'|'stopCount'|'reachProbability'} field
     * @returns {string}
     */
    function toAsc(raster, dem, field) {
        const fields = {
            passCount: { data: raster.passCount, decimals: 0, nodata: false },
            maxEnergyKJ: { data: raster.maxEnergyKJ, decimals: 6, nodata: true },
            maxBounceHeight: { data: raster.maxBounceHeight, decimals: 6, nodata: true },
            stopCount: { data: raster.stopCount, decimals: 0, nodata: false },
            reachProbability: { data: raster.reachProbability, decimals: 6, nodata: false },
        };
        if (!raster || !raster.passCount || !raster.maxEnergyKJ) {
            throw new Error('Results3D.toAsc: raster debe ser el resultado de Results3D.build');
        }
        if (!dem || typeof dem.originX !== 'number') {
            throw new Error('Results3D.toAsc: dem debe ser un SimRocas.Dem');
        }
        const spec = fields[field];
        if (!spec) {
            throw new Error('Results3D.toAsc: campo desconocido "' + String(field) + '" (válidos: passCount, maxEnergyKJ, maxBounceHeight, stopCount, reachProbability)');
        }
        const data = spec.data;
        const pass = raster.passCount;
        const lines = [
            'ncols         ' + raster.cols,
            'nrows         ' + raster.rows,
            'xllcenter     ' + dem.originX,
            'yllcenter     ' + dem.originY,
            'cellsize      ' + raster.cellSize,
        ];
        if (spec.nodata) {
            lines.push('NODATA_value  ' + NODATA);
        }
        const cols = raster.cols;
        for (let j = raster.rows - 1; j >= 0; j--) {
            const parts = new Array(cols);
            for (let i = 0; i < cols; i++) {
                const idx = j * cols + i;
                if (spec.nodata && pass[idx] === 0) {
                    parts[i] = String(NODATA);
                } else {
                    parts[i] = formatValue(data[idx], spec.decimals);
                }
            }
            lines.push(parts.join(' '));
        }
        return lines.join('\n') + '\n';
    }

    SimRocas.Results3D = {
        build: build,
        toAsc: toAsc,
        NODATA: NODATA,
    };
})(globalThis.SimRocas);
