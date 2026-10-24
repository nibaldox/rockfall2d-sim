globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * T3.5 — Perfil trazado sobre el terreno 3D → muestreo del DEM.
     * Funciones PURAS (sin THREE, aptas para Node/tests): consumen un
     * SimRocas.Dem y una polilínea en coordenadas LOCALES del DEM.
     */

    /**
     * Intervalo 'bonito' (1/2/5·10^k) más cercano en términos RELATIVOS a
     * target = relief / 20 (≈ 20 líneas de nivel). En empate exacto gana el
     * menor. Sin datos (relief <= 0 o no finito) devuelve 1.
     * @param {number} relief Relieve total (maxZ - minZ) en metros.
     * @returns {number} intervalo en metros (> 0).
     */
    function niceInterval(relief) {
        if (!Number.isFinite(relief) || relief <= 0) {
            return 1;
        }
        const target = relief / 20;
        const k = Math.floor(Math.log10(target));
        let best = null;
        for (const m of [1, 2, 5]) {
            for (const kk of [k, k + 1]) {
                const cand = m * Math.pow(10, kk);
                const err = Math.abs(cand - target) / target;
                if (best === null || err < best.err - 1e-15 ||
                    (Math.abs(err - best.err) <= 1e-15 && cand < best.cand)) {
                    best = { cand: cand, err: err };
                }
            }
        }
        return best.cand;
    }

    /** Longitud horizontal PLAN de una polilínea [{x, y}]. */
    function polylineLength(polyline) {
        let total = 0;
        for (let i = 1; i < polyline.length; i++) {
            total += Math.hypot(polyline[i].x - polyline[i - 1].x,
                polyline[i].y - polyline[i - 1].y);
        }
        return total;
    }

    /**
     * Azimut (grados, 0 = norte +Y, medido hacia el este) del primer tramo
     * no degenerado de la polilínea; NaN si toda es degenerada.
     */
    function azimuthDeg(polyline) {
        for (let i = 1; i < polyline.length; i++) {
            const dx = polyline[i].x - polyline[i - 1].x;
            const dy = polyline[i].y - polyline[i - 1].y;
            if (Math.hypot(dx, dy) > 1e-12) {
                let az = Math.atan2(dx, dy) * 180 / Math.PI;
                if (az < 0) { az += 360; }
                return az;
            }
        }
        return NaN;
    }

    /**
     * Muestrea el DEM a lo largo de la polilínea local `polylineLocal`.
     * Concatena Dem.sampleProfile de cada tramo con distancia ACUMULADA
     * (x = distancia desde el primer vértice, y = cota local), sin duplicar
     * el vértice compartido entre tramos contiguos. Si un tramo tiene huecos
     * (NaN) se corta en el primer hueco: el punto de corte marca el final y
     * los tramos posteriores no se muestrean.
     *
     * @param {SimRocas.Dem} dem DEM de origen.
     * @param {Array<{x: number, y: number}>} polylineLocal Vértices en local.
     * @param {number} [spacing=dem.cellSize] Separación de muestreo (m > 0).
     * @returns {{points: Array<{x: number, y: number}>, truncated: boolean,
     *            validLength: number}} points: {x: distancia, y: cota};
     *           validLength: distancia del último punto válido desde el origen.
     * @throws {Error} si dem/spacing son inválidos o la polilínea no tiene
     *                 al menos 2 vértices.
     */
    function sample(dem, polylineLocal, spacing) {
        if (!dem || typeof dem.sampleProfile !== 'function') {
            throw new Error('ProfileFromDem.sample: dem inválido (se esperaba un SimRocas.Dem)');
        }
        if (!Array.isArray(polylineLocal) || polylineLocal.length < 2) {
            throw new Error('ProfileFromDem.sample: la polilínea necesita al menos 2 vértices');
        }
        let sp = spacing;
        if (sp === undefined || sp === null) { sp = dem.cellSize; }
        if (!Number.isFinite(sp) || sp <= 0) {
            throw new Error('ProfileFromDem.sample: spacing debe ser finito y > 0 (recibido: ' + sp + ')');
        }

        // Descarta vértices duplicados contiguos (tramos de longitud nula).
        const verts = [];
        for (const p of polylineLocal) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                throw new Error('ProfileFromDem.sample: vértice con coordenadas no finitas');
            }
            if (verts.length === 0 ||
                Math.hypot(p.x - verts[verts.length - 1].x,
                    p.y - verts[verts.length - 1].y) > 1e-12) {
                verts.push({ x: p.x, y: p.y });
            }
        }
        if (verts.length < 2) {
            throw new Error('ProfileFromDem.sample: la polilínea es degenerada (un solo punto)');
        }

        const points = [];
        let truncated = false;
        let offset = 0; // distancia acumulada al inicio del tramo courant
        for (let i = 1; i < verts.length && !truncated; i++) {
            const a = verts[i - 1];
            const b = verts[i];
            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
            const samples = dem.sampleProfile(a.x, a.y, b.x, b.y, sp);
            // Si la cadena ya cubre el vértice anterior (tramo previo
            // completo y con datos), el primer punto del tramo actual es el
            // mismo en el terreno: no duplicarlo.
            const skipFirst = points.length > 0 &&
                Math.abs(points[points.length - 1].x - offset) < 1e-9 * Math.max(1, offset);
            for (let s = skipFirst ? 1 : 0; s < samples.length; s++) {
                const d = offset + samples[s].x;
                points.push({ x: d, y: samples[s].y });
            }
            // Truncado si el tramo quedó vacío o no alcanza el vértice final
            // (hueco de NaN según sampleProfile).
            const complete = samples.length > 0 &&
                Math.abs(samples[samples.length - 1].x - segLen) <=
                    1e-9 * Math.max(1, segLen);
            if (!complete) {
                truncated = true;
            }
            offset += segLen;
        }
        const validLength = points.length ? points[points.length - 1].x : 0;
        return { points: points, truncated: truncated, validLength: validLength };
    }

    SimRocas.ProfileFromDem = {
        niceInterval: niceInterval,
        polylineLength: polylineLength,
        azimuthDeg: azimuthDeg,
        sample: sample
    };
})(globalThis.SimRocas);
