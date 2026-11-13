/**
 * SimRocas — perfil paramétrico banco–berma (P1.1, paquete A).
 *
 * Módulo puro: sin acceso a la página, sin azar y sin estado. La misma
 * entrada produce siempre la misma salida y ninguna función modifica sus
 * argumentos.
 *
 * Convención: descenso hacia +X, bancos numerados desde arriba (1…N).
 *   b        = H / tan α                      proyección horizontal de la cara
 *   x0       = startX + topPlatform           X de la primera cresta
 *   cresta_i = (x0 + (i−1)(b + W), z0 + (N−i+1)·H)
 *   pata_i   = (cresta_i.x + b,     cresta_i.y − H)
 * La berma i va de la pata i a la cresta i+1. Bajo la última pata no hay
 * berma sino piso: en ese banco, el ancho informado es el largo del piso.
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    const SCHEMA_VERSION = 'bench-profile.v1';
    const MAX_BENCHES = 50;
    const MIN_FACE_RUN = 1e-6;
    // Largo mínimo de un tramo horizontal no nulo: muy por encima de la
    // tolerancia de X duplicada de Terrain (1e-9).
    const MIN_RUN = 1e-6;
    const MIN_RUN_TEXT = '0,000001 m';
    const DEG = Math.PI / 180;

    function isFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function fail(error) {
        return { ok: false, error };
    }

    /**
     * Valida y normaliza los parámetros (aplica los valores por defecto).
     * @returns {{ok: true, params: object} | {ok: false, error: string}}
     */
    function normalizeParams(params) {
        if (params === null || typeof params !== 'object') {
            return fail('Los parámetros del perfil banco–berma deben ser un objeto.');
        }
        const p = {
            benches: params.benches,
            benchHeight: params.benchHeight,
            faceAngleDeg: params.faceAngleDeg,
            bermWidth: params.bermWidth,
            baseElevation: params.baseElevation,
            topPlatform: params.topPlatform === undefined ? 20 : params.topPlatform,
            floorLength: params.floorLength === undefined ? 30 : params.floorLength,
            startX: params.startX === undefined ? 0 : params.startX
        };
        if (!isFiniteNumber(p.benches) || !Number.isInteger(p.benches) ||
            p.benches < 1 || p.benches > MAX_BENCHES) {
            return fail(`El número de bancos debe ser un entero entre 1 y ${MAX_BENCHES}.`);
        }
        if (!isFiniteNumber(p.benchHeight) || p.benchHeight <= 0) {
            return fail('La altura de banco debe ser un número mayor que 0 m.');
        }
        if (!isFiniteNumber(p.faceAngleDeg) || p.faceAngleDeg <= 0 || p.faceAngleDeg >= 90) {
            return fail('El ángulo de cara debe ser mayor que 0° y menor que 90°.');
        }
        if (!isFiniteNumber(p.bermWidth) || p.bermWidth < 0) {
            return fail('El ancho de berma debe ser un número mayor o igual que 0 m.');
        }
        if (p.bermWidth > 0 && p.bermWidth < MIN_RUN) {
            return fail(`El ancho de berma debe ser 0 o al menos ${MIN_RUN_TEXT}.`);
        }
        if (!isFiniteNumber(p.baseElevation)) {
            return fail('La cota base debe ser un número finito.');
        }
        if (!isFiniteNumber(p.topPlatform) || p.topPlatform < 0) {
            return fail('El largo de la plataforma superior debe ser un número mayor o igual que 0 m.');
        }
        if (p.topPlatform > 0 && p.topPlatform < MIN_RUN) {
            return fail(`El largo de la plataforma superior debe ser 0 o al menos ${MIN_RUN_TEXT}.`);
        }
        if (!isFiniteNumber(p.floorLength) || p.floorLength < 0) {
            return fail('El largo del piso debe ser un número mayor o igual que 0 m.');
        }
        if (p.floorLength > 0 && p.floorLength < MIN_RUN) {
            return fail(`El largo del piso debe ser 0 o al menos ${MIN_RUN_TEXT}.`);
        }
        if (!isFiniteNumber(p.startX)) {
            return fail('La X inicial debe ser un número finito.');
        }
        return { ok: true, params: p };
    }

    /**
     * Genera un perfil banco–berma.
     *
     * Con W = 0, la pata i y la cresta i+1 son el mismo vértice y se emite una
     * sola vez. Con plataforma o piso de largo 0, ese tramo no se emite.
     *
     * @param {{benches: number, benchHeight: number, faceAngleDeg: number,
     *          bermWidth: number, baseElevation: number, topPlatform?: number,
     *          floorLength?: number, startX?: number}} params
     * @returns {{ok: true, points: {x: number, y: number}[], roles: string[],
     *            benchMeta: object[], params: object, schemaVersion: string}
     *          | {ok: false, error: string}}
     */
    function generate(params) {
        const checked = normalizeParams(params);
        if (!checked.ok) return checked;
        const p = checked.params;
        const N = p.benches;
        const H = p.benchHeight;
        const W = p.bermWidth;
        const z0 = p.baseElevation;
        const b = H / Math.tan(p.faceAngleDeg * DEG);
        if (!(b >= MIN_FACE_RUN)) {
            return fail('El ángulo de cara es demasiado cercano a 90° para la altura pedida: ' +
                `la proyección horizontal de la cara debe ser de al menos ${MIN_RUN_TEXT}.`);
        }
        const x0 = p.startX + p.topPlatform;

        const points = [];
        const roles = [];
        const benchMeta = [];
        if (p.topPlatform > 0) {
            points.push({ x: p.startX, y: z0 + N * H });
            roles.push('platform');
        }
        let prevToeX = 0;
        for (let i = 1; i <= N; i++) {
            const shared = W === 0 && i > 1;
            const crestX = shared ? prevToeX : x0 + (i - 1) * (b + W);
            const crestY = z0 + (N - i + 1) * H;
            const toeX = crestX + b;
            const toeY = z0 + (N - i) * H;
            if (!shared) {
                if (i > 1) roles.push('berm');
                points.push({ x: crestX, y: crestY });
            }
            roles.push('face');
            points.push({ x: toeX, y: toeY });
            benchMeta.push({
                index: i,
                crestX,
                crestY,
                toeX,
                toeY,
                height: H,
                faceAngleDeg: p.faceAngleDeg,
                bermStartX: toeX,
                bermEndX: toeX,
                nominalWidth: W,
                effectiveWidth: W
            });
            if (i > 1) benchMeta[i - 2].bermEndX = crestX;
            prevToeX = toeX;
        }
        // Bajo la última pata no hay berma: sigue el piso.
        const lastMeta = benchMeta[N - 1];
        lastMeta.nominalWidth = p.floorLength;
        lastMeta.effectiveWidth = p.floorLength;
        if (p.floorLength > 0) {
            lastMeta.bermEndX = prevToeX + p.floorLength;
            points.push({ x: lastMeta.bermEndX, y: z0 });
            roles.push('floor');
        }

        for (let k = 0; k < points.length; k++) {
            if (!Number.isFinite(points[k].x) || !Number.isFinite(points[k].y)) {
                return fail('Los parámetros producen coordenadas no finitas.');
            }
            if (k > 0 && !(points[k].x > points[k - 1].x)) {
                return fail('Los parámetros no producen un perfil con X estrictamente creciente: ' +
                    'algún tramo es demasiado corto frente a la magnitud de las coordenadas.');
            }
        }
        if (points.length < 2) {
            return fail('Los parámetros no producen un perfil de al menos 2 puntos.');
        }
        return { ok: true, points, roles, benchMeta, params: p, schemaVersion: SCHEMA_VERSION };
    }

    function readThreshold(options, key, label, max) {
        const value = options === undefined || options === null ? undefined : options[key];
        if (value === undefined || value === null) return { ok: true, value: null };
        if (!isFiniteNumber(value) || value < 0 || value >= max) {
            return fail(`El umbral ${label} no es válido.`);
        }
        return { ok: true, value };
    }

    /**
     * Mide los bancos de una polilínea con descenso hacia +X.
     *
     * Cara: cada tramo descendente (un tramo por banco). Con umbrales, los
     * tramos descendentes de pendiente menor o igual que bermSlopeDeg no son
     * cara. Ancho efectivo: largo horizontal de los tramos contiguos desde la
     * pata con |pendiente| ≤ bermSlopeDeg y |y − y_pata| ≤ bermToleranceY.
     * Si falta algún umbral, effectiveWidth y bermEndX valen null.
     * El ancho nominal es un dato de entrada y no se mide: siempre es null.
     *
     * @param {{x: number, y: number}[]} points
     * @param {{bermSlopeDeg?: number, bermToleranceY?: number}} [options]
     * @returns {{ok: true, benchMeta: object[]} | {ok: false, error: string}}
     */
    function measure(points, options) {
        if (!Array.isArray(points)) {
            return fail('La lista de puntos debe ser un arreglo.');
        }
        if (points.length < 2) {
            return fail('Se necesitan al menos 2 puntos para medir un perfil.');
        }
        for (let k = 0; k < points.length; k++) {
            const pt = points[k];
            if (pt === null || typeof pt !== 'object' || !isFiniteNumber(pt.x) || !isFiniteNumber(pt.y)) {
                return fail(`El punto ${k + 1} no tiene coordenadas finitas.`);
            }
            if (k > 0 && !(pt.x > points[k - 1].x)) {
                return fail(`La X del punto ${k + 1} no es estrictamente creciente.`);
            }
        }
        const slope = readThreshold(options, 'bermSlopeDeg', 'de pendiente de berma (bermSlopeDeg)', 90);
        if (!slope.ok) return slope;
        const tolY = readThreshold(options, 'bermToleranceY', 'de cota de berma (bermToleranceY)', Infinity);
        if (!tolY.ok) return tolY;
        const hasThresholds = slope.value !== null && tolY.value !== null;

        const angleDeg = (k) => Math.atan2(Math.abs(points[k + 1].y - points[k].y),
            points[k + 1].x - points[k].x) / DEG;

        const benchMeta = [];
        for (let k = 0; k < points.length - 1; k++) {
            const crest = points[k];
            const toe = points[k + 1];
            if (!(toe.y < crest.y)) continue;
            const faceAngle = angleDeg(k);
            if (hasThresholds && faceAngle <= slope.value) continue;

            let bermEndX = null;
            let effectiveWidth = null;
            if (hasThresholds) {
                bermEndX = toe.x;
                for (let j = k + 1; j < points.length - 1; j++) {
                    if (angleDeg(j) > slope.value) break;
                    if (Math.abs(points[j + 1].y - toe.y) > tolY.value) break;
                    bermEndX = points[j + 1].x;
                }
                effectiveWidth = bermEndX - toe.x;
            }
            benchMeta.push({
                index: benchMeta.length + 1,
                crestX: crest.x,
                crestY: crest.y,
                toeX: toe.x,
                toeY: toe.y,
                height: crest.y - toe.y,
                faceAngleDeg: faceAngle,
                bermStartX: toe.x,
                bermEndX,
                nominalWidth: null,
                effectiveWidth
            });
        }
        return { ok: true, benchMeta };
    }

    SimRocas.BenchProfile = { generate, measure };
})(globalThis.SimRocas);
