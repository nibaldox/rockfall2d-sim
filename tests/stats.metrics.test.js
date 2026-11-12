'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load');
function stats(document) {
    const ctx = loadScripts(['js/stats.js'], { extra: { SimRocas: {}, document } });
    return new ctx.SimRocas.Stats();
}
function rock(overrides = {}) {
    return { releaseX: 10, releaseY: 40, finalX: 30, finalY: 20, sourceIndex: 0,
        downhillSign: 1, maxDownhillAdvance: 20, cullBoundary: null, stopReason: 'rest',
        isResting: true, isCore: false, generation: 0, maxKineticEnergy: 1000,
        maxBounceHeight: 2, maxImpactVelocity: 4, bounces: 3, impactEnergies: [], ...overrides };
}
function compute(rocks) { return stats().compute(rocks); }
const plain = x => JSON.parse(JSON.stringify(x));

test('fixture base de coordenadas finales es válido', () => {
    const r = compute([rock()]);
    assert.equal(r.status, 'completo');
    assert.equal(r.finalRunout.mean, 20);
    assert.equal(r.verticalDrop.mean, 20);
});
for (const field of ['finalX', 'finalY']) {
    for (const [label, value] of [['null', null], ['ausente', undefined], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['texto', '0']]) {
        test(`${field} ${label} bloquea el esquema sin exportar valores inválidos`, () => {
            const base = rock();
            assert.equal(compute([base]).status, 'completo');
            const invalid = { ...base, [field]: value };
            if (label === 'ausente') delete invalid[field];
            const s = stats();
            const r = s.compute([invalid]);
            assert.equal(r.status, 'bloqueado');
            assert.equal(r.blockedReason, 'esquemaInvalido');
            assert.equal(r.finalRunout, null);
            assert.equal(r.verticalDrop, null);
            for (const text of [s.generateCSV(), s.generateReport()]) assert.doesNotMatch(text, /NaN|Infinity|undefined/);
        });
    }
}
test('coordenadas finales cero calculan L y H desde fuente finita', () => {
    const r = compute([rock({ finalX: 0, finalY: 0 })]);
    assert.equal(r.status, 'completo');
    assert.equal(r.finalRunout.mean, -10);
    assert.equal(r.verticalDrop.mean, 40);
});
test('coordenadas finales negativas conservan el signo en las métricas', () => {
    const r = compute([rock({ finalX: -5, finalY: -2 })]);
    assert.equal(r.status, 'completo');
    assert.equal(r.finalX.mean, -5);
    assert.equal(r.finalRunout.mean, -15);
    assert.equal(r.verticalDrop.mean, 42);
});
test('coordenada final inválida en roca censurada bloquea toda la población', () => {
    const r = compute([rock(), rock({ stopReason: 'maxTime', finalY: null })]);
    assert.equal(r.status, 'bloqueado');
    assert.equal(r.blockedReason, 'esquemaInvalido');
    assert.equal(r.finalRunout, null);
    assert.equal(r.verticalDrop, null);
});
test('orígenes individuales: media 15', () => {
    const r = compute([rock(), rock({ releaseX: 100, finalX: 110, maxDownhillAdvance: 10 })]);
    assert.equal(r.finalRunout.mean, 15);
});
test('invariancia por traslación', () => {
    const a = rock(), b = rock({ releaseX: a.releaseX + 600, finalX: a.finalX + 600, releaseY: a.releaseY + 2400, finalY: a.finalY + 2400 });
    assert.deepEqual(plain(compute([a]).derived), plain(compute([b]).derived));
});
test('perfil reflejado produce alcance 20 y 45 grados', () => {
    const r = compute([rock({ downhillSign: -1, finalX: -10 })]);
    assert.equal(r.finalRunout.mean, 20); assert.equal(r.verticalDrop.mean, 20); assert.equal(r.reachAngle.mean, 45);
});
test('ángulos excluidos permanecen null', () => {
    const r = compute([rock({ finalX: 10 }), rock({ finalY: 41 }), rock()]);
    assert.deepEqual(plain(r.derived.reachAngle), [null, null, 45]); assert.equal(r.reachAngle.excluded, 2);
});
test('mezcla censurada cuenta salidas aguas abajo', () => {
    const r = compute([rock(), rock({ stopReason: 'culled', cullBoundary: 'maxX', isResting: false }), rock({ stopReason: 'maxTime', isResting: false })]);
    assert.equal(r.status, 'parcial'); assert.equal(r.population.rest, 1); assert.equal(r.population.censored, 2);
    assert.equal(r.population.culledByBoundary.downhill, 1); assert.equal(r.population.pctLeavingDownhill, 100 / 3);
});
test('cotas percentiles e infinito censurado', () => {
    const r = compute([rock({ finalX: 20, maxDownhillAdvance: 10 }), rock({ maxDownhillAdvance: 20 }), rock({ maxDownhillAdvance: 30, stopReason: 'maxTime', isResting: false })]);
    assert.deepEqual(plain(r.reachBounds.p50), { lower: 20, upper: 20, exact: true });
    assert.deepEqual(plain(r.reachBounds.p95), { lower: 29, upper: null, exact: false });
    assert.deepEqual(plain(r.reachBounds.max), { lower: 30, exact: false });
});
test('sentido ambiguo conserva descenso y bloquea alcance', () => {
    const r = compute([rock({ downhillSign: null, maxDownhillAdvance: null })]);
    assert.equal(r.status, 'parcial'); assert.equal(r.finalRunout, null); assert.equal(r.verticalDrop.mean, 20);
    assert.equal(r.reachBounds, null); assert.ok(r.warnings.some(w => w.code === 'direccionAmbigua'));
});
test('fragmentación bloquea sin excepción', () => {
    const r = compute([rock({ stopReason: 'fragmented' })]);
    assert.equal(r.status, 'bloqueado'); assert.equal(r.blockedReason, 'fragmentacion'); assert.equal(r.finalRunout, null);
});
test('cero es un valor válido', () => {
    const r = compute([rock({ finalX: 10, finalY: 40, maxDownhillAdvance: 0, maxKineticEnergy: 0, bounces: 0 })]);
    assert.equal(r.finalRunout.mean, 0); assert.equal(r.verticalDrop.mean, 0); assert.equal(r.kineticEnergy.mean, 0); assert.equal(r.bounceCount.mean, 0);
});
test('reposo depende del motivo y no de isResting', () => {
    const r = compute([rock({ isResting: false }), rock({ stopReason: 'maxTime', isResting: true })]);
    assert.equal(r.population.rest, 1); assert.equal(r.restRocks[0].stopReason, 'rest');
});
test('exportaciones españolas sin valores inválidos', () => {
    const s = stats(); s.compute([rock(), rock({ stopReason: 'maxTime', isResting: false })]);
    for (const text of [s.generateCSV(), s.generateReport()]) { assert.match(text, /censur/i); assert.doesNotMatch(text, /NaN|Infinity|undefined/); }
    assert.match(s.generateCSV(), /lower|inferior/i); assert.match(s.generateReport(), /≥/);
});
test('UI con null usa raya y no lanza', () => {
    const elements = {}; const s = stats({ getElementById(id) { return elements[id] ||= { textContent: '' }; } });
    s.compute([rock({ downhillSign: null, maxDownhillAdvance: null })]); s.updateUI();
    assert.equal(elements['stat-max-runout'].textContent, '—'); assert.equal(elements['stat-reach-p95'].textContent, '—');
});
test('esquema inválido, vacío y censura no publicable bloquean', () => {
    assert.equal(compute([]).blockedReason, 'sinRocas');
    assert.equal(compute([rock({ releaseX: NaN })]).blockedReason, 'esquemaInvalido');
    assert.equal(compute([rock({ stopReason: 'cancelled' })]).blockedReason, 'censuraNoPublicable');
});

