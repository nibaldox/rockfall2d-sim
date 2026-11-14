// Límites del contrato P0.2-β: 200 eventos por roca y 100 000 filas por corrida.
const IMPACT_ROW_CAP = 100000;
const IMPACT_ROCK_CAP = 200;
const IMPACT_SURFACES = ['terrain', 'barrier'];
// P0.4 B: con fragmentación también se exportan los eventos de los padres `fragmented`.
const IMPACT_REASONS = ['rest', 'culled', 'maxTime', 'maxSteps', 'fragmented'];
const IMPACT_HEADER = ['Roca', 'Motivo de término', 'Tiempo (s)', 'X centro (m)', 'Y centro (m)', 'Superficie',
    'Tramo o barrera', 'Velocidad normal (m/s)', 'Rapidez (m/s)', 'Rapidez del punto de contacto (m/s)',
    'Energía total (kJ)', 'Coef. normal efectivo', 'Coef. tangencial efectivo', 'Altura de vuelo previa (m)',
    'Roca original', 'Tipo de pieza'];
const IMPACT_TRUNCATED_MESSAGE = 'Se alcanzó el tope de eventos de impacto exportables (200 por roca, 100 000 en total); los máximos y conteos por roca incluyen todos los eventos.';
const REASON_NAMES = { rest: 'reposo', culled: 'salida del dominio', maxTime: 'tiempo máximo', maxSteps: 'pasos máximos', fragmented: 'fragmentación', cancelled: 'cancelación', safetyLimit: 'límite de seguridad' };
const SURFACE_NAMES = { terrain: 'Terreno', barrier: 'Barrera' };
const KIND_NAMES = { primary: 'primaria', core: 'núcleo', major: 'principal', spall: 'esquirla' };
const LINEAGE_MASS_TOLERANCE = 1e-9;
const DISCARDED_FRACTION_WARNING = 0.01;
// Máximos por árbol que hereda la fila envolvente (CONTRATO_P04 §B.1).
const ENVELOPE_MAX_FIELDS = ['maxKineticEnergy', 'maxBounceHeight', 'maxImpactVelocity', 'maxFlightHeight',
    'maxImpactNormalSpeed', 'maxImpactSpeed', 'maxImpactContactSpeed', 'maxImpactEnergy'];
// P0.5 (ítem 27): métricas cuyos valores no finitos se descartan, en su orden de publicación.
const NON_FINITE_NAMES = { finalRunout: 'alcance final', verticalDrop: 'descenso vertical', reachAngle: 'ángulo de alcance',
    finalX: 'X final', kineticEnergy: 'energía cinética máxima', bounceHeight: 'altura de rebote',
    impactVelocity: 'velocidad máxima de trayectoria', bounceCount: 'contactos detectados', flightHeight: 'altura de vuelo',
    impactNormalSpeed: 'velocidad normal de impacto', impactSpeed: 'rapidez de impacto', impactEnergy: 'energía de impacto',
    impactCount: 'impactos por roca', impactEnergies: 'energías de impacto', impactEvents: 'eventos de impacto' };

// Único escapado CSV del módulo: lo comparten generateCSV y generateImpactCSV.
function csvQuote(value) {
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// P1.2: sección condicional «Retención por banco» y CSV de destinos (CONTRATO_P12 §4, §5 y §7).
const BENCH_TITLE = 'RETENCIÓN POR BANCO';
const BENCH_SOURCES = { generado: 'generada', medido: 'medida' };
const BENCH_THRESHOLDS = ['bermSlopeDeg', 'bermToleranceY', 'minFaceHeight'];
const BENCH_CENSORED = ['culled', 'maxTime', 'maxSteps'];
// I10: la columna «Límite» del CSV de destinos usa rótulos en español.
const BOUNDARY_NAMES = { minX: 'izquierdo', maxX: 'derecho', minY: 'inferior' };
const DESTINATIONS_HEADER = ['Roca', 'Raíz', 'Padre', 'Tipo de pieza', 'Fuente', 'X liberación', 'Y liberación',
    'X final', 'Y final', 'Motivo', 'Límite', 'Zona', 'Banco', 'Masa (kg)'];

/**
 * Sanea y valida `runInfo.benchGeometry`: copia campo por campo, sin referencias a la entrada.
 *
 * @param {*} raw - valor recibido en `runInfo.benchGeometry`
 * @returns {{geometry: Object}|{error: string}} copia saneada o el motivo del rechazo
 */
function sanitizeBenchGeometry(raw) {
    try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'no es un objeto' };
        if (!Object.hasOwn(BENCH_SOURCES, raw.source)) return { error: 'origen desconocido' };
        if (typeof raw.schemaVersion !== 'string' || raw.schemaVersion === '') return { error: 'falta la versión del esquema' };
        const s = raw.downhillSign;
        if (s !== 1 && s !== -1) return { error: 'sentido de bajada no resuelto' };
        if (!Array.isArray(raw.benchMeta) || raw.benchMeta.length === 0) return { error: 'no hay bancos' };
        const benchMeta = [];
        for (const item of raw.benchMeta) {
            if (!item || typeof item !== 'object' || !Number.isFinite(item.crestX) || !Number.isFinite(item.toeX)) {
                return { error: 'cresta o pata no finitas' };
            }
            const copy = {};
            for (const [key, value] of Object.entries(item)) {
                if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) copy[key] = value;
            }
            const previous = benchMeta[benchMeta.length - 1];
            if (!(s * copy.crestX < s * copy.toeX) || (previous && !(s * previous.toeX <= s * copy.crestX))) {
                return { error: 'crestas y patas desordenadas en el sentido de bajada' };
            }
            benchMeta.push(copy);
        }
        let thresholds = null;
        if (raw.thresholds !== null && raw.thresholds !== undefined) {
            const t = raw.thresholds;
            if (typeof t !== 'object' || !BENCH_THRESHOLDS.every(key => Number.isFinite(t[key]))) return { error: 'umbrales de medición inválidos' };
            thresholds = Object.fromEntries(BENCH_THRESHOLDS.map(key => [key, t[key]]));
        }
        if (!Number.isFinite(raw.profileMinX) || !Number.isFinite(raw.profileMaxX) || !(raw.profileMinX < raw.profileMaxX)) {
            return { error: 'extremos del perfil inválidos' };
        }
        if (typeof raw.pointsKey !== 'string' || raw.pointsKey === '') return { error: 'falta la clave del perfil' };
        return { geometry: { source: raw.source, schemaVersion: raw.schemaVersion, downhillSign: s, benchMeta, thresholds,
            profileMinX: raw.profileMinX, profileMaxX: raw.profileMaxX, pointsKey: raw.pointsKey } };
    } catch (error) {
        return { error: 'no se pudo leer' };
    }
}

