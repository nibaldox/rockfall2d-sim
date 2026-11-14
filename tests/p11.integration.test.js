'use strict';
// P1.1 (I9): integración de punta a punta. «Generar» con el BenchProfile real ->
// motor real -> Worker -> Stats real -> CSV; I-A contra 1fc23718 salvo X4
// (engineVersion 11→12); invalidación al editar; correcciones 4a, 4b y 4c.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { loadScripts } = require('./helpers/load');

// Reutiliza el fixture de p11.app.test.js sin registrar sus tests.
const appTest = path.join(__dirname, 'p11.app.test.js');
const source = fs.readFileSync(appTest, 'utf8').replace("const test = require('node:test');", 'const test = () => {};');
const { make, hooks, fillBench, runWorker, print, read } = new Function('require', '__dirname',
    source + '\nreturn { make, hooks, fillBench, runWorker, print, read };')(createRequire(appTest), __dirname);

const EXPORTS = ['btn-export-csv', 'btn-export-report', 'btn-dashboard-csv', 'btn-dashboard-report'];
const BENCH = { 'bench-count': '3', 'bench-height': '10', 'bench-face-angle': '70', 'bench-berm-width': '8',
    'bench-base-elevation': '0', 'bench-top-platform': '20', 'bench-floor-length': '30' };

// Corre la simulación con Stats real por el camino indicado.
function runReal(f, worker, seedText) {
    f.app.stats = new f.Stats();
    f.element('sim-seed').value = seedText;
    hooks.alerts.length = 0;
    f.app.runSimulation();
    assert.deepEqual(hooks.alerts, []);
    let rocks;
    if (worker) {
        assert.equal(f.workers.length, 1);
        const done = runWorker(JSON.parse(JSON.stringify(f.workers[0].message))).find(m => m.type === 'complete');
        assert.ok(done, 'el Worker termina');
        rocks = done.rocks;
        f.workers[0].onmessage({ data: done });
    } else {
        let guard = 0;
        while (f.app.simulation.isRunning && guard++ < 200000) f.app.simulation.step();
        assert.equal(f.app.simulation.isRunning, false);
        rocks = f.app.simulation.rocks;
    }
    assert.ok(rocks.length >= 3);
    assert.equal(f.app._resultsValid, true, 'la App publica');
    const results = f.app.stats.results;
    assert.ok(results && results.status !== 'bloqueado', 'Stats real publica');
    return { f, rocks, results, print: print(rocks), json: JSON.stringify(results),
        csv: f.app.stats.generateCSV(), report: f.app.stats.generateReport() };
}

function generated(worker) {
    const f = make({ worker });
    f.global.SimRocas.BenchProfile = loadScripts(['js/bench-profile.js'], { env: 'browser' }).SimRocas.BenchProfile;
    fillBench(f, BENCH);
    f.element('btn-bench-generate').click();
    assert.deepEqual(hooks.alerts, []);
    return f;
}

test('cadena real: Generar (N=3, H=10, α=70, W=8) -> corrida con semilla -> normal = Worker -> CSV general', () => {
    const out = {};
    for (const worker of [false, true]) {
        const f = generated(worker);
        const pts = f.app.terrain.points;
        assert.equal(pts.length, 8, '2N + 2 vértices');
        assert.ok(Math.abs((pts[0].y - pts[pts.length - 1].y) - 30) < 1e-9, 'caída total N·H');
        assert.ok(Math.abs((pts[3].x - pts[2].x) - 8) < 1e-9, 'ancho de berma W');
        assert.equal(f.app.terrain.segments.map(s => s.type).join(),
            'relleno,roca-dura,relleno,roca-dura,relleno,roca-dura,suelo');
        assert.equal(f.element('downhill-mode').value, '+x');
        assert.ok(f.app._benchProfile && f.app._benchProfile.benchMeta.length === 3);
        const r = runReal(f, worker, '20261112');
        assert.ok(r.rocks.every(rock => rock.downhillSign === 1), 'downhillSign resuelto (+x) en todas las rocas');
        assert.equal(r.results.population.directionResolved, true);
        assert.ok(!r.results.warnings.some(w => JSON.stringify(w).includes('direccionAmbigua')), 'no es parcial por dirección');
        assert.match(r.csv, /^Versión del motor,13,/m); // P1.3 X5: WORKER_VERSION 12→13
        assert.match(r.csv, /^Semilla,20261112,/m);
        assert.match(r.csv, /^Versión del contrato de resultados,P0\.5,/m);
        assert.ok(r.csv.split('\n').length > 10, 'CSV general no vacuo');
        out[worker] = r;
    }
    assert.equal(out.false.print, out.true.print, 'rocas normal = Worker');
    // restRocks guarda las rocas del motor (hilo) o sus DTO (Worker): se comparan los campos comunes.
    const common = r => {
        const o = JSON.parse(r.json);
        o.restRocks = o.restRocks.map(rock => [rock.id, rock.finalX, rock.finalY, rock.downhillSign, rock.bounces]);
        return JSON.stringify(o);
    };
    assert.equal(common(out.false), common(out.true), 'resultados normal = Worker');
    assert.ok(JSON.parse(out.false.json).restRocks.some(rock => rock.finalY < 29), 'no vacuo: alguna roca baja de la plataforma');
    assert.equal(out.false.csv, out.true.csv, 'CSV general normal = Worker');
    assert.equal(out.false.report, out.true.report, 'reporte normal = Worker');
});

