'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TextDecoder } = require('node:util');
const { ROOT } = require('./helpers/load.js');
const { loadScripts } = require('./helpers/load.js');
const path = require('node:path');

function loadObj() {
    const ctx = loadScripts(['js/importers/obj.js'], { env: 'node', extra: { TextDecoder } });
    return ctx.SimRocas.importers.obj;
}

function strToBytes(s) {
    return new TextEncoder().encode(s);
}

function chunkArray(bytes, size) {
    if (size <= 0) throw new Error('size');
    const out = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
    if (out.length === 0) out.push(new Uint8Array(0));
    return out;
}

function assertKindUint32(arr) {
    // cross-realm: el realm del sandbox usa su propio Uint32Array
    assert.strictEqual(Object.prototype.toString.call(arr), '[object Uint32Array]');
}

// Comparar Float32Array elemento a elemento (evita cross-realm deepStrictEqual)
function assertSameArr(a, b, tol = 0) {
    assert.strictEqual(a.length, b.length, `length ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) {
        if (tol === 0) {
            assert.strictEqual(a[i], b[i], `idx ${i}`);
        } else {
            assert.ok(Math.abs(a[i] - b[i]) <= tol, `idx ${i}: ${a[i]} vs ${b[i]}`);
        }
    }
}

function assertSameObj(a, b) {
    // cross-realm: comparar campos, no prototipos
    assert.strictEqual(a.x, b.x);
    assert.strictEqual(a.y, b.y);
    assert.strictEqual(a.z, b.z);
}

function assertSameUint(arrA, arrB) {
    assert.strictEqual(arrA.length, arrB.length);
    for (let i = 0; i < arrA.length; i++) assert.strictEqual(arrA[i], arrB[i], `idx ${i}`);
}

test('detect: reconocible por extensión o contenido', () => {
    const obj = loadObj();
    assert.strictEqual(obj.detect('malla.OBJ', new Uint8Array(0)), true);
    assert.strictEqual(obj.detect('foo.txt', strToBytes('v 0 0 0\n')), true);
    assert.strictEqual(obj.detect('foo.txt', strToBytes('f 1 2 3\n')), true);
    assert.strictEqual(obj.detect('foo.txt', strToBytes('hola que tal\n')), false);
});

test('cubo sintético: posiciones, triángulos y stats correctos', async () => {
    const obj = loadObj();
    const src = [
        'v 0 0 0',
        'v 1 0 0',
        'v 1 1 0',
        'v 0 1 0',
        'v 0 0 1',
        'v 1 0 1',
        'v 1 1 1',
        'v 0 1 1',
        'f 3 2 1 4',
        'f 5 6 7 8',
        'f 1 2 6 5',
    ].join('\n');
    const res = await obj.parse(strToBytes(src).buffer);
    assert.strictEqual(res.kind, 'mesh');
    assert.strictEqual(res.upAxis, 'Z');
    assert.strictEqual(res.stats.vertices, 8);
    assert.strictEqual(res.stats.triangles, 6);
    assert.strictEqual(res.stats.skippedFaces, 0);
    assertKindUint32(res.indices);
    // fan del quad 3 2 1 4 (1-based) -> (0-based) [2,1,0], [2,0,3]
    assertSameUint(res.indices.slice(0, 3), new Uint32Array([2, 1, 0]));
    assertSameUint(res.indices.slice(3, 6), new Uint32Array([2, 0, 3]));
    // primer vértice del segundo quad
    assertSameUint(res.indices.slice(6, 9), new Uint32Array([4, 5, 6]));
    assert.strictEqual(res.positions.length, 8 * 3);
    // origen floor del primer vértice
    assert.strictEqual(res.origin.x, 0);
    assert.strictEqual(res.origin.y, 0);
    assert.strictEqual(res.origin.z, 0);
});

test('formatos v/f: a/b/c, a//c, a/b, negativos, extra en v w y colores', async () => {
    const obj = loadObj();
    const src = [
        'v 0 0 0 1.0 1.0 1.0',
        'v 1 0 0 1',
        'v 1 1 0',
        'v 0 0 1',
        'f 1/2/3 2/3/1 3/1/2',
        'f 4//1 1//2 2//3',
        'f -1/1 -2/1 -4/1',
        'f -3 -1 -4',
    ].join('\n');
    const res = await obj.parse(strToBytes(src).buffer);
    assert.strictEqual(res.stats.vertices, 4);
    assert.strictEqual(res.stats.triangles, 4);
    // v2 = (1,0,0) locales respecto origin (0,0,0)
    assertSameArr(res.positions.slice(3, 6), new Float32Array([1, 0, 0]));
    // última cara: -3 -> v1(0), -1 -> v3(2), -4 -> v0... cuidado: 4 vértices, -3=idx1, -1=idx3, -4=idx0
    assertSameUint(res.indices.slice(9, 12), new Uint32Array([1, 3, 0]));
});

test('n-gono de 5 lados se triangula en abanico (3 triángulos)', async () => {
    const obj = loadObj();
    const src = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nf 1 2 3 4 5\n';
    const res = await obj.parse(strToBytes(src).buffer);
    assert.strictEqual(res.stats.triangles, 3);
    assertSameUint(res.indices, new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 4]));
});

test('precisión UTM: origen Float64 y posiciones locales < 1e-3 m', async () => {
    const obj = loadObj();
    const x0 = 350123.456, y0 = 6301234.789, z0 = 2504.001;
    const src = [
        `v ${x0} ${y0} ${z0}`,
        `v ${x0 + 12.5} ${y0 + 3.25} ${z0 + 0.125}`,
        `v ${x0 + 0.5} ${y0 + 8.75} ${z0 + 1.5}`,
        `f 1 2 3`,
    ].join('\n');
    const res = await obj.parse(strToBytes(src).buffer);
    // origen = floor del primer vértice (en coordenadas Z arriba: x, y, z sin cambios con upAxis Z)
    assert.strictEqual(res.origin.x, Math.floor(x0));
    assert.strictEqual(res.origin.y, Math.floor(y0));
    assert.strictEqual(res.origin.z, Math.floor(z0));
    // comparar en Float64 contra world - origin, tolerancia < 1e-3 m
    const world = [[x0, y0, z0], [x0 + 12.5, y0 + 3.25, z0 + 0.125], [x0 + 0.5, y0 + 8.75, z0 + 1.5]];
    for (let i = 0; i < 3; i++) {
        for (let k = 0; k < 3; k++) {
            const localF64 = world[i][k] - res.origin[['x', 'y', 'z'][k]];
            const f32 = res.positions[i * 3 + k];
            assert.ok(Math.abs(f32 - localF64) < 1e-3,
                `v${i} comp${k}: ${f32} vs ${localF64}`);
        }
    }
});

test('streaming: bloques de 1, 7 y 4096 bytes dan resultados idénticos', async () => {
    const obj = loadObj();
    // archivo con líneas largas y mucha basura de encabezado para partir líneas
    let src = '# comentario largo para forzar partidas '.repeat(10) + '\n';
    for (let i = 0; i < 50; i++) {
        src += `v ${i}.125 ${1000 + i}.5 ${2000 + i}.75\n`;
        src += 'vn 0 0 1\nvt 0.1 0.2\n';
        if (i % 3 === 2) src += `f ${i + 1} ${i} ${Math.max(1, i - 1)}\n`;
    }
    src += '\n';
    const bytes = strToBytes(src);
    const asyncFromChunks = async function* (chunks) {
        for (const c of chunks) yield c;
    };
    const full = await obj.parse(strToBytes(src).buffer);
    for (const size of [1, 7, 4096]) {
        const res = await obj.parse(asyncFromChunks(chunkArray(bytes, size)));
        assertSameArr(res.positions, full.positions);
        assertSameUint(res.indices, full.indices);
        assert.deepStrictEqual(res.origin, full.origin);
        assert.strictEqual(res.stats.vertices, full.stats.vertices);
        assert.strictEqual(res.stats.triangles, full.stats.triangles);
        assert.strictEqual(res.stats.skippedFaces, full.stats.skippedFaces);
    }
});

test('upAxis Y convierte (x,y,z) -> (x,-z,y)', async () => {
    const obj = loadObj();
    const src = 'v 1 2 3\nv 4 5 6\nv 7 8 9\nf 1 2 3\n';
    const res = await obj.parse(strToBytes(src).buffer, { upAxis: 'Y' });
    // v1: (1,2,3) -> (1,-3,2); origin floor primer vértice ya convertido = (1,-3,2)
    assertSameObj(res.origin, { x: 1, y: -3, z: 2 });
    assertSameArr(res.positions.slice(0, 3), new Float32Array([0, 0, 0]));
    assertSameArr(res.positions.slice(3, 6), new Float32Array([3, -3, 3]));
    assertSameArr(res.positions.slice(6, 9), new Float32Array([6, -6, 6]));
});

test('progreso: onProgress llamado, creciente, llega a ~1 con totalBytes', async () => {
    const obj = loadObj();
    const bytes = strToBytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    let last = -1, calls = 0;
    const res = await obj.parse(bytes.buffer, { totalBytes: bytes.length }, (f) => {
        assert.ok(f >= last, 'progreso monótono');
        assert.ok(f >= 0 && f <= 1, 'fracción en rango');
        last = f; calls++;
    });
    assert.ok(calls > 0, 'hubo callbacks');
    assert.ok(last >= 0.99, `última fracción ${last}`);
    assert.strictEqual(res.stats.triangles, 1);
});

test('caras con índices fuera de rango -> skippedFaces, no lanza', async () => {
    const obj = loadObj();
    const src = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 99\nf 0 2 3\nf 1 2 -99\nf 1 2 3\n';
    const res = await obj.parse(strToBytes(src).buffer);
    assert.strictEqual(res.stats.triangles, 2);
    assert.strictEqual(res.stats.skippedFaces, 3);
});

test('sin vértices o sin caras -> error en español', async () => {
    const obj = loadObj();
    await assert.rejects(obj.parse(strToBytes('# solo comentario\n').buffer),
        /no contiene una malla de triángulos válida/);
    await assert.rejects(obj.parse(strToBytes('v 0 0 0\nv 1 0 0\n').buffer),
        /no contiene una malla de triángulos válida/);
    await assert.rejects(obj.parse(strToBytes('# comentario\n# otro\n').buffer),
        /no contiene una malla de triángulos válida/);
});

test('CRLF y líneas vacías se manejan correctamente', async () => {
    const obj = loadObj();
    const res = await obj.parse(strToBytes('v 0 0 0\r\n\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n').buffer);
    assert.strictEqual(res.stats.vertices, 3);
    assert.strictEqual(res.stats.triangles, 1);
});

test('rendimiento: grilla 600x600 (~360k vértices) parsea en < 10 s', async () => {
    const obj = loadObj();
    const N = 600;
    let src = '';
    const chunks = [];
    const stepDeg = 11; // step que rompe la alineación Float32 para simular UTM
    const X0 = 350000.0, Y0 = 6300000.0, Z0 = 2500.0;
    const push = (s) => chunks.push(s);
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            push(`v ${(X0 + i * 0.25).toFixed(3)} ${(Y0 + j * 0.5).toFixed(3)} ${(Z0 + ((i * 7 + j * 13) % 100) * 0.01).toFixed(2)}\n`);
        }
    }
    for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
            const a = j * N + i + 1;
            push(`f ${a} ${a + 1} ${a + N}\nf ${a + 1} ${a + N + 1} ${a + N}\n`);
        }
    }
    src = chunks.join('');
    const bytes = strToBytes(src);
    const totalMB = bytes.length / (1024 * 1024);
    const totalBytes = bytes.length;
    const t0 = process.hrtime.bigint();
    const res = await obj.parse(bytes.buffer, { totalBytes }, null);
    const dt = Number(process.hrtime.bigint() - t0) / 1e9;
    assert.strictEqual(res.stats.vertices, N * N);
    assert.strictEqual(res.stats.triangles, (N - 1) * (N - 1) * 2);
    console.log(`[perf OBJ] ${totalMB.toFixed(1)} MB en ${dt.toFixed(2)} s = ${(totalMB / dt).toFixed(1)} MB/s`);
    assert.ok(dt < 10, `parse tardó ${dt.toFixed(2)} s`);
});
