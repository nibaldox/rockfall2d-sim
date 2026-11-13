globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * T3.7 — Vista en planta: adaptación del DEM al formato de heightmap de
     * StlContour + generación de curvas de nivel (marching squares de
     * js/stl.js). La parte THREE (THREE.LineSegments) vive en js/view3d-terrain.js
     * vía el viewer; aquí sólo cabezera de datos PURA (Node/tests sin THREE).
     *
     * Conveniencia del formato: StlContour.extractContour trata
     * heights[r·cols + c] como la esquina (minHX + c·cellW, minHY + r·cellH)
     * de la celda (c, r), interpolando a lo largo de las aristas ENTRE nodos.
     * Los nodos del DEM tienen exactamente ese rol (altura AT nodes), de modo
     * que la adaptación mapea nodo→esquina 1:1 y los vértices de las curvas
     * quedan sobre las aristas interpoladas de la grilla del DEM (más fiel
     * que el rasterizador por centro de celda del STL).
     */

    const NODATA = -1e30;

    /**
     * Adapta un SimRocas.Dem al formato de heightmap de StlContour.
     * NaN (nodo sin dato) → NODATA (-1e30) como espera extractContour.
     * @param {SimRocas.Dem} dem
     * @returns {{heights: Float32Array, cols: number, rows: number,
     *            cellW: number, cellH: number, minHX: number, minHY: number}}
     *          Coordenadas locales del DEM (minHX = minHY = 0).
     */
    function heightmapFromDem(dem) {
        if (!dem || !ArrayBuffer.isView(dem.heights) ||
            !Number.isInteger(dem.cols) || !Number.isInteger(dem.rows) ||
            dem.heights.length !== dem.cols * dem.rows ||
            !Number.isFinite(dem.cellSize) || dem.cellSize <= 0) {
            throw new Error('PlanView.heightmapFromDem: dem inválido');
        }
        const heights = new Float32Array(dem.heights.length);
        for (let k = 0; k < dem.heights.length; k++) {
            const z = dem.heights[k];
            heights[k] = Number.isFinite(z) ? z : NODATA;
        }
        return {
            heights: heights,
            cols: dem.cols,
            rows: dem.rows,
            cellW: dem.cellSize,
            cellH: dem.cellSize,
            minHX: 0,
            minHY: 0
        };
    }

    /**
     * Curvas de nivel del DEM con el intervalo dado (convenio StlContour).
     * Devuelve [{level, segments}] con segments [[x1, y1, x2, y2], ...] en
     * coordenadas locales del DEM.
     * @param {SimRocas.Dem} dem
     * @param {number} interval Intervalo de contorno en metros (> 0).
     */
    function buildContoursFromDem(dem, interval) {
        if (!globalThis.SimRocas.StlContour) {
            throw new Error('PlanView.buildContoursFromDem: SimRocas.StlContour no está disponible (carga js/stl.js)');
        }
        if (!Number.isFinite(interval) || interval <= 0) {
            throw new Error('PlanView.buildContoursFromDem: interval debe ser finito y > 0');
        }
        const heightmap = heightmapFromDem(dem);
        return SimRocas.StlContour.generateContours(heightmap, interval);
    }

    /**
     * Posiciones de escena (x, y, z) por vértice de una lista de contornos,
     * APOTADO sobre el terreno: z = dem.heightAt(x, y) + liftLocal
     * (coordenadas locales, sin exageración; el escalado z lo hace el
     * THREE.Group del viewer). Los puntos que caen sobre nodos NaN se saltan.
     * @param {SimRocas.Dem} dem
     * @param {Array<{level, segments}>} contours Salida de buildContoursFromDem.
     * @param {number} [liftLocal=0] Elevación de la polilínea sobre la superficie.
     * @returns {Float32Array} [x1, y1, z1, x2, y2, z2, ...] por segmento.
     */
    function segmentPositions(dem, contours, liftLocal = 0) {
        if (!dem || typeof dem.heightAt !== 'function') {
            throw new Error('PlanView.segmentPositions: dem inválido');
        }
        const out = [];
        for (const c of contours || []) {
            for (const s of c.segments || []) {
                const x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
                const z1 = dem.heightAt(x1, y1);
                const z2 = dem.heightAt(x2, y2);
                if (!Number.isFinite(z1) || !Number.isFinite(z2)) { continue; }
                out.push(x1, y1, z1 + liftLocal, x2, y2, z2 + liftLocal);
            }
        }
        return new Float32Array(out);
    }

    /**
     * Intervalo 'bonito' automático para un DEM (relieve ignorando NaN).
     * @param {SimRocas.Dem} dem
     * @returns {number}
     */
    function autoInterval(dem) {
        if (!dem || !ArrayBuffer.isView(dem.heights)) {
            throw new Error('PlanView.autoInterval: dem inválido');
        }
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let k = 0; k < dem.heights.length; k++) {
            const z = dem.heights[k];
            if (!Number.isFinite(z)) { continue; }
            if (z < minZ) { minZ = z; }
            if (z > maxZ) { maxZ = z; }
        }
        if (!Number.isFinite(minZ)) { return 1; }
        const relief = maxZ - minZ;
        if (!globalThis.SimRocas.ProfileFromDem) {
            throw new Error('PlanView.autoInterval: ProfileFromDem no está disponible (carga js/view3d-profile.js)');
        }
        return SimRocas.ProfileFromDem.niceInterval(relief);
    }

    SimRocas.PlanView = {
        heightmapFromDem: heightmapFromDem,
        buildContoursFromDem: buildContoursFromDem,
        segmentPositions: segmentPositions,
        autoInterval: autoInterval
    };
})(globalThis.SimRocas);
