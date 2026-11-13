'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const lifecycle = path.join(__dirname, 'app.lifecycle.test.js');
const fixtureSource = fs.readFileSync(lifecycle, 'utf8').split("test('cancelar worker")[0];
const { fixture, rock } = new Function('require', '__dirname', fixtureSource + '\nreturn { fixture, rock };')(createRequire(lifecycle), __dirname);

// Fixtures de roca según CONTRATO_P04 §2.
function primary(id, overrides = {}) {
    return { ...rock('rest'), id, parentId: null, rootId: id, fragmentKind: 'primary',
        bornAt: 0, discardedMass: 0, ...overrides };
}
function child(id, parentId, rootId, fragmentKind, overrides = {}) {
    return { ...rock('rest'), id, parentId, rootId, fragmentKind, bornAt: 1.5, discardedMass: 0,
        isCore: fragmentKind !== 'spall', generation: 1, ...overrides };
}
// Primaria 1 fragmentada en un principal y una esquirla; primaria 4 intacta.
function tree() {
    return [
        primary(1, { stopReason: 'fragmented', elapsedTime: 1.5, isCore: false, generation: 0, discardedMass: 30 }),
        child(2, 1, 1, 'major'),
        child(3, 1, 1, 'spall', { isCore: false }),
        primary(4)
    ];
}

// Doble de Stats con el esquema de CONTRATO_P04 «Parte B» (B.1–B.4).
const LINEAGE = {
    primaries: 2, entities: 4, leaves: 3, maxGeneration: 1,
    byKind: { primary: 1, core: 0, major: 1, spall: 1 },
    byReason: { rest: 2, culled: 1, maxTime: 0, maxSteps: 0 },
    mass: { original: 2000, rest: 1500.5, culled: 400.25, censored: 69.25, discarded: 30, maxRelativeError: 1e-16 },
    finalRunout: { n: 2, massTotal: 1500.5, p10: 11.1, p50: 42.25, p83: 63.5, p95: 77.75, max: 80 },
    discardedByTree: [{ rootId: 1, discarded: 30, fraction: 0.03 }, { rootId: 4, discarded: 0, fraction: 0 }]
};
const INFO = 'Corrida con fragmentación: estadísticas por roca original (envolvente); ver bloque de piezas finales';
const DISCARDED = 'Masa descartada superior al 1 % en 1 roca original.';
class FakeStats {
    constructor(mode) { this.mode = mode; this.results = null; this.updates = 0; }
    compute(rocks) {
        const fragmented = this.mode !== 'plain';
        const primaries = rocks.filter(r => r.parentId === null).length;
        if (this.mode === 'blocked') {
            this.results = { contractVersion: 'P0.4', status: 'bloqueado', blockedReason: 'linajeInvalido',
                population: { released: primaries, rest: 0, sources: [0], directionResolved: true },
                reachBounds: null, warnings: [{ code: 'linajeInvalido', message: 'Linaje inválido.' }] };
            return;
        }
        this.results = {
            contractVersion: 'P0.4', status: 'completo', blockedReason: null,
            population: { released: primaries, rest: primaries, censored: 0, sources: [0], directionResolved: true,
                byReason: { rest: primaries } },
            reachBounds: null, impactExportAvailable: true,
            warnings: fragmented ? [{ code: 'fragmentacion', message: INFO }] : []
        };
        // B.2: la clave solo existe con fragmentación (ausente, no null).
        if (fragmented) {
            this.results.lineage = structuredClone(this.lineage || LINEAGE);
            // B.2: `masaDescartada` solo si alguna fracción supera 0.01.
            if (this.results.lineage.discardedByTree.some(t => t.fraction > 0.01)) this.results.warnings.push({ code: 'masaDescartada', message: DISCARDED });
        }
    }
    updateUI() { this.updates++; }
    generateCSV() { return 'Parámetro,Valor'; }
    generateReport() { return 'REPORTE'; }
    generateImpactCSV() { return 'Roca'; }
}

const EXPORTS = ['btn-export-csv', 'btn-export-report', 'btn-export-impacts', 'btn-dashboard-csv',
    'btn-dashboard-report', 'btn-dashboard-png', 'btn-open-dashboard'];
function run(worker, mode, rocks, lineage) {
    const f = fixture(worker);
    f.app.stats = new FakeStats(mode);
    if (lineage) f.app.stats.lineage = lineage;
    f.app.runSimulation();
    if (worker) f.workers[0].onmessage({ data: { type: 'complete', status: 'completed', rocks } });
    else { f.app.simulation.rocks = rocks; f.app.simulation.onComplete(rocks); }
    return f;
}
const text = (f, id) => f.element(id).textContent;

