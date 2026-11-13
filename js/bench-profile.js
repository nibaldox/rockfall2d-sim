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

    const MEASURE_SCHEMA_VERSION = 'bench-measure.v2';
    // Diferencia mínima de cota entre extremos para decidir el sentido de
    // bajada: el mismo umbral que usa la simulación.
    const DOWNHILL_MIN_DROP = 0.5;

    /**
     * Sentido de bajada por la cota de los extremos: +1 si el extremo derecho
     * está al menos DOWNHILL_MIN_DROP más bajo, −1 si está al menos eso más
     * alto y 0 si no se puede decidir.
     */
    function resolveDownhillSign(points) {
        const drop = points[0].y - points[points.length - 1].y;
        if (drop >= DOWNHILL_MIN_DROP) return 1;
        if (-drop >= DOWNHILL_MIN_DROP) return -1;
        return 0;
    }

    /**
     * Copia de los puntos en el marco de bajada (u = s·x, u creciente).
     * Con s = −1 refleja la X e invierte el orden.
     */
    function toDownhillFrame(points, sign) {
        const frame = [];
        if (sign > 0) {
            for (let k = 0; k < points.length; k++) frame.push({ u: points[k].x, y: points[k].y });
        } else {
            for (let k = points.length - 1; k >= 0; k--) frame.push({ u: -points[k].x, y: points[k].y });
        }
        return frame;
    }

    /**
     * Caras en el marco de bajada: cadenas maximales de tramos consecutivos
     * que bajan con pendiente mayor que slopeDeg. Las cadenas con caída menor
     * que minHeight no son cara.
     * @returns {{crest: number, toe: number}[]} índices de cresta y pata
     */
    function findFaces(frame, slopeDeg, minHeight) {
        const isSteepDescent = (k) => {
            const drop = frame[k].y - frame[k + 1].y;
            if (!(drop > 0)) return false;
            return Math.atan2(drop, frame[k + 1].u - frame[k].u) / DEG > slopeDeg;
        };
        const faces = [];
        let k = 0;
        while (k < frame.length - 1) {
            if (!isSteepDescent(k)) {
                k++;
                continue;
            }
            let end = k + 1;
            while (end < frame.length - 1 && isSteepDescent(end)) end++;
            if (frame[k].y - frame[end].y >= minHeight) faces.push({ crest: k, toe: end });
            k = end;
        }
        return faces;
    }

    /**
     * Índice del último punto de la berma efectiva que nace en la pata:
     * tramos contiguos con |pendiente| ≤ slopeDeg y |y − y_pata| ≤ toleranceY.
     */
    function findBermEnd(frame, toe, slopeDeg, toleranceY) {
        let end = toe;
        for (let j = toe; j < frame.length - 1; j++) {
            const angle = Math.atan2(Math.abs(frame[j + 1].y - frame[j].y),
                frame[j + 1].u - frame[j].u) / DEG;
            if (angle > slopeDeg) break;
            if (Math.abs(frame[j + 1].y - frame[toe].y) > toleranceY) break;
            end = j + 1;
        }
        return end;
    }

    /**
     * Mide los bancos de una polilínea importada o medida (measure v2).
     *
     * Sentido: se decide por la cota de los extremos (umbral 0,5 m). Si el
     * perfil baja hacia −X se refleja la X, se mide y se des-refleja; los
     * bancos se numeran siempre desde arriba.
     * Cara: cadena maximal de tramos con pendiente de bajada mayor que
     * bermSlopeDeg y caída total de al menos minFaceHeight. Cresta = primer
     * punto de la cadena; pata = último; el ángulo es el de la cuerda.
     * Berma efectiva: desde la pata, tramos contiguos con |pendiente| ≤
     * bermSlopeDeg y |y − y_pata| ≤ bermToleranceY. Un escalón absorbido (no
     * es cara) queda dentro del ancho nominal, pero corta la berma efectiva.
     * Ancho nominal: de la pata a la cresta siguiente; null en el último banco.
     *
     * Umbrales ausentes: sin bermSlopeDeg, cualquier tramo descendente es de
     * cara; sin minFaceHeight no se absorbe ninguna cadena; si falta
     * bermSlopeDeg o bermToleranceY, effectiveWidth y bermEndX valen null.
     *
     * @param {{x: number, y: number}[]} points X estrictamente creciente
     * @param {{bermSlopeDeg?: number, bermToleranceY?: number,
     *          minFaceHeight?: number}} [options]
     * @returns {{ok: true, downhillSign: number, benchMeta: object[],
     *            thresholds: object, schemaVersion: string}
     *          | {ok: false, error: string}}
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
        const minFace = readThreshold(options, 'minFaceHeight', 'de altura mínima de cara (minFaceHeight)', Infinity);
        if (!minFace.ok) return minFace;
        const hasBermThresholds = slope.value !== null && tolY.value !== null;

        const sign = resolveDownhillSign(points);
        if (sign === 0) {
            return fail('El sentido de bajada no resuelto: la diferencia de cota entre los extremos ' +
                'del perfil es menor que 0,5 m.');
        }
        const frame = toDownhillFrame(points, sign);
        const faces = findFaces(frame, slope.value === null ? 0 : slope.value,
            minFace.value === null ? 0 : minFace.value);
        if (faces.length === 0) {
            return fail('No se encontró ninguna cara de banco en el perfil con los umbrales indicados.');
        }

        const benchMeta = [];
        for (let i = 0; i < faces.length; i++) {
            const crest = frame[faces[i].crest];
            const toe = frame[faces[i].toe];
            const height = crest.y - toe.y;
            let bermEndX = null;
            let effectiveWidth = null;
            if (hasBermThresholds) {
                const bermEnd = frame[findBermEnd(frame, faces[i].toe, slope.value, tolY.value)];
                bermEndX = sign * bermEnd.u;
                effectiveWidth = bermEnd.u - toe.u;
            }
            benchMeta.push({
                index: i + 1,
                crestX: sign * crest.u,
                crestY: crest.y,
                toeX: sign * toe.u,
                toeY: toe.y,
                height,
                faceAngleDeg: Math.atan2(height, toe.u - crest.u) / DEG,
                bermStartX: sign * toe.u,
                bermEndX,
                nominalWidth: i < faces.length - 1 ? frame[faces[i + 1].crest].u - toe.u : null,
                effectiveWidth
            });
        }
        return {
            ok: true,
            downhillSign: sign,
            benchMeta,
            thresholds: {
                bermSlopeDeg: slope.value,
                bermToleranceY: tolY.value,
                minFaceHeight: minFace.value
            },
            schemaVersion: MEASURE_SCHEMA_VERSION
        };
    }

    SimRocas.BenchProfile = { generate, measure };
})(globalThis.SimRocas);