// Filas de 2 elementos de la sección «Retención por banco» (nunca 14 ni 15).
function benchRetentionRows(b) {
    const d = b.denominators || {}, c = b.censored || {}, by = c.byReason || {}, closure = b.closure || {};
    const pct = (n, total) => Number.isFinite(n) && total > 0 ? `${(100 * n / total).toFixed(2)} %` : 'No disponible';
    const meta = b.geometry.benchMeta, s = b.geometry.downhillSign;
    const rows = [[`${BENCH_TITLE} (geometría: ${BENCH_SOURCES[b.source]})`,
        `esquema ${b.schemaVersion}; zona de detención de cada hoja en reposo; primarias por su pieza representante`]];
    const zoneRow = (label, z, note = '') => rows.push([`Retención: ${label}`,
        `primarias ${z.primaries} (${pct(z.primaries, d.released)} de ${d.released} lanzadas; ${pct(z.primaries, d.known)} de ${d.known} con destino conocido); ` +
        `piezas ${z.pieces} (${pct(z.pieces, d.releasedPieces)} de ${d.releasedPieces}; ${pct(z.pieces, d.knownPieces)} de ${d.knownPieces} con destino conocido); ` +
        `masa ${z.mass} kg${note}`]);
    const total = { primaries: 0, pieces: 0 };
    for (const z of b.zones) {
        const i = typeof z.key === 'string' && z.key.startsWith('berm:') ? Number(z.key.slice(5)) : null;
        const noBerm = i !== null && meta[i - 1] && meta[i] && !(s * meta[i - 1].toeX < s * meta[i].crestX);
        zoneRow(z.label, z, noBerm ? '; sin berma' : '');
        total.primaries += z.primaries;
        total.pieces += z.pieces;
    }
    for (let i = 1; i <= meta.length; i++) {
        const parts = b.zones.filter(z => z.key === `face:${i}` || z.key === `berm:${i}`);
        if (!parts.length) continue;
        const sum = key => parts.reduce((acc, z) => acc + z[key], 0);
        zoneRow(`retenida en banco ${i} (${i < meta.length ? 'cara + berma' : 'solo cara'})`,
            { primaries: sum('primaries'), pieces: sum('pieces'), mass: sum('mass') });
    }
    const boundary = c.cullBoundary || {};
    for (const reason of BENCH_CENSORED) {
        const count = by[reason] && typeof by[reason] === 'object' ? `primarias ${by[reason].primaries}; piezas ${by[reason].pieces}; masa ${by[reason].mass} kg` : by[reason];
        rows.push([`Retención: censuradas por ${REASON_NAMES[reason]} (N)`, reason === 'culled' ?
            `${count}; piezas por límite: ${Object.entries(boundary).map(([key, n]) => `${BOUNDARY_NAMES[key] ?? key} ${n && typeof n === 'object' ? n.pieces : n}`).join(', ')}` : count]);
    }
    rows.push(['Retención: censuradas en total (sin zona)', `primarias ${c.primaries}; piezas ${c.pieces}; masa ${c.mass} kg`]);
    rows.push(['Retención: masa descartada sin simular', `${b.discardedMass} kg (sin zona)`]);
    const check = (zones, censored, n, ok) => `${zones} + ${censored} = ${n} (${zones + censored === n && ok !== false ? 'cumple' : 'NO cumple'})`;
    rows.push(['Retención: cierre Σ zonas + censuradas = N',
        `primarias ${check(total.primaries, c.primaries, d.released, closure.primariesOk)}; ` +
        `piezas ${check(total.pieces, c.pieces, d.releasedPieces, closure.piecesOk)}; ` +
        `masa en zonas + censurada + descartada = liberada (${closure.massOk === true ? 'cumple' : 'NO cumple'}; residuo ${closure.massResidual} kg)`]);
    rows.push(['Retención: definición de las zonas', 'se clasifica la X final de cada hoja en reposo, en el sentido de bajada; ' +
        'la cresta pertenece a la cara y la pata a la berma (intervalos semiabiertos); retenida en banco i = cara i + berma i, ' +
        'y en el último banco solo la cara; el piso, la plataforma superior, aguas arriba de la fuente y fuera del perfil van aparte; ' +
        'las censuradas nunca cuentan en una zona']);
    return rows;
}

// P1.3: envolventes por colector y CSV de cruces (CONTRATO_P13 §4); todo condicional a `runInfo.collectors`.
const COLLECTORS_TITLE = 'COLECTORES';
const COLLECTOR_ENVELOPES = { height: 'altura del centro (m)', top: 'altura del tope (m)', speed: 'velocidad (m/s)', energy: 'energía total (kJ)' };
// Mínimo n ≥ 1/(1 − p): por debajo se publica «insuficiente», nunca un número (I-D).
const COLLECTOR_MIN_N = { p95: 20, p99: 100 };
const COLLECTOR_SAMPLES = { 'first-downhill-per-piece': 'primer cruce de bajada de cada pieza',
    'first-any-per-piece': 'primer cruce en cualquier sentido de cada pieza, porque el sentido de bajada no está resuelto' };
const CROSSINGS_HEADER = ['Colector', 'X colector', 'Roca', 'Raíz', 'Tipo de pieza', 'Ordinal', 'Sentido', 'Por corrección',
    't (s)', 'Y (m)', 'Altura centro (m)', 'Altura tope (m)', 'Vx', 'Vy', 'Velocidad (m/s)', 'Omega (rad/s)',
    'E traslación (kJ)', 'E rotación (kJ)', 'E total (kJ)', 'Masa (kg)'];

/**
 * Sanea `runInfo.collectors`: copia `id`, `x` y `label`, y descarta entradas inválidas o con `id` repetido.
 *
 * @param {*} raw - valor recibido en `runInfo.collectors`
 * @returns {Array<{id: string|number, x: number, label: string}>} lista saneada (vacía si no hay ninguno válido)
 */
function sanitizeStatsCollectors(raw) {
    const list = [];
    try {
        if (!Array.isArray(raw)) return list;
        for (let i = 0; i < raw.length; i++) {
            try {
                const item = raw[i];
                if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
                const id = item.id, x = item.x, label = item.label;
                if (!((typeof id === 'string' && id !== '') || Number.isFinite(id)) || !Number.isFinite(x)) continue;
                if (list.some(c => c.id === id)) continue;
                list.push({ id, x, label: typeof label === 'string' && label !== '' ? label : `Colector ${id}` });
            } catch (error) {
                continue;
            }
        }
    } catch (error) {
        return [];
    }
    return list;
}

// Filas de 2 elementos de la sección «COLECTORES» (nunca 14 ni 15).
function collectorRows(collectors) {
    const rows = [[COLLECTORS_TITLE, 'envolventes P50, P95 y P99 en cada línea vertical x = X; una muestra por pieza']];
    for (const c of collectors) {
        const name = `${c.label.startsWith('Colector') ? c.label : `Colector ${c.label}`} (X = ${c.x} m)`;
        const k = c.counts, w = k.censoredWithoutCrossing;
        rows.push([`${name}: muestra`, `${COLLECTOR_SAMPLES[c.sample]}; n = ${c.n}`]);
        for (const [key, label] of Object.entries(COLLECTOR_ENVELOPES)) {
            const e = c.envelopes[key];
            const show = p => e[p] === null ? `insuficiente (n = ${e.n})` : e[p];
            rows.push([`${name}: ${label}`, `P50 = ${show('p50')}; P95 = ${show('p95')}; P99 = ${show('p99')}; n = ${e.n}`]);
        }
        const censored = w.culled + w.maxTime + w.maxSteps;
        rows.push([`${name}: conteos`, `cruces ${k.crossingsTotal}; piezas con cruce ${k.piecesCrossing}; ` +
            `raíces que cruzan ${k.rootsCrossing} de ${k.released} lanzadas${censored ? ' (cota inferior, por las censuradas)' : ''}; ` +
            `en reposo sin cruzar ${k.restBeforeLine}; ` +
            `censuradas sin cruce: ${BENCH_CENSORED.map(reason => `${REASON_NAMES[reason]} ${w[reason]}`).join(', ')}; ` +
            `cruces por corrección de posición ${k.byCorrection}; cruces de subida ${k.upward === null ? 'No disponible' : k.upward}; ` +
            `cruces omitidos por el tope por roca (total de la corrida) ${k.dropped}`]);
        rows.push([`${name}: definición`, c.definition]);
    }
    return rows;
}

class Stats {
    constructor() {
        this.results = null;
    }

