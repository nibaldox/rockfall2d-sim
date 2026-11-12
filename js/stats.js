// Límites del contrato P0.2-β: 200 eventos por roca y 100 000 filas por corrida.
const IMPACT_ROW_CAP = 100000;
const IMPACT_ROCK_CAP = 200;
const IMPACT_SURFACES = ['terrain', 'barrier'];
const IMPACT_REASONS = ['rest', 'culled', 'maxTime', 'maxSteps'];
const IMPACT_HEADER = ['Roca', 'Motivo de término', 'Tiempo (s)', 'X centro (m)', 'Y centro (m)', 'Superficie',
    'Tramo o barrera', 'Velocidad normal (m/s)', 'Rapidez (m/s)', 'Rapidez del punto de contacto (m/s)',
    'Energía total (kJ)', 'Coef. normal efectivo', 'Coef. tangencial efectivo', 'Altura de vuelo previa (m)'];
const IMPACT_TRUNCATED_MESSAGE = 'Se alcanzó el tope de eventos de impacto exportables (200 por roca, 100 000 en total); los máximos y conteos por roca incluyen todos los eventos.';
const REASON_NAMES = { rest: 'reposo', culled: 'salida del dominio', maxTime: 'tiempo máximo', maxSteps: 'pasos máximos', fragmented: 'fragmentación', cancelled: 'cancelación', safetyLimit: 'límite de seguridad' };
const SURFACE_NAMES = { terrain: 'Terreno', barrier: 'Barrera' };

