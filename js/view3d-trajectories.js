/**
 * SimRocas 3D — capa de trayectorias (T4.6).
 *
 * Parte pura (testeable en Node sin THREE):
 *   - SimRocas.Trajectories3D.speedColor(t) → [r, g, b] con la rampa de
 *     velocidad (azul lento → rojo rápido, extremos en RAMP).
 *   - SimRocas.Trajectories3D.segmentsFromRocks(rocks, { maxTracks = 500 })
 *     → { positions, colors, minSpeed, maxSpeed, nSampled }: Float32Array de
 *     PARES de puntos (LineSegments) muestreando uniformemente hasta
 *     `maxTracks` rocas, más el rango de velocidad real del muestreo.
 *   - SimRocas.Trajectories3D.stopPointsFromRocks(rocks) → { positions,
 *     colors, count } con la posición final de las rocas detenidas ('rest').
 *
 * Parte THREE (requiere globalThis.THREE):
 *   - Trajectories3D.build(rocks, { maxTracks, exaggeration }) → { group,
 *     legend, nSampled, stops } : THREE.Group con LineSegments (colores por
 *     velocidad) + Points de detenciones; escala z ya fijada con la
 *     exageración vertical (la capa respeta la escala del DEM).
 *
 * Coordenadas locales del DEM (nunca UTM). Sin DOM.
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Rampa de velocidad: azul (lento) → cian → amarillo → naranja → rojo
     * (rápido). Mismo formato que las rampas de js/view3d-terrain.js.
     */
    const RAMP = [
        { t: 0.00, c: [0.13, 0.37, 0.97] },
        { t: 0.25, c: [0.23, 0.80, 0.84] },
        { t: 0.50, c: [0.98, 0.86, 0.25] },
        { t: 0.75, c: [0.95, 0.46, 0.13] },
        { t: 1.00, c: [0.88, 0.14, 0.11] },
    ];

    function clamp01(v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /**
     * Color de la rampa para t en [0, 1] (recortado). NaN → tono medio.
     * @returns {[number, number, number]} rgb en 0..1.
     */
    function speedColor(t) {
        if (!Number.isFinite(t)) {
            return RAMP[2].c.slice();
        }
        const tt = clamp01(t);
        for (let i = 0; i < RAMP.length - 1; i++) {
            const a = RAMP[i];
            const b = RAMP[i + 1];
            if (tt >= a.t && tt <= b.t) {
                const f = (tt - a.t) / ((b.t - a.t) || 1);
                return [
                    a.c[0] + f * (b.c[0] - a.c[0]),
                    a.c[1] + f * (b.c[1] - a.c[1]),
                    a.c[2] + f * (b.c[2] - a.c[2]),
                ];
            }
        }
        return RAMP[RAMP.length - 1].c.slice();
    }

    /** Cuádruplos válidos de un objeto-roca (contrato C7, plano del worker). */
    function rockTraj(rock) {
        const traj = (rock.getTrajectory && typeof rock.getTrajectory === 'function')
            ? rock.getTrajectory()
            : (rock.trajectory || null);
        if (!traj || !traj.length) {
            return null;
        }
        let len = rock.trajectoryLength !== undefined ? rock.trajectoryLength : traj.length / 4;
        if (len * 4 > traj.length) {
            len = Math.floor(traj.length / 4);
        }
        return { traj: traj, quads: len };
    }

    /**
     * Segmentos de trayectoria (pura): samplea rocas uniformemente con stride
     * ceil(n / maxTracks) (sin exceso si hay menos rocas). Devuelve pares de
     * puntos (para LineSegments) y colores por VELocidad (t normalizado al
     * min/max del muestreo); rango plano → medio de la rampa.
     */
    function segmentsFromRocks(rocks, opts) {
        if (!Array.isArray(rocks)) {
            throw new Error('Trajectories3D.segmentsFromRocks: rocks debe ser un array');
        }
        const maxTracks = (opts && opts.maxTracks !== undefined) ? opts.maxTracks : 500;
        if (!Number.isInteger(maxTracks) || maxTracks < 1) {
            throw new Error('Trajectories3D.segmentsFromRocks: maxTracks debe ser un entero >= 1');
        }
        const n = rocks.length;
        const stride = n > maxTracks ? Math.ceil(n / maxTracks) : 1;
        // Primera pasada: recolectar { traj, quads } de las rocas muestreadas
        // y el rango de velocidad.
        const picked = [];
        let minSpeed = Infinity;
        let maxSpeed = -Infinity;
        for (let i = 0; i < n; i += stride) {
            const t = rockTraj(rocks[i]);
            if (!t || t.quads < 1) {
                continue;
            }
            picked.push(t);
            for (let k = 0; k < t.quads; k++) {
                const s = t.traj[k * 4 + 3];
                if (Number.isFinite(s)) {
                    if (s < minSpeed) { minSpeed = s; }
                    if (s > maxSpeed) { maxSpeed = s; }
                }
            }
        }
        if (picked.length === 0) {
            return { positions: new Float32Array(0), colors: new Float32Array(0), minSpeed: 0, maxSpeed: 0, nSampled: 0 };
        }
        const flat = maxSpeed > minSpeed;
        // Segunda pasada: posiciones (2 puntos por segmento) + color por punto.
        let totalPoints = 0;
        for (const t of picked) {
            totalPoints += (t.quads - 1) * 2; // segmentos × 2 extremos
        }
        const positions = new Float32Array(totalPoints * 3);
        const colors = new Float32Array(totalPoints * 3);
        let wp = 0;
        let wc = 0;
        for (const t of picked) {
            for (let k = 0; k < t.quads - 1; k++) {
                for (const qi of [k, k + 1]) {
                    const q = qi * 4;
                    positions[wp++] = t.traj[q];
                    positions[wp++] = t.traj[q + 1];
                    positions[wp++] = t.traj[q + 2];
                    const s = t.traj[q + 3];
                    const tt = flat ? (Number.isFinite(s) ? (s - minSpeed) / (maxSpeed - minSpeed) : 0.5) : 0.5;
                    const c = speedColor(tt);
                    colors[wc++] = c[0];
                    colors[wc++] = c[1];
                    colors[wc++] = c[2];
                }
            }
        }
        return {
            positions: positions,
            colors: colors,
            minSpeed: Number.isFinite(minSpeed) ? minSpeed : 0,
            maxSpeed: Number.isFinite(maxSpeed) ? maxSpeed : 0,
            nSampled: picked.length,
        };
    }

    /**
     * Puntos de detención (pura): posición final de las rocas con
     * stopReason === 'rest'. Color fijo (marcador naranja).
     */
    function stopPointsFromRocks(rocks) {
        if (!Array.isArray(rocks)) {
            throw new Error('Trajectories3D.stopPointsFromRocks: rocks debe ser un array');
        }
        const STOP_COLOR = [0.99, 0.62, 0.05];
        let count = 0;
        for (const r of rocks) {
            if (r && r.stopReason === 'rest' && Number.isFinite(r.finalX) &&
                Number.isFinite(r.finalY) && Number.isFinite(r.finalZ)) {
                count++;
            }
        }
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        let wp = 0;
        let wc = 0;
        for (const r of rocks) {
            if (r && r.stopReason === 'rest' && Number.isFinite(r.finalX) &&
                Number.isFinite(r.finalY) && Number.isFinite(r.finalZ)) {
                positions[wp++] = r.finalX;
                positions[wp++] = r.finalY;
                positions[wp++] = r.finalZ;
                colors[wc++] = STOP_COLOR[0];
                colors[wc++] = STOP_COLOR[1];
                colors[wc++] = STOP_COLOR[2];
            }
        }
        return { positions: positions, colors: colors, count: count };
    }

    function hexFromRgb(c) {
        const to = (v) => ('0' + Math.round(clamp01(v) * 255).toString(16)).slice(-2);
        return '#' + to(c[0]) + to(c[1]) + to(c[2]);
    }

    /** CSS de la leyenda de velocidad (mismos extremos que speedColor). */
    function rampCss() {
        const parts = RAMP.map((s) => hexFromRgb(s.c) + ' ' + Math.round(s.t * 100) + '%');
        return 'linear-gradient(90deg, ' + parts.join(', ') + ')';
    }

    /**
     * Construye la capa THREE con las trayectorias y las detenciones.
     * @param {Array} rocks Rocas serializadas del pool (o Rock3D).
     * @param {{maxTracks?: number, exaggeration?: number, colorBy?: string}} [opts]
     * @returns {{group: THREE.Group, legend: {minSpeed, maxSpeed},
     *            nSampled: number, stops: number}|null} null si no hay datos.
     */
    function build(rocks, opts = {}) {
        const THREE = globalThis.THREE;
        if (!THREE) {
            throw new Error('Trajectories3D.build: THREE no está disponible');
        }
        if (!Array.isArray(rocks) || rocks.length === 0) {
            return null;
        }
        const seg = segmentsFromRocks(rocks, opts);
        const st = stopPointsFromRocks(rocks);
        if (seg.positions.length === 0 && st.count === 0) {
            return null;
        }
        const group = new THREE.Group();
        if (seg.positions.length > 0) {
            const lineGeo = new THREE.BufferGeometry();
            lineGeo.setAttribute('position', new THREE.BufferAttribute(seg.positions, 3));
            lineGeo.setAttribute('color', new THREE.BufferAttribute(seg.colors, 3));
            const lineMat = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.85,
            });
            const lines = new THREE.LineSegments(lineGeo, lineMat);
            lines.renderOrder = 12;
            group.add(lines);
        }
        if (st.count > 0) {
            const ptGeo = new THREE.BufferGeometry();
            ptGeo.setAttribute('position', new THREE.BufferAttribute(st.positions, 3));
            ptGeo.setAttribute('color', new THREE.BufferAttribute(st.colors, 3));
            const ptMat = new THREE.PointsMaterial({
                vertexColors: true,
                size: 5,
                sizeAttenuation: false,
            });
            const pts = new THREE.Points(ptGeo, ptMat);
            pts.renderOrder = 13;
            group.add(pts);
        }
        const k = Number.isFinite(opts.exaggeration) && opts.exaggeration > 0
            ? opts.exaggeration : 1;
        group.scale.z = k;
        return {
            group: group,
            legend: { minSpeed: seg.minSpeed, maxSpeed: seg.maxSpeed },
            nSampled: seg.nSampled,
            stops: st.count,
        };
    }

    SimRocas.Trajectories3D = {
        RAMP: RAMP,
        speedColor: speedColor,
        segmentsFromRocks: segmentsFromRocks,
        stopPointsFromRocks: stopPointsFromRocks,
        rampCss: rampCss,
        build: build,
    };
})(globalThis.SimRocas);