    compute(rocks, releasePoint = null, runInfo = null) {
        const entities = Array.isArray(rocks) ? rocks : [];
        const calcMethods = ['rigid-body', 'lumped-mass', 'nonsmooth'];
        let source = null;
        try {
            source = runInfo && typeof runInfo === 'object' && !Array.isArray(runInfo) ? runInfo : null;
        } catch (error) {
            source = null;
        }
        const readField = key => {
            if (!source) return null;
            try {
                return source[key];
            } catch (error) {
                return null;
            }
        };
        const rawTimeStep = readField('timeStep'), rawCalcMethod = readField('calcMethod');
        const rawCn = readField('cnVariability'), rawCt = readField('ctVariability');
        const effective = {
            timeStep: Number.isFinite(rawTimeStep) && rawTimeStep > 0 ? rawTimeStep : null,
            calcMethod: calcMethods.includes(rawCalcMethod) ? rawCalcMethod : null,
            cnVariability: Number.isFinite(rawCn) && rawCn >= 0 ? rawCn : null,
            ctVariability: Number.isFinite(rawCt) && rawCt >= 0 ? rawCt : null,
            segments: this.sanitizeSegments(readField('segments'))
        };
        // Extremos del perfil: todos los tramos con geometría válida (RVBa-3a).
        const profileExtent = this.segmentsExtent(readField('segments'));
        // X3 (P0.5): registro de la corrida; un campo ausente o inválido no se publica.
        const rawSeed = readField('seed'), rawRng = readField('rngAlgorithm');
        const rawEngine = readField('engineVersion'), rawCorrelated = readField('correlatedParams');
        const registry = {};
        if (Number.isInteger(rawSeed) && rawSeed >= 0) registry.seed = rawSeed;
        if (typeof rawRng === 'string' && rawRng !== '') registry.rngAlgorithm = rawRng;
        if (Number.isFinite(rawEngine)) registry.engineVersion = rawEngine;
        if (typeof rawCorrelated === 'boolean') registry.correlatedParams = rawCorrelated;
        // P0.4 B: con fragmentación la población principal son filas envolventes, una por
        // primaria; sin fragmentación se usan las rocas tal cual (I4).
        const fragmented = entities.some(r => r && (r.stopReason === 'fragmented' || r.isCore || r.generation > 0));
        const tree = fragmented ? this.buildLineage(entities) : null;
        const input = tree && tree.valid ? tree.rows : entities;
        const reasons = ['rest', 'culled', 'maxTime', 'maxSteps', 'fragmented', 'cancelled', 'safetyLimit'];
        const byReason = Object.fromEntries(reasons.map(reason => [reason, 0]));
        for (const rock of input) {
            if (rock && Object.hasOwn(byReason, rock.stopReason)) byReason[rock.stopReason]++;
        }
        const censored = byReason.culled + byReason.maxTime + byReason.maxSteps;
        const sources = [...new Set(input.filter(r => r && Number.isInteger(r.sourceIndex) && r.sourceIndex >= 0).map(r => r.sourceIndex))].sort((a, b) => a - b);
        const directionResolved = input.length > 0 && input.every(r => r && (r.downhillSign === 1 || r.downhillSign === -1));
        const population = {
            released: input.length, rest: byReason.rest, censored, byReason,
            pctCensored: input.length ? 100 * censored / input.length : null,
            culledByBoundary: null, pctLeavingDownhill: null, directionResolved, sources
        };
        const warnings = [];
        const warn = (code, message) => warnings.push({ code, message });
        if (censored) warn('censura', 'Hay rocas censuradas; las distribuciones finales son condicionales al reposo y el alcance máximo es una cota.');
        if (!directionResolved && input.length) warn('direccionAmbigua', 'El sentido de descenso no está resuelto para todas las rocas.');
        if (tree && tree.valid) {
            warn('fragmentacion', 'Corrida con fragmentación: estadísticas por roca original (envolvente); ver bloque de piezas finales');
            if (tree.lineage.discardedByTree.some(item => item.fraction > DISCARDED_FRACTION_WARNING)) {
                warn('masaDescartada', 'Algún árbol descartó más del 1 % de la masa original en esquirlas menores de 0.05 m no simuladas.');
            }
        } else if (tree) {
            warn('linajeInvalido', 'El linaje de fragmentos es incoherente o no conserva la masa; no se publican agregados.');
        }
        if (!byReason.rest && input.length) warn('sinReposo', 'No hay rocas en reposo para calcular distribuciones finales.');
        if (sources.length > 1) warn('variasFuentes', 'Hay varias fuentes; las métricas usan el origen efectivo de cada roca.');
        if (effective.timeStep > 0.02 && (effective.calcMethod === 'rigid-body' || effective.calcMethod === 'nonsmooth')) {
            warn('dtGrueso', 'Con dt > 0.02 s en cuerpo rígido o nonsmooth, algunas rocas pueden no alcanzar el reposo; use dt ≤ 0.02 s y revise el porcentaje censurado.');
        }
        const valid = r => r && Number.isFinite(r.releaseX) && Number.isFinite(r.releaseY) &&
            Number.isFinite(r.finalX) && Number.isFinite(r.finalY) &&
            Number.isInteger(r.sourceIndex) && r.sourceIndex >= 0 &&
            (r.downhillSign === null || r.downhillSign === 1 || r.downhillSign === -1) &&
            (r.downhillSign === null ? r.maxDownhillAdvance === null : Number.isFinite(r.maxDownhillAdvance)) &&
            (r.stopReason === 'culled' ? ['minX', 'maxX', 'minY', 'maxY'].includes(r.cullBoundary) : r.cullBoundary === null) &&
            reasons.includes(r.stopReason);
        const unpublishable = r => r && (r.status === 'safetyLimit' || r.stopReason === 'cancelled' || r.stopReason === 'safetyLimit');
        let blockedReason = !input.length ? 'sinRocas' : tree && !tree.valid ? 'linajeInvalido' :
            (byReason.cancelled || byReason.safetyLimit || rocks.status === 'safetyLimit' || entities.some(unpublishable)) ? 'censuraNoPublicable' :
            !(entities.every(valid) && (input === entities || input.every(valid))) ? 'esquemaInvalido' : null;
        const result = {
            contractVersion: 'P0.5', status: blockedReason ? 'bloqueado' : (censored || !directionResolved ? 'parcial' : 'completo'),
            blockedReason, warnings, totalRocks: input.length, population, restRocks: [],
            runInfo: { timeStep: effective.timeStep, calcMethod: effective.calcMethod,
                cnVariability: effective.cnVariability, ctVariability: effective.ctVariability, segments: effective.segments, ...registry },
            derived: { finalRunout: [], verticalDrop: [], reachAngle: [] },
            finalRunout: null, verticalDrop: null, reachAngle: null, reachAngleExcluded: null, finalX: null,
            kineticEnergy: null, bounceHeight: null, impactVelocity: null, bounceCount: null,
            flightHeight: null, impactNormalSpeed: null, impactSpeed: null, impactEnergy: null, impactCount: null,
            impactEvents: [], impactExportAvailable: false,
            reachBounds: null, impactEnergies: []
        };
        this.results = result;
        // P1.2 (I-A): sin `benchGeometry` no se agrega ninguna clave enumerable.
        const rawBench = readField('benchGeometry');
        const bench = rawBench === null || rawBench === undefined ? null : sanitizeBenchGeometry(rawBench);
        if (bench && bench.geometry) result.runInfo.benchGeometry = bench.geometry;
        // P1.3 (I-A, I-F): sin colectores válidos no se agrega nada.
        const collectors = sanitizeStatsCollectors(readField('collectors'));
        if (blockedReason) {
            if (bench) result.benchRetentionUnavailable = bench.geometry ? 'corrida no publicable' : `geometría de bancos inválida (${bench.error})`;
            return result;
        }
        this.attachDestinations(result, entities, input, tree, bench);
        if (tree) {
            result.lineage = tree.lineage;
            if (!directionResolved) result.lineage.finalRunout = null;
        }
        if (directionResolved) {
            const boundaries = { downhill: 0, uphill: 0, below: 0, other: 0 };
            for (const r of input.filter(r => r.stopReason === 'culled')) {
                if (r.cullBoundary === (r.downhillSign === 1 ? 'maxX' : 'minX')) boundaries.downhill++;
                else if (r.cullBoundary === (r.downhillSign === 1 ? 'minX' : 'maxX')) boundaries.uphill++;
                else if (r.cullBoundary === 'minY') boundaries.below++;
                else boundaries.other++;
            }
            population.culledByBoundary = boundaries;
            population.pctLeavingDownhill = 100 * boundaries.downhill / input.length;
        }
        const rest = input.filter(r => r.stopReason === 'rest');
        result.restRocks = rest;
        // Ítem 27: se cuenta cada número no finito descartado; un campo ausente no cuenta.
        const nonFinite = {};
        const tally = (key, value) => {
            if (typeof value === 'number' && !Number.isFinite(value)) nonFinite[key] = (nonFinite[key] || 0) + 1;
            return value;
        };
        const finite = value => Number.isFinite(value) ? value : null;
        const derived = result.derived;
        derived.finalRunout = rest.map(r => directionResolved ? finite(tally('finalRunout', r.downhillSign * (r.finalX - r.releaseX))) : null);
        derived.verticalDrop = rest.map(r => finite(tally('verticalDrop', r.releaseY - r.finalY)));
        derived.reachAngle = rest.map((r, i) => {
            const l = derived.finalRunout[i], h = derived.verticalDrop[i];
            return l !== null && h !== null && l > 0 && h >= 0 ? finite(tally('reachAngle', Math.atan2(h, l) * 180 / Math.PI)) : null;
        });
        const block = (values, key) => {
            if (key) values.forEach(value => tally(key, value));
            return this.statsForArray(values.filter(Number.isFinite));
        };
        result.finalRunout = directionResolved ? block(derived.finalRunout) : null;
        result.verticalDrop = block(derived.verticalDrop);
        result.reachAngle = directionResolved ? block(derived.reachAngle) : null;
        result.reachAngleExcluded = rest.length - derived.reachAngle.filter(Number.isFinite).length;
        if (result.reachAngle) result.reachAngle.excluded = result.reachAngleExcluded;
        result.finalX = block(rest.map(r => r.finalX), 'finalX');
        result.kineticEnergy = block(rest.map(r => Number.isFinite(tally('kineticEnergy', r.maxKineticEnergy)) ? r.maxKineticEnergy / 1000 : null));
        result.bounceHeight = block(rest.map(r => r.maxBounceHeight), 'bounceHeight');
        result.impactVelocity = block(rest.map(r => r.maxImpactVelocity), 'impactVelocity');
        result.bounceCount = block(rest.map(r => r.bounces), 'bounceCount');
        result.flightHeight = block(rest.map(r => r.maxFlightHeight), 'flightHeight');
        result.impactNormalSpeed = block(rest.map(r => r.maxImpactNormalSpeed), 'impactNormalSpeed');
        result.impactSpeed = block(rest.map(r => r.maxImpactSpeed), 'impactSpeed');
        result.impactEnergy = block(rest.map(r => Number.isFinite(tally('impactEnergy', r.maxImpactEnergy)) ? r.maxImpactEnergy / 1000 : null));
        result.impactCount = block(rest.map(r => r.impactCount), 'impactCount');
        result.impactEnergies = rest.flatMap(r => Array.isArray(r.impactEnergies) ? r.impactEnergies.filter(value => Number.isFinite(tally('impactEnergies', value))) : []);
        if (directionResolved) {
            const observed = input.map(r => r.maxDownhillAdvance).sort((a, b) => a - b);
            const exactValues = rest.map(r => r.maxDownhillAdvance).sort((a, b) => a - b);
            const bounds = { n: input.length, censored };
            for (const p of [10, 50, 83, 95]) {
                const lower = this.percentile(observed, p);
                const idx = p / 100 * (input.length - 1);
                const lo = Math.floor(idx), hi = Math.ceil(idx), frac = idx - lo;
                const upper = lo >= exactValues.length || (frac > 0 && hi >= exactValues.length) ? null :
                    exactValues[lo] * (1 - frac) + (frac > 0 ? exactValues[hi] * frac : 0);
                bounds[`p${p}`] = { lower, upper, exact: upper !== null && upper === lower };
            }
            bounds.max = { lower: observed[observed.length - 1], exact: censored === 0 };
            result.reachBounds = bounds;
        }
        const events = [];
        let truncatedRocks = 0, capped = false;
        entities.forEach((r, position) => {
            if (!r || !IMPACT_REASONS.includes(r.stopReason)) return;
            let list = [];
            try {
                list = Array.isArray(r.impactEvents) ? r.impactEvents : [];
            } catch (error) {
                list = [];
            }
            const count = Number.isInteger(r.impactCount) && r.impactCount >= 0 ? r.impactCount : list.length;
            const omitted = Number.isInteger(r.droppedImpactEvents) && r.droppedImpactEvents >= 0 ?
                r.droppedImpactEvents : Math.max(0, count - list.length);
            if (omitted > 0) truncatedRocks++;
            const rockId = Number.isInteger(r.id) && r.id >= 0 ? r.id : position;
            for (let i = 0; i < list.length; i++) {
                if (events.length >= IMPACT_ROW_CAP) { capped = true; break; }
                const item = list[i];
                if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
                const finite = value => Number.isFinite(tally('impactEvents', value)) ? value : null;
                const entry = {
                    rockId, stopReason: r.stopReason,
                    t: finite(item.t), x: finite(item.x), y: finite(item.y),
                    surface: IMPACT_SURFACES.includes(item.surface) ? item.surface : null,
                    index: Number.isInteger(item.index) && item.index >= 0 ? item.index : null,
                    vn: finite(item.vn), speed: finite(item.speed), contactSpeed: finite(item.contactSpeed),
                    energy: finite(item.energy), cnEff: finite(item.cnEff), ctEff: finite(item.ctEff),
                    flightHeightBefore: finite(item.flightHeightBefore),
                    // X2: campos enumerables normales, al final de cada evento.
                    rootId: Number.isInteger(r.rootId) && r.rootId >= 0 ? r.rootId : rockId,
                    fragmentKind: Object.hasOwn(KIND_NAMES, r.fragmentKind) ? r.fragmentKind : (fragmented ? null : 'primary')
                };
                events.push(entry);
            }
        });
        result.impactEvents = events;
        result.impactExportAvailable = true;
        if (truncatedRocks > 0 || capped) warn('impactosTruncados', IMPACT_TRUNCATED_MESSAGE);
        // E2.2: impactos de terreno más allá de los extremos del perfil de la corrida.
        if (profileExtent) {
            const minX = profileExtent.minX, maxX = profileExtent.maxX;
            const outside = entities.some(r =>
                Array.isArray(r.impactEvents) && r.impactEvents.some(e => e && e.surface === 'terrain' &&
                    Number.isFinite(e.x) && (e.x < minX || e.x > maxX)));
            if (outside) {
                warn('fueraDelPerfil', effective.calcMethod === 'lumped-mass' ?
                    'Hay impactos sobre la prolongación horizontal del perfil, más allá de sus extremos; en masa concentrada se usan Kn/Kt globales.' :
                    'Hay impactos sobre la prolongación horizontal del perfil, más allá de sus extremos; se usa el material del tramo extremo.');
            }
        }
        // Ítem 27: si no se descartó ningún valor no finito, el resultado no cambia.
        const counts = {};
        for (const key of Object.keys(NON_FINITE_NAMES)) if (nonFinite[key]) counts[key] = nonFinite[key];
        if (Object.keys(counts).length) {
            warnings.push({ code: 'metricasNoFinitas', counts,
                message: `Se descartaron valores no finitos de las métricas (${Object.entries(counts).map(([key, count]) => `${NON_FINITE_NAMES[key]}: ${count}`).join('; ')}); revise la corrida.` });
        }
        if (collectors.length) this.attachCollectors(result, entities, input, tree, collectors);
        return result;
    }

