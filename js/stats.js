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
        const rawTimeStep = source ? source.timeStep : null, rawCalcMethod = source ? source.calcMethod : null;
        const effective = {
            timeStep: Number.isFinite(rawTimeStep) && rawTimeStep > 0 ? rawTimeStep : null,
            calcMethod: calcMethods.includes(rawCalcMethod) ? rawCalcMethod : null
        };
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
            contractVersion: 'P0.2-alfa', status: blockedReason ? 'bloqueado' : (censored || !directionResolved ? 'parcial' : 'completo'),
            blockedReason, warnings, totalRocks: input.length, population, restRocks: [],
            runInfo: { timeStep: effective.timeStep, calcMethod: effective.calcMethod },
            derived: { finalRunout: [], verticalDrop: [], reachAngle: [] },
            finalRunout: null, verticalDrop: null, reachAngle: null, reachAngleExcluded: null, finalX: null,
            kineticEnergy: null, bounceHeight: null, impactVelocity: null, bounceCount: null,
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
        return result;
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
        set('stat-max-ke', number(r.kineticEnergy?.max));
        set('stat-mean-ke', number(r.kineticEnergy?.mean));
        set('stat-max-bounce', number(r.bounceHeight?.max));
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
            finalX: 'X final (m)', kineticEnergy: 'Energía cinética máxima por roca (kJ)', bounceHeight: 'Altura del centro al contacto (m)',
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
        rows.push(['Convenciones', 'W = 10 m; umbral = 0.5 m; referencia al centro efectivo; alcance máximo muestreado por subpaso.']);
        return rows;
    }

    generateCSV() {
        if (!this.results) return '';
        const quote = value => {
            if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return '';
            const text = String(value);
            return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const rows = [['Parámetro', 'Valor', 'N', 'Mínimo', 'Media', 'Máximo', 'Desv. estándar', 'P10', 'P50', 'P83', 'P95', 'Cota inferior', 'Cota superior', 'Exacta', 'Excluidas'], ...this.exportRows()];
        return rows.map(row => Array.from({ length: 15 }, (_, i) => quote(row[i])).join(',')).join('\n') + '\n';
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
