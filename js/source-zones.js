globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Zonas fuente de liberación (contrato C7).
     * - Zona puntual: { id, type: 'point', x, y }.
     * - Zona poligonal: { id, type: 'polygon', vertices: [{ x, y }, ...] }
     *   (>= 3 vértices, simple, sentido indiferente; área 0 → Error).
     */

    const EPS = 1e-9;

    function isPolygon(zone) {
        return zone && zone.type === 'polygon';
    }

    function onSegment(px, py, ax, ay, bx, by) {
        const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if (Math.abs(cross) > EPS) {
            return false;
        }
        const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
        if (dot < -EPS) {
            return false;
        }
        const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
        return dot <= len2 + EPS;
    }

    /**
     * Área del polígono (shoelace, valor absoluto). Las zonas puntuales devuelven 0
     * (en `distribute` el punto pondera como 1 m²).
     * @param {{id: string, type: string, vertices?: Array<{x: number, y: number}>}} zone
     * @returns {number}
     */
    function area(zone) {
        if (zone === null || typeof zone !== 'object') {
            throw new Error('SourceZones: zone debe ser un objeto con type "point" o "polygon"');
        }
        if (!isPolygon(zone)) {
            return 0;
        }
        const v = zone.vertices;
        if (!Array.isArray(v) || v.length < 3) {
            throw new Error('SourceZones: el polígono "' + String(zone.id) + '" debe tener al menos 3 vértices (recibidos: ' + (v ? v.length : 'ninguno') + ')');
        }
        let acc = 0;
        for (let k = 0; k < v.length; k++) {
            const a = v[k];
            const b = v[(k + 1) % v.length];
            acc += a.x * b.y - b.x * a.y;
        }
        return Math.abs(acc) / 2;
    }

    /**
     * true si (x, y) está dentro de la zona. En los polígonos el borde cuenta
     * como dentro (ray casting + comprobación explícita de arista).
     * Para una zona puntual, equivalencia exacta de coordenadas.
     * @param {{type: string, x?: number, y?: number, vertices?: Array<{x: number, y: number}>}} zone
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     */
    function contains(zone, x, y) {
        if (zone === null || typeof zone !== 'object') {
            throw new Error('SourceZones: zone debe ser un objeto con type "point" o "polygon"');
        }
        if (!isPolygon(zone)) {
            return x === zone.x && y === zone.y;
        }
        const v = zone.vertices;
        if (!Array.isArray(v) || v.length < 3) {
            throw new Error('SourceZones: el polígono "' + String(zone.id) + '" debe tener al menos 3 vértices');
        }
        let inside = false;
        for (let k = 0, m = v.length; k < m; k++) {
            const a = v[k];
            const b = v[(k + 1) % m];
            if (onSegment(x, y, a.x, a.y, b.x, b.y)) {
                return true; // el borde cuenta como dentro
            }
            if ((a.y > y) !== (b.y > y)) {
                const xCross = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
                if (xCross > x) {
                    inside = !inside;
                }
            }
        }
        return inside;
    }

    /** Triangulación en abanico desde v0 con pesos por área (polígono convexo). */
    function sampleFan(v, count, rng) {
        const n = v.length;
        const weights = new Array(n - 2);
        for (let k = 0; k < n - 2; k++) {
            const a = v[0];
            const b = v[k + 1];
            const c = v[k + 2];
            weights[k] = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
        }
        let total = 0;
        for (let k = 0; k < weights.length; k++) {
            total += weights[k];
        }
        const out = new Array(count);
        for (let m = 0; m < count; m++) {
            // elegir triángulo por peso
            let r = rng() * total;
            let tri = 0;
            while (tri < weights.length - 1 && r > weights[tri]) {
                r -= weights[tri];
                tri++;
            }
            const a = v[0];
            const b = v[tri + 1];
            const c = v[tri + 2];
            // muestreo barycéntrico uniforme en el triángulo:
            // r1, r2 ~ U(0,1); su = sqrt(r1) anula la acumulación junto a v0
            const su = Math.sqrt(rng());
            const b1 = 1 - su;
            const r2 = rng();
            const b2 = su * (1 - r2);
            const b3 = su * r2;
            out[m] = {
                x: a.x * b1 + b.x * b2 + c.x * b3,
                y: a.y * b1 + b.y * b2 + c.y * b3,
            };
        }
        return out;
    }

    function sampleRejection(zone, count, rng, maxAttempts) {
        const v = zone.vertices;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let k = 0; k < v.length; k++) {
            if (v[k].x < minX) { minX = v[k].x; }
            if (v[k].x > maxX) { maxX = v[k].x; }
            if (v[k].y < minY) { minY = v[k].y; }
            if (v[k].y > maxY) { maxY = v[k].y; }
        }
        const out = new Array(count);
        let attempts = 0;
        let filled = 0;
        while (filled < count) {
            if (attempts >= maxAttempts) {
                throw new Error('SourceZones: no se pudo muestrear el polígono "' + String(zone.id) + '" en ' + maxAttempts + ' intentos (área demasiado pequeña frente a su bbox)');
            }
            attempts++;
            const px = minX + rng() * (maxX - minX);
            const py = minY + rng() * (maxY - minY);
            if (contains(zone, px, py)) {
                out[filled++] = { x: px, y: py };
            }
        }
        return out;
    }

    function isConvex(v) {
        const n = v.length;
        let sign = 0;
        for (let k = 0; k < n; k++) {
            const a = v[k];
            const b = v[(k + 1) % n];
            const c = v[(k + 2) % n];
            const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
            if (cross > EPS) {
                if (sign < 0) { return false; }
                sign = 1;
            } else if (cross < -EPS) {
                if (sign > 0) { return false; }
                sign = -1;
            }
        }
        return true;
    }

    /**
     * Muestreo uniforme en la zona: `count` puntos { x, y }.
     * Polígono convexo → abanico de triángulos ponderado por área;
     * polígono cóncavo → rechazo sobre su bbox (con tope de intentos).
     * Zona puntual → el mismo punto repetido.
     * @param {{type: string}} zone
     * @param {number} count
     * @param {function(): number} [rng=Math.random]
     * @returns {Array<{x: number, y: number}>}
     */
    function sample(zone, count, rng) {
        if (typeof count !== 'number' || !(count >= 0) || !Number.isInteger(count)) {
            throw new Error('SourceZones: count debe ser un entero >= 0 (recibido: ' + count + ')');
        }
        if (rng !== undefined && rng !== null && typeof rng !== 'function') {
            throw new Error('SourceZones: rng debe ser una función que devuelva [0, 1)');
        }
        const random = rng || Math.random;
        if (zone === null || typeof zone !== 'object') {
            throw new Error('SourceZones: zone debe ser un objeto con type "point" o "polygon"');
        }
        if (!isPolygon(zone)) {
            const out = new Array(count);
            for (let k = 0; k < count; k++) {
                out[k] = { x: zone.x, y: zone.y };
            }
            return out;
        }
        const v = zone.vertices;
        try {
            if (area(zone) === 0) {
                throw new Error('área');
            }
        } catch (err) {
            throw new Error('SourceZones: el polígono "' + String(zone.id) + '" es degenerado (área 0 o menos de 3 vértices), no se puede muestrear');
        }
        if (isConvex(v)) {
            return sampleFan(v, count, random);
        }
        return sampleRejection(zone, count, random, count * 100 + 1000);
    }

    /**
     * Reparto de `totalRocks` entre `zones` proporcional al área (los puntos
     * ponderan 1 m²), con redondeo de mayor resto que suma exactamente totalRocks.
     * @param {Array<{id: string, type: string}>} zones
     * @param {number} totalRocks Entero >= 0.
     * @returns {Array<{zone: object, count: number}>} Mismo orden que zones.
     */
    function distribute(zones, totalRocks) {
        if (!Array.isArray(zones) || zones.length === 0) {
            throw new Error('SourceZones: zones debe ser un array con al menos una zona');
        }
        if (typeof totalRocks !== 'number' || !Number.isInteger(totalRocks) || totalRocks < 0) {
            throw new Error('SourceZones: totalRocks debe ser un entero >= 0 (recibido: ' + String(totalRocks) + ')');
        }
        const weights = new Array(zones.length);
        let sum = 0;
        for (let k = 0; k < zones.length; k++) {
            const zone = zones[k];
            let w;
            if (isPolygon(zone)) {
                w = area(zone); // valida < 3 vértices / área 0
                if (!(w > 0)) {
                    throw new Error('SourceZones: el polígono "' + String(zone.id) + '" no puede tener área 0');
                }
            } else {
                w = 1; // los puntos cuentan como 1 m²
            }
            weights[k] = w;
            sum += w;
        }
        const counts = new Array(zones.length);
        const remainders = new Array(zones.length);
        let assigned = 0;
        for (let k = 0; k < zones.length; k++) {
            const exact = totalRocks * weights[k] / sum;
            const floor = Math.floor(exact);
            counts[k] = floor;
            remainders[k] = exact - floor;
            assigned += floor;
        }
        let pending = totalRocks - assigned;
        while (pending > 0) {
            let best = -1;
            for (let k = 0; k < zones.length; k++) {
                if (remainders[k] > 0 && (best === -1 || remainders[k] > remainders[best])) {
                    best = k;
                }
            }
            if (best === -1) {
                throw new Error('SourceZones: no se pudo repartir exactamente ' + totalRocks + ' rocas');
            }
            counts[best]++;
            remainders[best] = 0;
            pending--;
        }
        return zones.map((zone, k) => ({ zone: zone, count: counts[k] }));
    }

    SimRocas.SourceZones = {
        area: area,
        contains: contains,
        sample: sample,
        distribute: distribute,
    };
})(globalThis.SimRocas);