    /**
     * P1.3: `results.collectors` (envolventes y conteos por colector) y las filas del CSV de cruces
     * (propiedad no enumerable). La muestra es el primer cruce de bajada de cada pieza, incluidos
     * los padres fragmentados; si algún sentido no está resuelto, el primero en cualquier sentido.
     *
     * @param {Object} result - resultado publicable en construcción
     * @param {Array} entities - todas las entidades de la corrida, con `crossings` según CONTRATO_P13 §3
     * @param {Array} input - población principal (filas envolventes o rocas)
     * @param {Object|null} tree - linaje validado, si hubo fragmentación
     * @param {Array} collectors - salida no vacía de `sanitizeStatsCollectors`
     */
    attachCollectors(result, entities, input, tree, collectors) {
        const resolved = entities.every(r => r.downhillSign === 1 || r.downhillSign === -1);
        const sample = resolved ? 'first-downhill-per-piece' : 'first-any-per-piece';
        const crossingsOf = r => {
            try {
                return Array.isArray(r.crossings) ? r.crossings.filter(k => k && typeof k === 'object' && !Array.isArray(k)) : [];
            } catch (error) {
                return [];
            }
        };
        const lists = entities.map(crossingsOf);
        // Clave de raíz: con linaje, el `id` de la primaria; sin linaje, la posición de la roca.
        const rootKey = (r, position) => tree ? r.rootId : position;
        const dropped = entities.reduce((sum, r) => sum + (Number.isInteger(r.crossingsDropped) && r.crossingsDropped > 0 ? r.crossingsDropped : 0), 0);
        const envelope = values => {
            const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
            const insufficient = { p95: n < COLLECTOR_MIN_N.p95, p99: n < COLLECTOR_MIN_N.p99 };
            return { p50: this.percentile(sorted, 50), p95: insufficient.p95 ? null : this.percentile(sorted, 95),
                p99: insufficient.p99 ? null : this.percentile(sorted, 99), n, insufficient };
        };
        const definition = 'Percentil tipo 7 de Hyndman–Fan (interpolación lineal en el índice p·(n − 1)) sobre el ' +
            `${COLLECTOR_SAMPLES[sample]}; P95 exige n ≥ ${COLLECTOR_MIN_N.p95} y P99 exige n ≥ ${COLLECTOR_MIN_N.p99}; ` +
            'la altura del centro es Y del centro menos el terreno en la línea y la del tope le suma el radio; ' +
            'la energía es traslación más rotación; los conteos de raíces son sobre las rocas lanzadas';
        result.collectors = collectors.map(c => {
            const picked = [], roots = new Set();
            const counts = { crossingsTotal: 0, piecesCrossing: 0, rootsCrossing: 0, released: input.length, restBeforeLine: 0,
                censoredWithoutCrossing: { culled: 0, maxTime: 0, maxSteps: 0 }, byCorrection: 0, upward: resolved ? 0 : null, dropped };
            entities.forEach((r, position) => {
                const own = lists[position].filter(k => k.collector === c.id);
                if (!own.length) return;
                counts.crossingsTotal += own.length;
                counts.piecesCrossing++;
                counts.byCorrection += own.filter(k => k.byCorrection === true).length;
                if (resolved) counts.upward += own.filter(k => k.direction === -r.downhillSign).length;
                const first = resolved ? own.find(k => k.direction === r.downhillSign) : own[0];
                if (!first) return;
                picked.push(first);
                roots.add(rootKey(r, position));
            });
            counts.rootsCrossing = roots.size;
            input.forEach((r, position) => {
                if (roots.has(tree ? r.id : position)) return;
                if (r.stopReason === 'rest') counts.restBeforeLine++;
                else if (Object.hasOwn(counts.censoredWithoutCrossing, r.stopReason)) counts.censoredWithoutCrossing[r.stopReason]++;
            });
            return { id: c.id, label: c.label, x: c.x, sample, n: picked.length,
                envelopes: { height: envelope(picked.map(k => k.height)), top: envelope(picked.map(k => k.top)),
                    speed: envelope(picked.map(k => k.speed)), energy: envelope(picked.map(k => Number.isFinite(k.energy) ? k.energy / 1000 : null)) },
                counts, definition };
        });
        const kJ = value => Number.isFinite(value) ? value / 1000 : null;
        const rows = [];
        entities.forEach((r, position) => {
            const rockId = Number.isInteger(r.id) && r.id >= 0 ? r.id : position;
            const kind = Object.hasOwn(KIND_NAMES, r.fragmentKind) ? r.fragmentKind : (tree ? null : 'primary');
            const s = r.downhillSign === 1 || r.downhillSign === -1 ? r.downhillSign : null;
            for (const k of lists[position]) {
                const c = collectors.find(item => item.id === k.collector);
                if (!c) continue;
                const direction = k.direction === 1 || k.direction === -1 ? k.direction : null;
                rows.push([c.id, c.x, rockId, Number.isInteger(r.rootId) && r.rootId >= 0 ? r.rootId : rockId, KIND_NAMES[kind] ?? null,
                    k.ordinal, direction === null ? null : s === null ? (direction === 1 ? '+X' : '-X') : (direction === s ? 'bajada' : 'subida'),
                    k.byCorrection === true ? 'Sí' : 'No', k.t, k.y, k.height, k.top, k.vx, k.vy, k.speed, k.omega,
                    kJ(k.energyTrans), kJ(k.energyRot), kJ(k.energy), k.mass]);
            }
        });
        // No enumerable: no altera las claves ni el JSON de `results`.
        Object.defineProperty(result, 'crossingRows', { value: rows, enumerable: false, writable: true, configurable: true });
    }