test('todas las exclusiones se cuentan aunque el bloque sea null', () => {
    const r = compute([rock({ finalX: 10 }), rock({ finalY: 41 })]);
    assert.equal(r.reachAngle, null); assert.equal(r.reachAngleExcluded, 2);
});
test('límite de seguridad declarado en una roca impide publicación', () => {
    assert.equal(compute([rock({ status: 'safetyLimit' })]).blockedReason, 'censuraNoPublicable');
});
test('cota superior finita y no exacta se interpola sin infinito', () => {
    const r = compute([rock({ finalX: 20, maxDownhillAdvance: 10, stopReason: 'maxTime' }),
        rock({ maxDownhillAdvance: 20 }), rock({ finalX: 40, maxDownhillAdvance: 30 }), rock({ finalX: 50, maxDownhillAdvance: 40 })]);
    assert.deepEqual(plain(r.reachBounds.p50), { lower: 25, upper: 35, exact: false });
    assert.equal(r.reachBounds.p95.upper, null);
});
test('salidas reflejadas y multifuente conservan signo por roca', () => {
    const r = compute([rock(), rock({ sourceIndex: 1, downhillSign: -1, finalX: -10, stopReason: 'culled', cullBoundary: 'minX' })]);
    assert.equal(r.population.culledByBoundary.downhill, 1); assert.equal(r.population.pctLeavingDownhill, 50);
    assert.ok(r.warnings.some(w => w.code === 'variasFuentes'));
});
test('sin reposo mantiene bloques null y cota inferior', () => {
    const r = compute([rock({ stopReason: 'maxSteps', isResting: false })]);
    assert.equal(r.finalRunout, null); assert.equal(r.reachBounds.p95.lower, 20);
    assert.equal(r.reachBounds.p95.upper, null); assert.ok(r.warnings.some(w => w.code === 'sinReposo'));
});

