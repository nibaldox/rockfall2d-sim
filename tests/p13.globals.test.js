'use strict';
// P1.3 (correctivo CP13): los <script> clásicos de index.html comparten un solo ámbito global.
// Dos `function` globales con el mismo nombre no dan SyntaxError: gana la última que carga.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BASE = '9232d1fe';
const ROOT = path.join(__dirname, '..');
const SCRIPT = /<script src="(js\/[\w.-]+\.js)\?v=\d+"><\/script>/g;
// Nombres repetidos entre archivos que ya existían en la base: se toleran con su nombre exacto.
const TOLERATED = [];

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const show = file => execFileSync('git', ['show', `${BASE}:${file}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
const scripts = html => [...html.matchAll(SCRIPT)].map(m => m[1]);

// Análisis léxico simple: una declaración de nivel superior empieza en la columna 0
// (el proyecto indenta con 4 espacios todo lo que está dentro de un bloque).
function topLevel(code) {
    const names = new Set();
    for (const m of code.matchAll(/^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    return names;
}

// Mapa nombre -> archivos que lo declaran, solo para los declarados en más de un archivo.
function repeated(files, source) {
    const owners = new Map();
    for (const file of files) {
        for (const name of topLevel(source(file))) owners.set(name, [...(owners.get(name) || []), file]);
    }
    return new Map([...owners].filter(([, list]) => list.length > 1));
}

function loadRealm() {
    const files = scripts(read('index.html'));
    const sandbox = { console: { log() {}, warn() {}, error() {} }, performance };
    sandbox.window = sandbox; sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    const failures = [];
    for (const file of files) {
        try { vm.runInContext(read(file), context, { filename: file }); } catch (err) {
            // Sin DOM, el cableado puede fallar al ejecutar; una colisión léxica (SyntaxError) no se tolera.
            if (err && err.name === 'SyntaxError') failures.push(`${file}: ${err.message}`);
        }
    }
    return { files, context, failures };
}

test('realm único: con todos los scripts de index.html cargados, Simulation.configure rechaza colectores inválidos', () => {
    const { files, context, failures } = loadRealm();
    assert.ok(files.length >= 25, `scripts encontrados: ${files.length}`);
    assert.ok(files.indexOf('js/simulation.js') >= 0 && files.indexOf('js/simulation.js') < files.indexOf('js/stats.js'));
    assert.deepEqual(failures, []);
    const { Simulation, Stats } = context.SimRocas;
    assert.equal(typeof Simulation, 'function');
    assert.equal(typeof Stats, 'function');
    const make = () => new Simulation({}, {});
    const RealmError = vm.runInContext('Error', context);
    const isError = text => err => err instanceof RealmError && err.message.includes(text);

    assert.throws(() => make().configure({ collectors: [{ id: 'a', x: NaN }] }), isError('la X debe ser un número finito'));
    assert.throws(() => make().configure({ collectors: [{ id: 'a', x: 1 }, { id: 'a', x: 2 }] }), isError('está repetido'));
    assert.throws(() => make().setCollectors([{ id: 'a', x: Infinity }]), isError('la X debe ser un número finito'));
    assert.throws(() => make().setCollectors([{ id: 7, x: 1 }, { id: 7, x: 2 }]), isError('está repetido'));

    // Una lista inválida lanza antes de cambiar la configuración.
    const sim = make();
    sim.configure({ collectors: [{ id: 'a', x: 5 }], numRocks: 7 });
    assert.throws(() => sim.configure({ collectors: [{ id: 'b', x: NaN }], numRocks: 9 }), isError('la X'));
    assert.equal(sim.totalRocks, 7);
    // La etiqueta ausente queda vacía en el motor: «Colector <id>» es el relleno de Stats, no el del motor.
    assert.equal(JSON.stringify(sim.collectors), JSON.stringify([{ id: 'a', x: 5, label: '' }]));
});

test('declaraciones globales: ningún nombre de nivel superior se repite entre scripts, salvo los que ya se repetían en la base', () => {
    const files = scripts(read('index.html'));
    const baseFiles = scripts(show('index.html'));
    assert.ok(files.length >= 25 && baseFiles.length >= 25);
    const baseRepeated = repeated(baseFiles, show);
    assert.deepEqual([...baseRepeated.keys()].sort(), [...TOLERATED].sort(), 'la lista de tolerados debe coincidir con los repetidos de la base');

    const fresh = [...repeated(files, read)].filter(([name]) => !TOLERATED.includes(name))
        .map(([name, list]) => `${name}: ${list.join(', ')}`);
    assert.deepEqual(fresh, []);

    // Control: el extractor ve las declaraciones de P1.3 y detecta una repetición sintética.
    assert.ok(topLevel(read('js/simulation.js')).has('sanitizeCollectors'));
    assert.ok(topLevel(read('js/stats.js')).has('sanitizeStatsCollectors'));
    assert.ok(!topLevel(read('js/stats.js')).has('sanitizeCollectors'));
    const fake = { a: 'function same() {}\n    function inner() {}\n', b: 'const same = 1;\nclass Other {}\n    const inner = 2;\n' };
    assert.deepEqual([...repeated(['a', 'b'], file => fake[file])], [['same', ['a', 'b']]]);
});