    /**
     * P1.2: destinos por hoja (propiedad no enumerable) y, con geometría válida, `benchRetention`.
     *
     * @param {Object} result - resultado publicable en construcción
     * @param {Array} entities - todas las entidades de la corrida
     * @param {Array} input - población principal (filas envolventes o rocas)
     * @param {Object|null} tree - linaje validado, si hubo fragmentación
     * @param {Object|null} bench - salida de `sanitizeBenchGeometry`, o null sin geometría
     */
    attachDestinations(result, entities, input, tree, bench) {
        const number = value => Number.isFinite(value) ? value : null;
        const rootOf = r => Number.isInteger(r.rootId) && r.rootId >= 0 ? r.rootId : r.id;
        const leaves = entities.filter(r => r.stopReason !== 'fragmented');
        let summary = null, unavailable = null;
        if (bench && !bench.geometry) {
            unavailable = `geometría de bancos inválida (${bench.error})`;
        } else if (bench) {
            const classifier = typeof SimRocas !== 'undefined' && SimRocas ? SimRocas.BenchRetention : null;
            if (!classifier || typeof classifier.summarize !== 'function') {
                unavailable = 'el clasificador de retención no está cargado';
            } else {
                try {
                    summary = classifier.summarize({
                        primaries: input.map(r => ({ id: r.id, finalX: r.finalX, stopReason: r.stopReason, cullBoundary: r.cullBoundary, releaseX: r.releaseX })),
                        leaves: leaves.map(r => ({ id: r.id, rootId: rootOf(r), finalX: r.finalX, stopReason: r.stopReason,
                            cullBoundary: r.cullBoundary, releaseX: r.releaseX, mass: number(r.mass) })),
                        discardedMass: tree ? tree.lineage.mass.discarded : 0,
                        releasedMass: tree ? tree.lineage.mass.original : leaves.reduce((sum, r) => sum + (Number.isFinite(r.mass) ? r.mass : 0), 0),
                        geometry: bench.geometry
                    });
                } catch (error) {
                    summary = null;
                }
                if (!summary || summary.ok !== true || !Array.isArray(summary.zones)) {
                    unavailable = summary && typeof summary.reason === 'string' && summary.reason !== '' ? summary.reason : 'el clasificador de retención falló';
                    summary = null;
                }
            }
        }
        if (unavailable) result.benchRetentionUnavailable = unavailable;
        const perLeaf = summary ? summary.perLeaf : null;
        const zoneOf = id => !perLeaf ? null : (perLeaf instanceof Map || typeof perLeaf.get === 'function' ? perLeaf.get(id) : perLeaf[id]) || null;
        const labels = summary ? Object.fromEntries(summary.zones.map(z => [z.key, z.label])) : {};
        if (summary) {
            result.benchRetention = { schemaVersion: 'bench-retention.v1', source: bench.geometry.source, geometry: bench.geometry,
                zones: summary.zones.map(z => ({ key: z.key, label: z.label, bench: z.bench ?? null, primaries: z.primaries, pieces: z.pieces, mass: z.mass })),
                censored: summary.censored, denominators: summary.denominators, discardedMass: summary.discardedMass, closure: summary.closure };
        }
        const fragmented = tree !== null;
        const destinations = leaves.map(r => {
            const zone = zoneOf(r.id);
            return { id: r.id, rootId: rootOf(r), parentId: Number.isInteger(r.parentId) ? r.parentId : null,
                fragmentKind: Object.hasOwn(KIND_NAMES, r.fragmentKind) ? r.fragmentKind : (fragmented ? null : 'primary'),
                sourceIndex: r.sourceIndex, releaseX: r.releaseX, releaseY: r.releaseY, finalX: r.finalX, finalY: r.finalY,
                stopReason: r.stopReason, cullBoundary: r.cullBoundary,
                zone: zone ? zone.zone : null, zoneLabel: zone ? (labels[zone.zone] ?? zone.zone) : null,
                bench: zone ? (zone.bench ?? null) : null, mass: number(r.mass) };
        });
        // No enumerable: no altera las claves ni el JSON de `results` (I-A).
        Object.defineProperty(result, 'destinations', { value: destinations, enumerable: false, writable: true, configurable: true });
    }