test('agregados con entradas finitas grandes no producen infinito ni NaN', () => {
    const r = compute([rock({ finalX: 1e308, maxDownhillAdvance: 1e308 }), rock({ finalX: 1e308, maxDownhillAdvance: 1e308 })]);
    assert.equal(r.finalX.mean, 1e308); assert.equal(r.finalX.std, 0);
    const walk = x => { if (typeof x === 'number') assert.ok(Number.isFinite(x)); else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
    walk(r);
});

test('marcado conserva ids y presenta etiquetas y sentido', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
    for (const id of ['stat-max-ke', 'stat-mean-ke', 'stat-max-bounce', 'stat-max-runout', 'stat-max-velocity', 'stat-max-bounces', 'stat-savigny-angle', 'stat-n-rest', 'stat-pct-leaving', 'stat-reach-p95', 'stats-warnings', 'downhill-mode']) {
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
    }
    assert.match(html, /Sentido de descenso/); assert.match(html, /value="\+x"/); assert.match(html, /value="-x"/);
    assert.match(html, /Alcance final relativo acumulado de las rocas en reposo/);
});
test('el conteo interno de contactos se identifica en exportaciones y resumen', () => {
    const s = stats(); s.compute([rock({ bounces: 3 })]);
    const label = 'Contactos detectados (conteo interno, no equivale a impactos)';
    const csv = s.generateCSV(), report = s.generateReport();
    assert.ok(csv.split('\n').some(line => line.startsWith(`"${label}",,1,3,3,3,`)));
    assert.ok(report.split('\n').some(line => line.startsWith(`${label}: N=1; mínimo=3; media=3; máximo=3;`)));
    assert.doesNotMatch(csv, /^Rebotes(?:,|$)/m);
    assert.doesNotMatch(report, /^Rebotes:/m);
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
    assert.match(html, /Contactos detectados, máx\. \(conteo interno; no son impactos\)<\/span><span class="dash-stat-val" id="stat-max-bounces"/);
});
test('reporte y CSV incluyen límites y exclusiones sin reposo válido', () => {
    const s = stats(); s.compute([rock({ finalX: 10 }), rock({ finalY: 41 }), rock({ stopReason: 'maxTime' })]);
    assert.match(s.generateReport(), /excluidas=2/); assert.match(s.generateReport(), /cota superior=No disponible/);
    assert.match(s.generateCSV(), /Cota inferior,Cota superior,Exacta,Excluidas/);
});
