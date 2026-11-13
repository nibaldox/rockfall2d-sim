'use strict';

/**
 * SimRocas — ProfileCorridor (T4.7).
 *
 * Proyección de las trayectorias de la simulación 3D sobre la polilínea de
 * sección del perfil 2D. Cada punto (x, y) local del DEM se proyecta al
 * punto más cercano de la polilínea: s = distancia acumulada a lo largo de
 * la polilínea (eje X del perfil 2D) y d = distancia perpendicular con
 * signo. Sólo se conservan los tramos de trayectoria dentro del corredor
 * |d| <= halfWidth (un track se corta al salir y empieza otro al volver a
 * entrar) y las detenciones (stopReason 'rest') dentro del corredor.
 *
 * Contrato (docs/contracts-3d.md): las rocas 3D traen la trayectoria como
 * cuádruplos (x, y, z, speed) locales en `trajectory` (Float32Array) con
 * `trajectoryLength` cuádruplos válidos, o vía método getTrajectory().
 */
(function () {
    const SimRocas = globalThis.SimRocas || (globalThis.SimRocas = {});

    /** Extrae la trayectoria valida de una roca 3D (cuádruplos x,y,z,speed). */
    function _rockTrajectory(rock) {
        if (!rock) return null;
        let traj = null;
        if (typeof rock.getTrajectory === 'function') {
            traj = rock.getTrajectory();
        }
        if (!traj && rock.trajectory) {
            traj = rock.trajectory;
        }
        if (!traj) return null;
        // Acepta array-like (Float32Array bandera o Array plano de JSON).
        if (typeof traj.length !== 'number') return null;
        let n = Math.floor(traj.length / 4);
        if (typeof rock.trajectoryLength === 'number') {
            n = Math.min(n, Math.max(0, Math.floor(rock.trajectoryLength)));
        }
        return { data: traj, count: n };
    }

    /** Percentil con interpolación lineal (idéntico criterio que Renderer). */
    function _percentile(sorted, pct) {
        if (!sorted || sorted.length === 0) return 0;
        const idx = (pct / 100) * (sorted.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
    }

    /**
     * Proyecta un punto a la polilínea (helper visible para tests):
     * recorre todos los tramos y devuelve el punto más cercano como
     * { s, d, dist2 }.
     */
    function _projectPoint(px, py, pts) {
        const n = pts.length - 1;
        const segLen = new Float64Array(n);
        const cum = new Float64Array(n);
        let acc = 0;
        for (let i = 0; i < n; i++) {
            const dx = pts[i + 1].x - pts[i].x;
            const dy = pts[i + 1].y - pts[i].y;
            segLen[i] = Math.sqrt(dx * dx + dy * dy);
            cum[i] = acc;
            acc += segLen[i];
        }
        return _projectPointFast(px, py, pts, cum, segLen);
    }

    /**
     * Proyecta el punto (px, py) al punto más cercano de la polilínea
     * con longitudes y s acumulado precalculados.
     * Devuelve { s, d, dist2 } con s = longitud acumulada hasta la
     * proyección y d = distancia perpendicular con signo (lado izquierdo
     * respecto al sentido de la polilínea).
     */
    function _projectPointFast(px, py, pts, cum, segLen) {
        let bestS = 0;
        let bestD = 0;
        let bestDist2 = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
            const ax = pts[i].x, ay = pts[i].y;
            const bx = pts[i + 1].x, by = pts[i + 1].y;
            const abx = bx - ax, aby = by - ay;
            const len2 = segLen[i] * segLen[i];
            let t = 0;
            if (len2 > 0) {
                t = ((px - ax) * abx + (py - ay) * aby) / len2;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
            }
            const qx = ax + t * abx, qy = ay + t * aby;
            const dx = px - qx, dy = py - qy;
            const dist2 = dx * dx + dy * dy;
            if (dist2 < bestDist2) {
                bestDist2 = dist2;
                bestS = cum[i] + t * segLen[i];
                // Distancia con signo: producto cruzado AB x AQ dividido por |AB|.
                bestD = segLen[i] > 0 ? (abx * (py - ay) - aby * (px - ax)) / segLen[i] : 0;
            }
        }
        return { s: bestS, d: bestD, dist2: bestDist2 };
    }

    /**
     * Proyecta las trayectorias 3D sobre la línea de sección.
     *
     * @param {Array} rocks resultados 3D (Rock3D serializados o crudos).
     * @param {Object} section { polylineLocal: [{x, y}, ...] } (locales del DEM).
     * @param {Object} opts { halfWidth = 10 } semiancho del corredor en m.
     * @returns {{
     *   tracks: Array<{ rockIndex: number, points: Float32Array }>,
     *   stops: Array<{ s: number, z: number, rockIndex: number }>,
     *   count: number, total: number, halfWidth: number,
     *   stats: { reachP50: number, reachP95: number, maxEnergyKJ: number }
     * }}
     */
    function project(rocks, section, opts) {
        const halfWidth = (opts && typeof opts.halfWidth === 'number' && isFinite(opts.halfWidth))
            ? opts.halfWidth
            : 10;

        const empty = {
            tracks: [],
            stops: [],
            count: 0,
            total: rocks ? rocks.length : 0,
            halfWidth,
            stats: { reachP50: 0, reachP95: 0, maxEnergyKJ: 0 }
        };

        if (!section || !Array.isArray(section.polylineLocal) || section.polylineLocal.length < 2) {
            return empty;
        }
        if (!Array.isArray(rocks) || rocks.length === 0) {
            return empty;
        }

        const pts = section.polylineLocal;
        // Longitudes y s acumulado por tramo.
        const segLen = new Float64Array(pts.length - 1);
        const cum = new Float64Array(pts.length - 1);
        let acc = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const dx = pts[i + 1].x - pts[i].x;
            const dy = pts[i + 1].y - pts[i].y;
            segLen[i] = Math.sqrt(dx * dx + dy * dy);
            cum[i] = acc;
            acc += segLen[i];
        }

        const hw2 = halfWidth * halfWidth;
        const tracks = [];
        const stops = [];
        const reachS = [];
        let inCorridor = 0;
        let maxEnergyKJ = 0;

        for (let r = 0; r < rocks.length; r++) {
            const rock = rocks[r];
            const traj = _rockTrajectory(rock);
            if (!traj || traj.count < 1) continue;

            // Un track por tramo continuo dentro del corredor. Un tramo con
            // un único punto no da polilínea dibujable: se descarta, pero
            // el punto sí cuenta para `count`.
            let run = [];
            let rockHasPoint = false;

            const flush = () => {
                if (run.length >= 2) {
                    tracks.push({ rockIndex: r, points: Float32Array.from(run) });
                }
                run = [];
            };

            for (let i = 0; i < traj.count; i++) {
                const o = i * 4;
                const px = traj.data[o], py = traj.data[o + 1];
                const z = traj.data[o + 2], speed = traj.data[o + 3];
                if (!isFinite(px) || !isFinite(py)) { flush(); continue; }
                const proj = _projectPointFast(px, py, pts, cum, segLen);
                if (proj.dist2 <= hw2) {
                    rockHasPoint = true;
                    run.push(proj.s, z, speed);
                } else {
                    flush();
                }
            }
            flush();

            if (rockHasPoint) {
                inCorridor++;
                const energy = (typeof rock.maxKineticEnergy === 'number' && isFinite(rock.maxKineticEnergy))
                    ? rock.maxKineticEnergy / 1000
                    : 0;
                if (energy > maxEnergyKJ) maxEnergyKJ = energy;
            }

            // Detención: sólo stopReason 'rest' dentro del corredor,
            // proyectando la posición final (x, y) del DEM local.
            if (rock.stopReason === 'rest' && isFinite(rock.finalX) && isFinite(rock.finalY)) {
                const proj = _projectPointFast(rock.finalX, rock.finalY, pts, cum, segLen);
                if (proj.dist2 <= hw2) {
                    stops.push({ s: proj.s, z: isFinite(rock.finalZ) ? rock.finalZ : 0, rockIndex: r });
                    reachS.push(proj.s);
                }
            }
        }

        reachS.sort((a, b) => a - b);
        return {
            tracks,
            stops,
            count: inCorridor,
            total: rocks.length,
            halfWidth,
            stats: {
                reachP50: _percentile(reachS, 50),
                reachP95: _percentile(reachS, 95),
                maxEnergyKJ
            }
        };
    }

    SimRocas.ProfileCorridor = { project, _projectPoint };
})();