    /**
     * Arma y valida los árboles de linaje (CONTRATO_P04 §B.1–B.3).
     *
     * @param {Array} entities - todas las entidades de la corrida (primarias y descendientes)
     * @returns {{valid: boolean, rows: Array, lineage: Object|null}} filas envolventes, una por
     *     primaria en su orden de entrada, y la población secundaria de piezas finales
     */
    buildLineage(entities) {
        const invalid = { valid: false, rows: [], lineage: null };
        const byId = new Map(), childCount = new Map(), groups = new Map();
        for (const r of entities) {
            if (!r || !Number.isInteger(r.id) || byId.has(r.id)) return invalid;
            byId.set(r.id, r);
        }
        for (const r of entities) {
            const root = byId.get(r.rootId);
            if (!root || root.rootId !== root.id || root.parentId !== null) return invalid;
            if (r !== root) {
                const parent = byId.get(r.parentId);
                if (!parent || parent === r || parent.rootId !== r.rootId || parent.stopReason !== 'fragmented') return invalid;
                childCount.set(parent.id, (childCount.get(parent.id) || 0) + 1);
            }
            if (!groups.has(root.id)) groups.set(root.id, []);
            groups.get(root.id).push(r);
        }
        const rows = [];
        const lineage = { primaries: 0, entities: entities.length, leaves: 0, maxGeneration: 0, byKind: {}, byReason: {},
            mass: { original: 0, rest: 0, culled: 0, censored: 0, discarded: 0, maxRelativeError: 0 },
            finalRunout: null, discardedByTree: [] };
        const runouts = [];
        for (const root of entities) {
            if (root.id !== root.rootId) continue;
            const list = groups.get(root.id);
            // Sin ciclos: subiendo por `parentId` toda entidad llega a la raíz.
            for (const r of list) {
                let node = r, hops = 0;
                while (node !== root && hops++ <= list.length) node = byId.get(node.parentId);
                if (node !== root) return invalid;
            }
            if (list.some(r => r.stopReason === 'fragmented' && !childCount.get(r.id))) return invalid;
            const leaves = list.filter(r => r.stopReason !== 'fragmented');
            if (!leaves.length || !Number.isFinite(root.mass) || !(root.mass > 0) ||
                leaves.some(r => !Number.isFinite(r.mass) || r.mass < 0) ||
                list.some(r => !Number.isFinite(r.discardedMass) || r.discardedMass < 0)) return invalid;
            const discarded = list.reduce((sum, r) => sum + r.discardedMass, 0);
            const leafMass = leaves.reduce((sum, r) => sum + r.mass, 0);
            const relativeError = Math.abs(leafMass + discarded - root.mass) / root.mass;
            if (!(relativeError <= LINEAGE_MASS_TOLERANCE)) return invalid;
            const advance = r => Number.isFinite(r.maxDownhillAdvance) ? r.maxDownhillAdvance : -Infinity;
            let representative = leaves[0];
            for (const leaf of leaves) {
                const delta = advance(leaf) - advance(representative);
                if (delta > 0 || (!(delta < 0) && leaf.id < representative.id)) representative = leaf;
            }
            // Censura conservadora: una hoja en tiempo o pasos máximos convierte la cota en «≥».
            const late = leaves.filter(r => r.stopReason === 'maxTime' || r.stopReason === 'maxSteps')
                .reduce((first, r) => first === null || r.id < first.id ? r : first, null);
            const stopReason = representative.stopReason === 'rest' && late ? late.stopReason : representative.stopReason;
            const max = key => list.reduce((best, r) => Number.isFinite(r[key]) && (best === null || r[key] > best) ? r[key] : best, null);
            const sum = key => list.reduce((total, r) => total + (Number.isFinite(r[key]) ? r[key] : 0), 0);
            const row = { ...root, finalX: representative.finalX, finalY: representative.finalY, stopReason,
                cullBoundary: representative.cullBoundary, isResting: stopReason === 'rest',
                maxDownhillAdvance: max('maxDownhillAdvance'), bounces: sum('bounces'), impactCount: sum('impactCount'),
                droppedImpactEvents: sum('droppedImpactEvents'),
                impactEnergies: list.flatMap(r => Array.isArray(r.impactEnergies) ? r.impactEnergies : []),
                representativeId: representative.id, representativeMass: representative.mass,
                treeSize: list.length, leafCount: leaves.length };
            for (const key of ENVELOPE_MAX_FIELDS) {
                const value = max(key);
                if (value !== null) row[key] = value;
            }
            rows.push(row);
            lineage.primaries++;
            lineage.leaves += leaves.length;
            lineage.mass.original += root.mass;
            lineage.mass.discarded += discarded;
            lineage.mass.maxRelativeError = Math.max(lineage.mass.maxRelativeError, relativeError);
            lineage.discardedByTree.push({ rootId: root.id, discarded, fraction: discarded / root.mass });
            for (const r of list) {
                if (Number.isFinite(r.generation) && r.generation > lineage.maxGeneration) lineage.maxGeneration = r.generation;
            }
            for (const leaf of leaves) {
                lineage.byKind[leaf.fragmentKind] = (lineage.byKind[leaf.fragmentKind] || 0) + 1;
                lineage.byReason[leaf.stopReason] = (lineage.byReason[leaf.stopReason] || 0) + 1;
                if (leaf.stopReason === 'rest') {
                    lineage.mass.rest += leaf.mass;
                    const runout = leaf.downhillSign * (leaf.finalX - leaf.releaseX);
                    if ((leaf.downhillSign === 1 || leaf.downhillSign === -1) && Number.isFinite(runout)) runouts.push([runout, leaf.mass]);
                } else if (leaf.stopReason === 'culled') {
                    lineage.mass.culled += leaf.mass;
                } else {
                    lineage.mass.censored += leaf.mass;
                }
            }
        }
        if (rows.length !== groups.size) return invalid;
        if (runouts.length) {
            runouts.sort((a, b) => a[0] - b[0]);
            const block = { n: runouts.length, massTotal: runouts.reduce((total, pair) => total + pair[1], 0) };
            for (const p of [10, 50, 83, 95]) block[`p${p}`] = this.weightedPercentile(runouts, p);
            block.max = runouts[runouts.length - 1][0];
            lineage.finalRunout = block;
        }
        return { valid: true, rows, lineage };
    }

    /**
     * Percentil ponderado: el menor x tal que el peso acumulado hasta x es ≥ p·W.
     *
     * @param {Array<[number, number]>} pairs - pares [valor, peso] ordenados por valor
     * @param {number} p - percentil en 0–100
     * @returns {number|null}
     */
    weightedPercentile(pairs, p) {
        if (!pairs.length) return null;
        const target = p / 100 * pairs.reduce((total, pair) => total + pair[1], 0);
        let accumulated = 0;
        for (const [value, weight] of pairs) {
            accumulated += weight;
            if (accumulated >= target) return value;
        }
        return pairs[pairs.length - 1][0];
    }

