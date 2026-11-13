'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TextDecoder, TextEncoder } = require('node:util');
const { loadScripts } = require('./helpers/load.js');

function loadStl() {
    const ctx = loadScripts(['js/importers/stl.js'], { env: 'node', extra: { TextDecoder } });
    return ctx.SimRocas.importers.stl;
}

const enc = new TextEncoder();
function strToBytes(s) { return enc.encode(s); }

function chunkArray(bytes, size) {
    const out = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
    if (out.length === 0) out.push(new Uint8Array(0));
    return out;
}

function assertKindUint32(arr) {
    assert.strictEqual(Object.prototype.toString.call(arr), '[object Uint32Array]');
}
function assertKindFloat32(arr) {
    assert.strictEqual(Object.prototype.toString.call(arr), '[object Float32Array]');
}

function assertSameUint(a, b) {
    assert.strictEqual(a.length, b.length, `length ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i], `idx ${i}`);
}
function assertSameArr(a, b, tol = 0) {
    assert.strictEqual(a.length, b.length, `length ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) {
        if (tol === 0) assert.strictEqual(a[i], b[i], `idx ${i}`);
        else assert.ok(Math.abs(a[i] - b[i]) <= tol, `idx ${i}: ${a[i]} vs ${b[i]}`);
    }
}

// Cubo nominal: 8 esquinas, 12 triángulos (los STL repiten vértices por triángulo).
function cubeVertices() {
    return [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
    ];
}
// 12 triángulos (2 por cara), índices 0..7 en el orden de cubeVertices()
function cubeTriangles() {
    return [
        0, 2, 1, 0, 3, 2, // cara inferior (z=0)
        4, 5, 6, 4, 6, 7, // cara superior (z=1)
        0, 1, 5, 0, 5, 4, // cara y=0
        2, 3, 7, 2, 7, 6, // cara y=1
        1, 2, 6, 1, 6, 5, // cara x=1
        0, 4, 7, 0, 7, 3, // cara x=0
    ];
}

function buildBinaryStl(tris) {
    const n = tris.length / 3;
    const buf = new ArrayBuffer(84 + 50 * n);
    const dv = new DataView(buf);
    for (let i = 0; i < 80; i++) dv.setUint8(i, 32); // cabecera de espacios
    dv.setUint32(80, n, true);
    const verts = cubeVertices();
    let off = 84;
    for (let t = 0; t < n; t++) {
        // normal (0,0,1)
        dv.setFloat32(off, 0, true); dv.setFloat32(off + 4, 0, true); dv.setFloat32(off + 8, 1, true);
        off += 12;
        for (let k = 0; k < 3; k++) {
            const v = verts[tris[t * 3 + k]];
            dv.setFloat32(off, v[0], true);
            dv.setFloat32(off + 4, v[1], true);
            dv.setFloat32(off + 8, v[2], true);
            off += 12;
        }
        dv.setUint16(off, 0, true); off += 2; // attribute
    }
    return new Uint8Array(buf);
}

function buildAsciiStl(tris) {
    const verts = cubeVertices();
    const lines = ['solid cubo'];
    for (let t = 0; t < tris.length / 3; t++) {
        lines.push('facet normal 0 0 1');
        lines.push('outer loop');
        for (let k = 0; k < 3; k++) {
            const v = verts[tris[t * 3 + k]];
            lines.push(`vertex ${v[0]}.0 ${v[1]}.0 ${v[2]}.0`);
        }
        lines.push('endloop');
        lines.push('endfacet');
    }
    lines.push('endsolid cubo');
    return strToBytes(lines.join('\n') + '\n');
}

test('detect: extensión .stl aunque el contenido sea binario', () => {
    const stl = loadStl();
    assert.strictEqual(stl.detect('malla.STL', new Uint8Array(0)), true);
    const bin = buildBinaryStl(cubeTriangles());
    assert.strictEqual(stl.detect('malla.stl', bin.subarray(0, 40)), true);
    const asc = buildAsciiStl(cubeTriangles());
    assert.strictEqual(stl.detect('sinextension', asc.subarray(0, 40)), true); // ASCII por contenido
    assert.strictEqual(stl.detect('escalera.txt', strToBytes('hola que tal')), false);
});

test('binario y ASCII del mismo cubo dan la misma malla', async () => {
    const stl = loadStl();
    const tris = cubeTriangles();
    const resBin = await stl.parse(buildBinaryStl(tris).buffer);
    const resAsc = await stl.parse(buildAsciiStl(tris).buffer);
    assert.strictEqual(resBin.kind, 'mesh');
    assert.strictEqual(resAsc.kind, 'mesh');
    assertKindFloat32(resBin.positions);
    assertKindUint32(resBin.indices);
    assertSameArr(resBin.positions, resAsc.positions);
    assertSameUint(resBin.indices, resAsc.indices);
    for (const res of [resBin, resAsc]) {
        assert.strictEqual(res.stats.triangles, 12);
        assert.strictEqual(res.stats.vertices, 8); // deduplicación: 12 triángulos -> 8 vértices
        assert.strictEqual(res.origin.x, 0);
        assert.strictEqual(res.origin.y, 0);
        assert.strictEqual(res.origin.z, 0);
    }
    assert.strictEqual(resBin.stats.binary, true);
    assert.strictEqual(resAsc.stats.binary, false);
});