// Único escapado CSV del módulo: lo comparten generateCSV y generateImpactCSV.
function csvQuote(value) {
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

class Stats {
    constructor() {
        this.results = null;
    }

    compute(rocks, releasePoint = null, runInfo = null) {
        const input = Array.isArray(rocks) ? rocks : [];
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
        const fragmented = input.some(r => r && (r.stopReason === 'fragmented' || r.isCore || r.generation > 0));
        if (censored) warn('censura', 'Hay rocas censuradas; las distribuciones finales son condicionales al reposo y el alcance máximo es una cota.');
        if (!directionResolved && input.length) warn('direccionAmbigua', 'El sentido de descenso no está resuelto para todas las rocas.');
        if (fragmented) warn('fragmentacion', 'La fragmentación impide publicar agregados hasta P0.4.');
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
        let blockedReason = !input.length ? 'sinRocas' : fragmented ? 'fragmentacion' :
            (byReason.cancelled || byReason.safetyLimit || rocks.status === 'safetyLimit' || input.some(r => r && r.status === 'safetyLimit')) ? 'censuraNoPublicable' :
            !input.every(valid) ? 'esquemaInvalido' : null;
        const result = {
            contractVersion: 'P0.2-beta', status: blockedReason ? 'bloqueado' : (censored || !directionResolved ? 'parcial' : 'completo'),
            blockedReason, warnings, totalRocks: input.length, population, restRocks: [],
            runInfo: { timeStep: effective.timeStep, calcMethod: effective.calcMethod,
                cnVariability: effective.cnVariability, ctVariability: effective.ctVariability, segments: effective.segments },
            derived: { finalRunout: [], verticalDrop: [], reachAngle: [] },
            finalRunout: null, verticalDrop: null, reachAngle: null, reachAngleExcluded: null, finalX: null,
            kineticEnergy: null, bounceHeight: null, impactVelocity: null, bounceCount: null,
            flightHeight: null, impactNormalSpeed: null, impactSpeed: null, impactEnergy: null, impactCount: null,
            impactEvents: [], impactExportAvailable: false,
            reachBounds: null, impactEnergies: []
        };
        this.results = result;
        if (blockedReason) return result;
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
        const finite = value => Number.isFinite(value) ? value : null;
        const derived = result.derived;
        derived.finalRunout = rest.map(r => directionResolved ? finite(r.downhillSign * (r.finalX - r.releaseX)) : null);
        derived.verticalDrop = rest.map(r => finite(r.releaseY - r.finalY));
        derived.reachAngle = rest.map((r, i) => {
            const l = derived.finalRunout[i], h = derived.verticalDrop[i];
            return l !== null && h !== null && l > 0 && h >= 0 ? finite(Math.atan2(h, l) * 180 / Math.PI) : null;
        });
        const block = values => this.statsForArray(values.filter(Number.isFinite));
        result.finalRunout = directionResolved ? block(derived.finalRunout) : null;
        result.verticalDrop = block(derived.verticalDrop);
        result.reachAngle = directionResolved ? block(derived.reachAngle) : null;
        result.reachAngleExcluded = rest.length - derived.reachAngle.filter(Number.isFinite).length;
        if (result.reachAngle) result.reachAngle.excluded = result.reachAngleExcluded;
        result.finalX = block(rest.map(r => r.finalX));
        result.kineticEnergy = block(rest.map(r => Number.isFinite(r.maxKineticEnergy) ? r.maxKineticEnergy / 1000 : null));
        result.bounceHeight = block(rest.map(r => r.maxBounceHeight));
        result.impactVelocity = block(rest.map(r => r.maxImpactVelocity));
        result.bounceCount = block(rest.map(r => r.bounces));
        result.flightHeight = block(rest.map(r => r.maxFlightHeight));
        result.impactNormalSpeed = block(rest.map(r => r.maxImpactNormalSpeed));
        result.impactSpeed = block(rest.map(r => r.maxImpactSpeed));
        result.impactEnergy = block(rest.map(r => Number.isFinite(r.maxImpactEnergy) ? r.maxImpactEnergy / 1000 : null));
        result.impactCount = block(rest.map(r => r.impactCount));
        result.impactEnergies = rest.flatMap(r => Array.isArray(r.impactEnergies) ? r.impactEnergies.filter(Number.isFinite) : []);
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
        input.forEach((r, position) => {
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
                const finite = value => Number.isFinite(value) ? value : null;
                events.push({
                    rockId, stopReason: r.stopReason,
                    t: finite(item.t), x: finite(item.x), y: finite(item.y),
                    surface: IMPACT_SURFACES.includes(item.surface) ? item.surface : null,
                    index: Number.isInteger(item.index) && item.index >= 0 ? item.index : null,
                    vn: finite(item.vn), speed: finite(item.speed), contactSpeed: finite(item.contactSpeed),
                    energy: finite(item.energy), cnEff: finite(item.cnEff), ctEff: finite(item.ctEff),
                    flightHeightBefore: finite(item.flightHeightBefore)
                });
            }
        });
        result.impactEvents = events;
        result.impactExportAvailable = true;
        if (truncatedRocks > 0 || capped) warn('impactosTruncados', IMPACT_TRUNCATED_MESSAGE);
        // E2.2: impactos de terreno más allá de los extremos del perfil de la corrida.
        if (profileExtent) {
            const minX = profileExtent.minX, maxX = profileExtent.maxX;
            const outside = input.some(r =>
                Array.isArray(r.impactEvents) && r.impactEvents.some(e => e && e.surface === 'terrain' &&
                    Number.isFinite(e.x) && (e.x < minX || e.x > maxX)));
            if (outside) {
                warn('fueraDelPerfil', effective.calcMethod === 'lumped-mass' ?
                    'Hay impactos sobre la prolongación horizontal del perfil, más allá de sus extremos; en masa concentrada se usan Kn/Kt globales.' :
                    'Hay impactos sobre la prolongación horizontal del perfil, más allá de sus extremos; se usa el material del tramo extremo.');
            }
        }
        return result;
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
                Number.isFinite(event.energy) ? event.energy / 1000 : null, event.cnEff, event.ctEff, event.flightHeightBefore]);
        }
        return rows.map(row => row.map(csvQuote).join(',')).join('\n') + '\n';
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