    // Filas de linaje del CSV general y del reporte: siempre de 2 elementos (nunca 14 ni 15).
    lineageRows(lineage) {
        const rows = [['Piezas finales', 'hojas no fragmentadas de todos los árboles; alcance ponderado por masa'],
            ['Piezas finales: rocas originales (N)', lineage.primaries], ['Piezas finales: entidades simuladas (N)', lineage.entities],
            ['Piezas finales: piezas (N)', lineage.leaves], ['Piezas finales: generación máxima', lineage.maxGeneration]];
        for (const [kind, count] of Object.entries(lineage.byKind)) rows.push([`Piezas finales de tipo ${KIND_NAMES[kind] ?? kind} (N)`, count]);
        for (const [reason, count] of Object.entries(lineage.byReason)) rows.push([`Piezas finales con motivo ${REASON_NAMES[reason] ?? reason} (N)`, count]);
        const m = lineage.mass;
        rows.push(['Piezas finales: masa original (kg)', m.original], ['Piezas finales: masa en reposo (kg)', m.rest],
            ['Piezas finales: masa que sale del dominio (kg)', m.culled], ['Piezas finales: masa censurada por tiempo o pasos (kg)', m.censored],
            ['Piezas finales: masa descartada sin simular (kg)', m.discarded],
            ['Piezas finales: error relativo máximo de conservación de masa por árbol', m.maxRelativeError],
            ['Piezas finales: árboles con más del 1 % de masa descartada (N)',
                lineage.discardedByTree.filter(item => item.fraction > DISCARDED_FRACTION_WARNING).length]);
        const f = lineage.finalRunout;
        rows.push(['Piezas finales: alcance final en reposo (N)', f ? f.n : null], ['Piezas finales: masa en reposo con alcance (kg)', f ? f.massTotal : null]);
        for (const key of ['p10', 'p50', 'p83', 'p95', 'max']) {
            rows.push([`Piezas finales: alcance final ponderado por masa ${key.toUpperCase()} (m)`, f ? f[key] : null]);
        }
        rows.push(['Piezas finales: tiempo de los impactos', 't medido desde la liberación de la roca original']);
        return rows;
    }

    sanitizeSegments(raw) {
        let length = 0;
        try {
            if (!Array.isArray(raw)) return null;
            length = raw.length;
        } catch (error) {
            return null;
        }
        const segments = [];
        for (let i = 0; i < length; i++) {
            let entry = null;
            try {
                entry = raw[i];
            } catch (error) {
                entry = null;
            }
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const take = key => {
                try {
                    return entry[key];
                } catch (error) {
                    return undefined;
                }
            };
            const index = take('index'), x0 = take('x0'), x1 = take('x1'), cn = take('cn'), ct = take('ct'),
                roughness = take('roughness'), type = take('type'), label = take('label');
            if (!Number.isInteger(index) || index < 0) continue;
            if (![x0, x1, cn, ct, roughness].every(Number.isFinite)) continue;
            // RVBa-3a: un tramo sin `type` se conserva, con la etiqueta «sin tipo».
            const hasType = typeof type === 'string' && type !== '';
            segments.push({ index, x0, x1, type: hasType ? type : null,
                label: typeof label === 'string' && label ? label : (hasType ? type : 'sin tipo'), cn, ct, roughness });
        }
        return segments;
    }

    /**
     * Extremos del perfil de la corrida: x0 del primer tramo y x1 del último
     * entre los que tienen geometría válida, aunque su material no lo sea.
     *
     * @param {*} raw - `runInfo.segments` sin sanear
     * @returns {{minX: number, maxX: number}|null}
     */
    segmentsExtent(raw) {
        let length = 0;
        try {
            if (!Array.isArray(raw)) return null;
            length = raw.length;
        } catch (error) {
            return null;
        }
        let minX = null, maxX = null;
        for (let i = 0; i < length; i++) {
            let x0, x1;
            try {
                const entry = raw[i];
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
                if (!Number.isInteger(entry.index) || entry.index < 0) continue;
                x0 = entry.x0;
                x1 = entry.x1;
            } catch (error) {
                continue;
            }
            if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
            if (minX === null) minX = x0;
            maxX = x1;
        }
        return minX === null ? null : { minX, maxX };
    }