test('deduplicación general: triángulos separados comparten índices', async () => {
    const stl = loadStl();
    const tris = cubeTriangles();
    const res = await stl.parse(buildBinaryStl(tris).buffer);
    // cada esquina 0..7 del cubo debe existir EXACTAMENTE una vez en positions
    // (deduplicación) y en coordenada local correcta; el índice depende del
    // orden de primera aparición en el archivo.
    const verts = cubeVertices();
    for (let v = 0; v < 8; v++) {
        let found = 0;
        const local = verts[v];
        for (let p = 0; p < res.positions.length / 3; p++) {
            if (res.positions[p * 3] === local[0] && res.positions[p * 3 + 1] === local[1]
                && res.positions[p * 3 + 2] === local[2]) {
                found++;
                assertSameArr(res.positions.slice(p * 3, p * 3 + 3), new Float32Array(local));
            }
        }
        assert.strictEqual(found, 1, `esquina ${v} aparece ${found} veces`);
    }
    assert.strictEqual(res.positions.length, 8 * 3);
    const idx = res.indices;
    for (let t = 0; t < 12; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        // cada ranura del triángulo debe apuntar a la esquina FILE indical en ese ranura
        const slots = [a, b, c];
        for (let k = 0; k < 3; k++) {
            const v = verts[tris[t * 3 + k]];
            const w = slots[k];
            const px = res.positions[w * 3], py = res.positions[w * 3 + 1], pz = res.positions[w * 3 + 2];
            assert.ok(px === v[0] && py === v[1] && pz === v[2],
                `tri ${t} slot ${k}: índice ${w} no es el vértice ${tris[t * 3 + k]}`);
        }
        assert.ok(a !== b && a !== c && b !== c, `tri ${t}: vértices repetidos en un triángulo`);
    }
    // cada índice debe referenciar una entrada de positions (8 vértices)
    for (let i = 0; i < idx.length; i++) {
        assert.ok(idx[i] < 8, `índice fuera de rango en ${i}`);
    }
});

test('orientación de winding preservada como viene en el archivo', async () => {
    const stl = loadStl();
    const tris = new Uint32Array([0, 1, 2, 2, 1, 3]);
    const res = await stl.parse(buildBinaryStl(tris).buffer);
    const i0 = indexFor(res, 0), i1 = indexFor(res, 1), i2 = indexFor(res, 2), i3 = indexFor(res, 3);
    assertSameUint(res.indices, new Uint32Array([i0, i1, i2, i2, i1, i3]));
});

function indexFor(res, vertIdx) {
    // busca la entrada de positions que coincide con la esquina vertIdx del cubo
    const verts = cubeVertices();
    const target = verts[vertIdx];
    for (let i = 0; i < res.positions.length / 3; i++) {
        if (res.positions[i * 3] === target[0] && res.positions[i * 3 + 1] === target[1]
            && res.positions[i * 3 + 2] === target[2]) return i;
    }
    throw new Error('no encontrado ' + vertIdx);
}

test('upAxis Y convierte (x,y,z) -> (x,-z,y) y el origen es floor del primer vértice', async () => {
    const stl = loadStl();
    const dv = new DataView(new ArrayBuffer(84 + 50));
    dv.setUint32(80, 1, true);
    // normal (84..95, se pone a 0 por ArrayBuffer init)
    // v0 = (1.2, 5.7, 3.9) -> Z arriba igual; v1 = (2.5, 6.1, 4.2); v2 = (0.3, 6.4, 3.1)
    dv.setFloat32(96, 1.2, true); dv.setFloat32(100, 5.7, true); dv.setFloat32(104, 3.9, true);
    dv.setFloat32(108, 2.5, true); dv.setFloat32(112, 6.1, true); dv.setFloat32(116, 4.2, true);
    dv.setFloat32(120, 0.3, true); dv.setFloat32(124, 6.4, true); dv.setFloat32(128, 3.1, true);
    const res = await stl.parse(dv.buffer, { upAxis: 'Y' });
    // (x,y,z) -> (x,-z,y): v0 -> (1.2,-3.9,5.7); origin floor = (1,-4,5)
    assert.strictEqual(res.origin.x, 1);
    assert.strictEqual(res.origin.y, -4);
    assert.strictEqual(res.origin.z, 5);
    assertSameArr(res.positions.slice(0, 3), new Float32Array([0.2, 0.1, 0.7]), 1e-4);
});