test('I-A: perfil fijo sin generador, CSV general y reporte iguales a 1fc23718 salvo X4', () => {
    for (const worker of [false, true]) {
        const now = runReal(make({ worker }), worker, '20261112');
        const base = runReal(make({ worker, base: true }), worker, '20261112');
        assert.equal(now.print, base.print, 'mismas rocas');
        assert.equal(now.results.runInfo.engineVersion, 13); // P1.3 X5: WORKER_VERSION 12→13
        assert.equal(base.results.runInfo.engineVersion, 11);
        for (const key of ['csv', 'report']) {
            const a = now[key].split('\n'), b = base[key].split('\n');
            assert.equal(a.length, b.length, `${key}: mismas líneas`);
            const diff = a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
            assert.equal(diff.length, 1, `${key}: solo cambia la fila X4`);
            assert.match(diff[0][0], /Versión del motor/);
            assert.equal(diff[0][0].replace('13', '11'), diff[0][1], `${key}: X4 es 11→13`); // P1.3 X5
        }
        const strip = r => { const o = JSON.parse(r.json); delete o.runInfo.engineVersion; return JSON.stringify(o); };
        assert.equal(strip(now), strip(base), 'mismos results salvo X4');
    }
});

test('editar el perfil después de la corrida invalida los resultados y deshabilita las exportaciones', () => {
    for (const worker of [false, true]) {
        const f = generated(worker);
        runReal(f, worker, '7');
        for (const id of EXPORTS) assert.equal(f.element(id).disabled, false, `${id} habilitado tras la corrida`);
        f.element('input-x').value = '500'; f.element('input-y').value = '-5';
        f.element('btn-add-point').click();
        assert.equal(f.app.terrain.points.length, 9);
        assert.equal(f.app._resultsValid, false);
        assert.equal(f.app._benchProfile, null);
        for (const id of [...EXPORTS, 'btn-export-impacts']) assert.equal(f.element(id).disabled, true, `${id} deshabilitado`);
    }
});

// --- Correcciones de I9 ---
test('4a: «Limpiar Perfil» sigue vaciando el perfil; importar o pegar datos vacíos no lo cambia', () => {
    const f = make();
    const before = f.app.terrain.toJSON();
    for (const [name, text] of [['p.json', '{"points":[],"segments":[]}'], ['p.json', ''], ['p.csv', ''], ['p.csv', 'x,y\n']]) {
        hooks.alerts.length = 0;
        f.element('file-input').listeners.change({ target: { files: [{ name, text }] } });
        assert.equal(hooks.alerts.length, 1, `${name} «${text}»: un alert`);
        assert.match(hooks.alerts[0], /^Error al cargar el perfil: /);
        assert.equal(f.app.terrain.toJSON(), before, 'perfil intacto');
    }
    hooks.alerts.length = 0;
    hooks.clipboard = '';
    f.element('btn-paste-coords').click();
    assert.equal(f.app.terrain.toJSON(), before, 'pegar vacío no cambia el perfil');
    assert.throws(() => f.app.terrain.setPoints([]), /Perfil inválido/);
    assert.throws(() => f.app.terrain.setPoints(null), /Perfil inválido/);
    assert.equal(f.app.terrain.toJSON(), before);
    hooks.alerts.length = 0;
    f.element('btn-clear-terrain').click();
    assert.deepEqual(hooks.alerts, []);
    assert.equal(f.app.terrain.points.length, 0);
    assert.equal(f.app.terrain.segments.length, 0);
});