    statsForArray(values) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mean = sorted.reduce((sum, value) => sum + value / sorted.length, 0);
        const scale = sorted.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        const std = scale === 0 ? 0 : scale * Math.sqrt(sorted.reduce((sum, value) => sum + (value / scale - mean / scale) ** 2 / sorted.length, 0));
        const block = { n: sorted.length, min: sorted[0], max: sorted[sorted.length - 1], mean: Number.isFinite(mean) ? mean : null,
            std: Number.isFinite(std) ? std : null };
        for (const p of [10, 50, 83, 95]) block[`p${p}`] = this.percentile(sorted, p);
        return block;
    }

    percentile(sorted, p) {
        if (!sorted.length) return null;
        const index = p / 100 * (sorted.length - 1), lo = Math.floor(index), fraction = index - lo;
        return sorted[lo] * (1 - fraction) + (fraction ? sorted[lo + 1] * fraction : 0);
    }

    computePercentileRunout(distances, p) {
        return this.percentile([...distances].sort((a, b) => a - b), p);
    }

    updateUI() {
        const r = this.results;
        if (!r) return;
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        const number = value => Number.isFinite(value) ? value.toFixed(1) : '—';
        const count = value => Number.isFinite(value) ? String(Math.round(value)) : '—';
        set('stat-max-ke', number(r.kineticEnergy?.max));
        set('stat-mean-ke', number(r.kineticEnergy?.mean));
        set('stat-max-bounce', number(r.flightHeight?.max));
        set('stat-max-impact-vn', number(r.impactNormalSpeed?.max));
        set('stat-max-impact-energy', number(r.impactEnergy?.max));
        set('stat-max-impacts', count(r.impactCount?.max));
        set('stat-max-runout', number(r.finalRunout?.max));
        set('stat-max-velocity', number(r.impactVelocity?.max));
        set('stat-max-bounces', number(r.bounceCount?.max));
        set('stat-savigny-angle', number(r.reachAngle?.min));
        set('stat-n-rest', `${r.population.rest} / ${r.population.released}`);
        set('stat-pct-leaving', number(r.population.pctLeavingDownhill));
        const bound = r.reachBounds?.p95;
        set('stat-reach-p95', bound ? `${bound.exact ? '' : '≥ '}${number(bound.lower)}` : '—');
        set('stats-warnings', r.warnings.map(w => w.message).join(' '));
    }

    exportRows() {
        const r = this.results, p = r.population;
        const rows = [['Estado', r.status], ['Motivo de bloqueo', r.blockedReason], ['Rocas evaluadas (N)', p.released],
            ['Rocas en reposo (N)', p.rest], ['Rocas censuradas (N)', p.censored], ['Censuradas (%)', p.pctCensored],
            ['Salen del perfil aguas abajo (%)', p.pctLeavingDownhill]];
        const reasonNames = { rest: 'reposo', culled: 'salida del dominio', maxTime: 'tiempo máximo', maxSteps: 'pasos máximos', fragmented: 'fragmentación', cancelled: 'cancelación', safetyLimit: 'límite de seguridad' };
        for (const [reason, count] of Object.entries(p.byReason)) rows.push([`Motivo ${reasonNames[reason]} (N)`, count]);
        for (const [key, label] of Object.entries({ downhill: 'aguas abajo', uphill: 'aguas arriba', below: 'por debajo', other: 'otro límite' })) {
            rows.push([`Salidas ${label} (N)`, p.culledByBoundary?.[key]]);
        }
        const names = { finalRunout: 'Alcance final relativo (m)', verticalDrop: 'Descenso vertical (m)', reachAngle: 'Ángulo de alcance (°)',
            finalX: 'X final (m)', kineticEnergy: 'Energía cinética máxima por roca (kJ)',
            flightHeight: 'Altura de vuelo del centro, máx. por roca (m)',
            impactNormalSpeed: 'Velocidad normal de impacto, máx. por roca (m/s)',
            impactSpeed: 'Rapidez de impacto, máx. por roca (m/s)',
            impactEnergy: 'Energía de impacto (traslación + rotación), máx. por roca (kJ)',
            impactCount: 'Impactos por roca (vn ≥ 0.5 m/s)',
            impactVelocity: 'Velocidad máxima de trayectoria (m/s)', bounceCount: 'Contactos detectados (conteo interno, no equivale a impactos)' };
        for (const [key, label] of Object.entries(names)) {
            const b = r[key];
            rows.push([label, null, b?.n, b?.min, b?.mean, b?.max, b?.std, b?.p10, b?.p50, b?.p83, b?.p95, null, null, null, key === 'reachAngle' ? r.reachAngleExcluded : null]);
        }
        for (const key of ['p10', 'p50', 'p83', 'p95', 'max']) {
            const b = r.reachBounds?.[key];
            rows.push([`Alcance máximo ${key.toUpperCase()} (m)`, b ? `${b.exact ? '' : '≥ '}${b.lower}` : null,
                r.reachBounds?.n, null, null, null, null, null, null, null, null, b?.lower, b?.upper, b?.exact]);
        }
        for (const w of r.warnings) rows.push([`Advertencia ${w.code}`, w.message]);
        const methodName = { 'rigid-body': 'Cuerpo rígido', 'lumped-mass': 'Lumped Mass (2DLM)', 'nonsmooth': 'Nonsmooth Dynamics (NSD)' };
        if (r.runInfo?.timeStep !== null && r.runInfo?.timeStep !== undefined) rows.push(['Paso de tiempo efectivo (s)', r.runInfo.timeStep]);
        if (r.runInfo?.calcMethod !== null && r.runInfo?.calcMethod !== undefined) rows.push(['Método de cálculo', methodName[r.runInfo.calcMethod]]);
        rows.push(['Versión del contrato de resultados', r.contractVersion]);
        // X3 (P0.5): cuatro filas fijas de 2 elementos; un campo ausente va vacío.
        const info = r.runInfo || {};
        rows.push(['Semilla', info.seed ?? ''], ['Generador pseudoaleatorio', info.rngAlgorithm ?? ''],
            ['Versión del motor', info.engineVersion ?? ''],
            ['Parámetros correlacionados', info.correlatedParams === true ? 'Sí' : info.correlatedParams === false ? 'No' : '']);
        const lumped = r.runInfo?.calcMethod === 'lumped-mass';
        const variability = [r.runInfo?.cnVariability, r.runInfo?.ctVariability].map(value => Number.isFinite(value) ? value : '—');
        if (variability.some(value => value !== '—')) {
            rows.push([lumped ? 'Variabilidad aplicada a Kn/Kt (%)' : 'Variabilidad de Cn/Ct aplicada a cada tramo (%)',
                lumped ? `Kn ${variability[0]}, Kt ${variability[1]}` : `Cn ${variability[0]}, Ct ${variability[1]}`]);
        }
        if (Array.isArray(r.runInfo?.segments)) {
            for (const segment of r.runInfo.segments) {
                rows.push([`Tramo ${segment.index} (${segment.x0}–${segment.x1} m)`,
                    `${segment.label}: Cn ${segment.cn}, Ct ${segment.ct}, rugosidad ${segment.roughness}°`]);
            }
        }
        rows.push(['Tope de eventos de impacto por roca', IMPACT_ROCK_CAP]);
        rows.push(['Convenciones', 'W = 10 m; umbral = 0.5 m; referencia al centro efectivo; alcance máximo muestreado por subpaso.']);
        if (r.lineage) rows.push(...this.lineageRows(r.lineage));
        // Ítem 27: conteos por métrica, al final; solo existen si hubo descartes.
        const nonFinite = r.warnings.find(w => w.code === 'metricasNoFinitas');
        if (nonFinite && nonFinite.counts) {
            for (const [key, count] of Object.entries(nonFinite.counts)) {
                rows.push([`Valores no finitos descartados: ${NON_FINITE_NAMES[key] ?? key} (N)`, count]);
            }
        }
        // P1.2: sección condicional, siempre al final; sin geometría no agrega filas (I-A).
        if (r.benchRetention) rows.push(...benchRetentionRows(r.benchRetention));
        else if (typeof r.benchRetentionUnavailable === 'string') rows.push([BENCH_TITLE, `No disponible: ${r.benchRetentionUnavailable}`]);
        // P1.3: sección condicional, después de la de retención; sin colectores no agrega filas (I-A).
        if (Array.isArray(r.collectors) && r.collectors.length) rows.push(...collectorRows(r.collectors));
        return rows;
    }

    generateCSV() {
        if (!this.results) return '';
        const rows = [['Parámetro', 'Valor', 'N', 'Mínimo', 'Media', 'Máximo', 'Desv. estándar', 'P10', 'P50', 'P83', 'P95', 'Cota inferior', 'Cota superior', 'Exacta', 'Excluidas'], ...this.exportRows()];
        return rows.map(row => Array.from({ length: 15 }, (_, i) => csvQuote(row[i])).join(',')).join('\n') + '\n';
    }

    generateImpactCSV() {
        const r = this.results;
        if (!r || r.impactExportAvailable !== true) return null;
        const rows = [IMPACT_HEADER];
        for (const event of r.impactEvents) {
            rows.push([event.rockId, REASON_NAMES[event.stopReason] ?? event.stopReason, event.t, event.x, event.y,
                SURFACE_NAMES[event.surface] ?? null, event.index, event.vn, event.speed, event.contactSpeed,
                Number.isFinite(event.energy) ? event.energy / 1000 : null, event.cnEff, event.ctEff, event.flightHeightBefore,
                event.rootId, KIND_NAMES[event.fragmentKind] ?? null]);
        }
        return rows.map(row => row.map(csvQuote).join(',')).join('\n') + '\n';
    }

    /**
     * CSV de destinos: una fila por hoja (pieza final), con su origen, motivo y zona.
     *
     * @returns {string|null} null si no hay resultados o la corrida no es publicable
     */
    generateDestinationsCSV() {
        const r = this.results;
        if (!r || r.blockedReason || !Array.isArray(r.destinations)) return null;
        const rows = [DESTINATIONS_HEADER];
        for (const d of r.destinations) {
            rows.push([d.id, d.rootId, d.parentId, KIND_NAMES[d.fragmentKind] ?? null, d.sourceIndex, d.releaseX, d.releaseY,
                d.finalX, d.finalY, REASON_NAMES[d.stopReason] ?? d.stopReason, BOUNDARY_NAMES[d.cullBoundary] ?? d.cullBoundary, d.zoneLabel, d.bench, d.mass]);
        }
        return rows.map(row => row.map(csvQuote).join(',')).join('\n') + '\n';
    }

    /**
     * CSV de cruces: una fila por cruce registrado en un colector de la corrida.
     *
     * @returns {string|null} null si no hay resultados, no hay colectores o la corrida no es publicable
     */
    generateCrossingsCSV() {
        const r = this.results;
        if (!r || r.blockedReason || !Array.isArray(r.collectors) || !r.collectors.length || !Array.isArray(r.crossingRows)) return null;
        return [CROSSINGS_HEADER, ...r.crossingRows].map(row => row.map(csvQuote).join(',')).join('\n') + '\n';
    }

    generateReport() {
        if (!this.results) return '';
        return 'SIMROCAS 2D — REPORTE DE SIMULACIÓN\n' + this.exportRows().map(row => {
            const value = row[1] === null || row[1] === undefined ? 'No disponible' : row[1];
            if (row[1] === null && row.length === 15) {
                const show = x => x === null || x === undefined ? 'No disponible' : x;
                return `${row[0]}: N=${show(row[2])}; mínimo=${show(row[3])}; media=${show(row[4])}; máximo=${show(row[5])}; desviación=${show(row[6])}; P10=${show(row[7])}; P50=${show(row[8])}; P83=${show(row[9])}; P95=${show(row[10])}${row[14] == null ? '' : `; excluidas=${row[14]}`}`;
            }
            if (row.length === 14) {
                const show = x => x === null || x === undefined ? 'No disponible' : x;
                return `${row[0]}: ${value}; N=${show(row[2])}; cota inferior=${show(row[11])}; cota superior=${show(row[12])}; exacta=${show(row[13])}`;
            }
            return `${row[0]}: ${value}`;
        }).join('\n') + '\n';
    }
}

SimRocas.Stats = Stats;