test('advertencia Float32: coordenadas UTM > 1e5 en binario', async () => {
    const stl = loadStl();
    const dv = new DataView(new ArrayBuffer(84 + 50));
    dv.setUint32(80, 1, true);
    dv.setFloat32(96, 350123.456, true); dv.setFloat32(100, 6301234.789, true); dv.setFloat32(104, 2504.001, true);
    dv.setFloat32(108, 350130.5, true); dv.setFloat32(112, 6301240.25, true); dv.setFloat32(116, 2505.5, true);
    dv.setFloat32(120, 350120.75, true); dv.setFloat32(124, 6301239.9, true); dv.setFloat32(128, 2503.9, true);
    const res = await stl.parse(dv.buffer);
    assert.strictEqual(res.stats.float32Warning, true);
    assert.strictEqual(res.stats.binary, true);
});

test('sin advertencia Float32 con coordenadas pequeñas', async () => {
    const stl = loadStl();
    const res = await stl.parse(buildBinaryStl(cubeTriangles()).buffer);
    assert.strictEqual(res.stats.float32Warning, false);
});

test('archivo binario truncado -> error en español', async () => {
    const stl = loadStl();
    const full = buildBinaryStl(cubeTriangles());
    const trunc = full.subarray(0, full.length - 37); // falta parte del último triángulo
    await assert.rejects(stl.parse(trunc.slice().buffer), /truncad|incompleto/i);
});

test('streaming: bloques de 1, 7 y 4096 bytes dan la misma malla', async () => {
    const stl = loadStl();
    const bin = buildBinaryStl(cubeTriangles());
    const asc = buildAsciiStl(cubeTriangles());
    const asyncFromChunks = async function* (chunks) {
        for (const c of chunks) yield c;
    };
    const fullBin = await stl.parse(bin.buffer);
    const fullAsc = await stl.parse(asc.buffer);
    for (const size of [1, 7, 4096]) {
        const rBin = await stl.parse(asyncFromChunks(chunkArray(bin, size)));
        const rAsc = await stl.parse(asyncFromChunks(chunkArray(asc, size)));
        assertSameUint(rBin.indices, fullBin.indices);
        assertSameArr(rAsc.positions, fullAsc.positions);
        assertSameUint(rAsc.indices, fullAsc.indices);
        assert.strictEqual(rBin.stats.vertices, fullBin.stats.vertices);
        assert.strictEqual(rAsc.stats.triangles, fullAsc.stats.triangles);
    }
});

test('progreso: onProgress monótono con totalBytes', async () => {
    const stl = loadStl();
    const bin = buildBinaryStl(cubeTriangles());
    let last = -1, calls = 0;
    await stl.parse(bin.buffer, { totalBytes: bin.length }, (f) => {
        assert.ok(f >= last && f >= 0 && f <= 1);
        last = f; calls++;
    });
    assert.ok(calls > 0, 'hubo callbacks');
    assert.ok(last >= 0.99, `última fracción ${last}`);
});

test('entrada no soportada -> error en español', async () => {
    const stl = loadStl();
    await assert.rejects(stl.parse(42), /no soportado/i);
});

test('rendimiento: STL binario de 2M triángulos (~100 MB) en < 15 s', async () => {
    const stl = loadStl();
    const N = 2_000_000;
    const bytes = new Uint8Array(84 + 50 * N);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(80, N, true);
    // grilla de triángulos en abanico: 2M vértices mitad repetidos con seno para no deduplicar
    let off = 84;
    for (let t = 0; t < N; t++) {
        dv.setFloat32(off, 350000 + t * 0.001, true);
        dv.setFloat32(off + 4, 6300000 + (t % 1000) * 0.5, true);
        dv.setFloat32(off + 8, 2500 + (t % 7) * 0.25, true);
        dv.setFloat32(off + 12, 350001 + t * 0.001, true);
        dv.setFloat32(off + 16, 6300001 + (t % 1000) * 0.5, true);
        dv.setFloat32(off + 20, 2501.5, true);
        dv.setFloat32(off + 24, 350002 + t * 0.001, true);
        dv.setFloat32(off + 28, 6300002 + (t % 1000) * 0.5, true);
        dv.setFloat32(off + 32, 2500.75, true);
        off += 50;
    }
    const t0 = process.hrtime.bigint();
    const res = await stl.parse(bytes.buffer);
    const dt = Number(process.hrtime.bigint() - t0) / 1e9;
    assert.strictEqual(res.stats.triangles, N);
    assert.strictEqual(res.stats.binary, true);
    const mb = bytes.length / (1024 * 1024);
    console.log(`[perf STL] ${mb.toFixed(1)} MB en ${dt.toFixed(2)} s = ${(mb / dt).toFixed(1)} MB/s`);
    assert.ok(dt < 15, `parse tardó ${dt.toFixed(2)} s`);
});