for (const worker of [false, true]) {
    const where = worker ? 'Worker' : 'normal';

    test(`con lineage publica, muestra el bloque y habilita exportaciones (${where})`, () => {
        const f = run(worker, 'lineage', tree());
        assert.equal(f.app._resultsValid, true);
        assert.equal(f.app.stats.updates, 1);
        assert.ok(f.app.stats.results && f.app.stats.results.lineage);
        for (const id of EXPORTS) assert.equal(f.element(id).disabled, false, id);
        const status = text(f, 'simulation-status');
        assert.doesNotMatch(status, /bloquead|incompatible|incompleta/i);
        assert.match(status, /2 rocas originales/);
        assert.match(status, /3 piezas finales/);
        assert.match(status, /masa en reposo 1500\.5 kg/);
        assert.match(status, /estadísticas por roca original/);
        // El conteo visible es por primaria, no por entidad.
        assert.equal(text(f, 'rock-count-display'), 'Rocas: 2');
        assert.equal(f.element('lineage-block').style.display, 'block');
        assert.equal(text(f, 'lineage-primaries'), '2');
        assert.equal(text(f, 'lineage-leaves'), '3');
        assert.equal(text(f, 'lineage-by-kind'), 'Roca original intacta: 1 · Fragmento principal: 1 · Esquirla: 1');
        assert.equal(text(f, 'lineage-by-reason'), 'En reposo: 2 · Fuera del perfil: 1');
        assert.equal(text(f, 'lineage-mass-original'), '2000.0');
        assert.equal(text(f, 'lineage-mass-rest'), '1500.5');
        assert.equal(text(f, 'lineage-mass-culled'), '400.3');
        assert.equal(text(f, 'lineage-mass-censored'), '69.3');
        assert.equal(text(f, 'lineage-mass-discarded'), '30.0');
        assert.equal(text(f, 'lineage-runout-p50'), '42.3');
        assert.equal(text(f, 'lineage-runout-p83'), '63.5');
        assert.equal(text(f, 'lineage-runout-p95'), '77.8');
        assert.equal(text(f, 'lineage-warning'), DISCARDED);
    });

    test(`con lineage sin masa descartada ni dirección: sin advertencia y alcance «—» (${where})`, () => {
        const lineage = structuredClone(LINEAGE);
        lineage.mass.discarded = 0;
        lineage.discardedByTree = [{ rootId: 1, discarded: 0, fraction: 0 }];
        lineage.finalRunout = null;
        const f = run(worker, 'lineage', tree(), lineage);
        assert.equal(f.element('lineage-block').style.display, 'block');
        assert.equal(text(f, 'lineage-warning'), '');
        for (const p of ['p50', 'p83', 'p95']) assert.equal(text(f, `lineage-runout-${p}`), '—');
    });

    test(`sin lineage el bloque queda oculto y la UI no cambia (${where})`, () => {
        const f = run(worker, 'plain', [primary(1), primary(2)]);
        assert.equal(f.app._resultsValid, true);
        assert.equal('lineage' in f.app.stats.results, false);
        assert.equal(f.element('lineage-block').style.display, 'none');
        assert.equal(text(f, 'lineage-warning'), '');
        assert.equal(text(f, 'simulation-status'), `Completado (2 rocas${worker ? ', Worker' : ''}): rest: 2.  Mapa no disponible: cotas de alcance no disponibles.`);
        assert.equal(text(f, 'rock-count-display'), 'Rocas: 2');
        for (const id of EXPORTS) assert.equal(f.element(id).disabled, false, id);
    });

    test(`linajeInvalido invalida y muestra el motivo (${where})`, () => {
        const f = run(worker, 'blocked', tree());
        assert.equal(f.app._resultsValid, false);
        assert.equal(f.app.stats.results, null);
        assert.equal(f.app.stats.updates, 0);
        assert.match(text(f, 'simulation-status'), /Resultados bloqueados \(linajeInvalido\): /);
        assert.match(text(f, 'simulation-status'), /fragmented: 1/);
        for (const id of EXPORTS) assert.equal(f.element(id).disabled, true, id);
        assert.equal(f.element('lineage-block').style.display, 'none');
    });

    test(`una corrida nueva oculta el bloque de la anterior (${where})`, () => {
        const f = run(worker, 'lineage', tree());
        assert.equal(f.element('lineage-block').style.display, 'block');
        f.app._invalidateResults();
        assert.equal(f.element('lineage-block').style.display, 'none');
        assert.equal(text(f, 'lineage-primaries'), '—');
        assert.equal(text(f, 'lineage-warning'), '');
    });
}

test('index.html: bloque de piezas finales oculto, en español, y versionado de la parte B', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /<div id="lineage-block"[^>]*style="display:none;"/);
    assert.match(html, /Piezas finales \(fragmentación\)/);
    for (const id of ['lineage-primaries', 'lineage-leaves', 'lineage-by-kind', 'lineage-by-reason',
        'lineage-mass-original', 'lineage-mass-rest', 'lineage-mass-culled', 'lineage-mass-censored',
        'lineage-mass-discarded', 'lineage-runout-p50', 'lineage-runout-p83', 'lineage-runout-p95', 'lineage-warning']) {
        assert.equal(html.split(`id="${id}"`).length, 2, id);
    }
    for (const label of ['Rocas originales', 'Piezas por tipo', 'Piezas por motivo', 'Masa original (kg)',
        'Masa en reposo (kg)', 'Masa fuera del perfil (kg)', 'Masa censurada (kg)', 'Masa descartada (kg)',
        'Alcance final ponderado por masa, P50 (m)', 'P83 (m)', 'P95 (m)']) assert.ok(html.includes(label), label);
    const versions = Object.fromEntries([...html.matchAll(/js\/([\w-]+)\.js\?v=(\d+)/g)].map(m => [m[1], Number(m[2])]));
    assert.equal(versions.stats, 11);
    assert.equal(versions.app, 19); // P1.1
    assert.equal(versions.physics, 14);
    assert.equal(versions.simulation, 13);
    const appChanged = name => fs.readFileSync(path.join(ROOT, 'js', `${name}.js`), 'utf8');
    assert.ok(appChanged('app').includes('lineage-block'));
    // renderer no cambia de bytes; app-worker sube a 11 en P1.1 (WORKER_VERSION 12).
    assert.equal(versions['app-worker'], 11);
    assert.equal(versions.renderer, 7);
});