test('4a: toda llamada a setPoints, fromJSON y fromCSV en js/app*.js está dentro de un try con alert', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'js')).filter(name => /^app.*\.js$/.test(name));
    let calls = 0;
    for (const name of files) {
        const src = read(`js/${name}`).replace(/^\s*(\*|\/\/).*$/gm, '');
        const re = /\bterrain\.(setPoints|fromJSON|fromCSV)\(/g;
        let m;
        while ((m = re.exec(src))) {
            calls++;
            const tryAt = src.lastIndexOf('try {', m.index);
            assert.ok(tryAt > 0, `${name}: ${m[1]} sin try`);
            assert.ok(!/\bcatch \(/.test(src.slice(tryAt, m.index)), `${name}: ${m[1]} fuera del try más cercano`);
            const handler = /\} catch \((\w+)\) \{([\s\S]*?)\n\s*\}/.exec(src.slice(m.index));
            assert.ok(handler && /alert\(|fail\(/.test(handler[2]), `${name}: ${m[1]} sin alert en el catch`);
        }
        assert.ok(!/terrain\.setPoints\(\s*(\[\s*\]|null)?\s*\)/.test(src), `${name}: no se vacía con setPoints`);
    }
    assert.equal(calls, 5, 'app.js (Generar, CSV, JSON), app-stl.js y app-profile3d.js');
});

test('4b: setSegmentProperties rechaza cn y ct fuera de [0, 1] y rugosidad fuera de [0, 30] sin mutar', () => {
    const f = make();
    const t = f.app.terrain;
    const before = JSON.stringify(t.segments);
    for (const props of [{ cn: 1.01 }, { cn: -0.1 }, { ct: 2 }, { ct: NaN }, { cn: '0.5' }, { roughness: 31 }, { roughness: -1 },
        { roughness: Infinity }, { type: 'suelo', cn: 5 }, { cn: 0.5, roughness: 99 }]) {
        assert.throws(() => t.setSegmentProperties(0, props), /Propiedades de tramo inválidas/, JSON.stringify(props));
        assert.equal(JSON.stringify(t.segments), before, 'sin cambios parciales');
    }
    t.setSegmentProperties(0, { cn: 0, ct: 1, roughness: 30 });
    assert.deepEqual([t.segments[0].cn, t.segments[0].ct, t.segments[0].roughness], [0, 1, 30]);
    t.setSegmentProperties(1, { type: 'suelo' });
    assert.equal(t.segments[1].type, 'suelo');
    t.setSegmentProperties(99, { cn: 5 });
});

test('4b: la App muestra un alert y no cambia ni invalida si la rugosidad sale de rango', () => {
    const f = make();
    f.app.selectedSegmentIndex = 0;
    f.app._resultsValid = true;
    const slider = f.element('segment-roughness');
    const before = f.app.terrain.toJSON();
    slider.value = '45';
    slider.listeners.input();
    assert.equal(hooks.alerts.length, 1);
    assert.match(hooks.alerts[0], /^Error al editar el tramo: .*rugosidad/);
    assert.equal(f.app.terrain.toJSON(), before);
    assert.equal(f.app._resultsValid, true);
    assert.equal(Number(slider.value), f.app.terrain.segments[0].roughness || 0, 'el control vuelve al valor vigente');
    hooks.alerts.length = 0;
    slider.value = '20';
    slider.listeners.input();
    assert.deepEqual(hooks.alerts, []);
    assert.equal(f.app.terrain.segments[0].roughness, 20);
    assert.equal(f.app._resultsValid, false);
});

test('4c: cada campo de «Generar banco–berma» tiene un <label> visible en español', () => {
    const html = read('index.html');
    const group = /<div class="control-group" id="bench-generator">[\s\S]*?id="bench-meta-table"/.exec(html)[0];
    const labels = { 'bench-count': 'N.º de bancos', 'bench-height': 'Altura de banco (m)', 'bench-face-angle': 'Ángulo de cara (°)',
        'bench-berm-width': 'Ancho de berma (m)', 'bench-base-elevation': 'Cota base (m)',
        'bench-top-platform': 'Plataforma superior (m)', 'bench-floor-length': 'Piso (m)' };
    for (const [id, text] of Object.entries(labels)) {
        const at = group.indexOf(`<label for="${id}">${text}:</label>`);
        assert.ok(at > 0, `label de ${id}`);
        assert.ok(at < group.indexOf(`id="${id}"`), `el label precede a ${id}`);
    }
    assert.equal((group.match(/<label\b/g) || []).length, 8);
    assert.ok(!/<label[^>]*(hidden|display:\s*none)/.test(group), 'ninguno oculto');
});
