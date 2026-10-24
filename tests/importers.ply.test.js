'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TextDecoder, TextEncoder } = require('node:util');
const { loadScripts } = require('./helpers/load.js');

function loadPly() {
    const ctx = loadScripts(['js/importers/ply.js'], { env: 'node', extra: { TextDecoder } });
    return ctx.SimRocas.importers.ply;
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

// Cubo 8 vértices, caras de 4 lados (quad) -> 12 triángulos en abanico
const CUBE_VERTS = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const CUBE_FACES = [
    [0, 1, 2, 3], // z=0
    [4, 5, 6, 7], // z=1
    [0, 1, 5, 4], // y=0
    [2, 3, 7, 6], // y=1
    [1, 2, 6, 5], // x=1
    [0, 4, 7, 3], // x=0
];

function buildAsciiPly() {
    const lines = [
        'ply',
        'format ascii 1.0',
        'comment cubo de prueba',
        'element vertex 8',
        'property float x',
        'property float y',
        'property float z',
        'element face 6',
        'property list uchar int vertex_indices',
        'end_header',
    ];
    for (const v of CUBE_VERTS) lines.push(`${v[0]}.0 ${v[1]}.0 ${v[2]}.0`);
    for (const f of CUBE_FACES) lines.push('4 ' + f.join(' '));
    return strToBytes(lines.join('\n') + '\n');
}

function buildBinaryPly(props) {
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        'element vertex 8',
        'property float x',
        'property float y',
        'property float z',
        ...(props.extra ? props.extra.map(e => e.decl) : []),
        'element face 6',
        'property list uchar int vertex_indices',
        'end_header',
    ].join('\n') + '\n';
    const head = strToBytes(header);
    const perVert = props.extra
        ? props.extra.reduce((sum, e) => sum + (e.type === 'float' ? 4 : 1), 0)
        : 0;
    const bodyLen = 8 * (12 + perVert) + 6 * (1 + 4 * 4);
    const buf = new ArrayBuffer(head.length + bodyLen);
    const dv = new DataView(buf);
    new Uint8Array(buf).set(head, 0);
    let off = head.length;
    for (let i = 0; i < 8; i++) {
        const v = CUBE_VERTS[i];
        dv.setFloat32(off, v[0], true); dv.setFloat32(off + 4, v[1], true); dv.setFloat32(off + 8, v[2], true);
        off += 12;
        for (const e of (props.extra || [])) {
            const val = e.value !== undefined ? e.value : 100;
            if (e.type === 'float') {
                dv.setFloat32(off, val, true);
                off += 4;
            } else { // uchar
                dv.setUint8(off, val);
                off += 1;
            }
        }
    }
    for (const f of CUBE_FACES) {
        dv.setUint8(off, 4); off += 1;
        for (const k of f) { dv.setInt32(off, k, true); off += 4; }
    }
    return new Uint8Array(buf);
}

function cubeCheck(res) {
    assert.strictEqual(res.kind, 'mesh');
    assertKindFloat32(res.positions);
    assertKindUint32(res.indices);
    assert.strictEqual(res.stats.vertices, 8);
    assert.strictEqual(res.stats.triangles, 12);
    assert.strictEqual(res.positions.length, 24);
    assert.strictEqual(res.origin.x, 0);
    assert.strictEqual(res.origin.y, 0);
    assert.strictEqual(res.origin.z, 0);
    // 12 triángulos: cada quad de 4 -> 2 en abanico
    assertSameUint(res.indices.slice(0, 3), new Uint32Array([0, 1, 2]));
    assertSameUint(res.indices.slice(3, 6), new Uint32Array([0, 2, 3]));
    // vértices locales en orden
    for (let v = 0; v < 8; v++) {
        assertSameArr(res.positions.slice(v * 3, v * 3 + 3), new Float32Array(CUBE_VERTS[v]));
    }
}

test('detect: extensión .ply o cabecera ply', () => {
    const ply = loadPly();
    assert.strictEqual(ply.detect('malla.PLY', new Uint8Array(0)), true);
    assert.strictEqual(ply.detect('sinext', strToBytes('ply\nformat ascii 1.0\n')), true);
    assert.strictEqual(ply.detect('foo.txt', strToBytes('v 0 0 0\n')), false);
});

test('ascii: cubo con quads en abanico', async () => {
    const ply = loadPly();
    const res = await ply.parse(buildAsciiPly().buffer);
    cubeCheck(res);
});

test('binario little endian: cubo equivalente al ascii', async () => {
    const ply = loadPly();
    const resBin = await ply.parse(buildBinaryPly({ extra: [] }).buffer);
    const resAsc = await ply.parse(buildAsciiPly().buffer);
    cubeCheck(resBin);
    assertSameArr(resBin.positions, resAsc.positions);
    assertSameUint(resBin.indices, resAsc.indices);
});

test('binario: propiedades extra (nx, ny, nz, red, green, blue, alpha) se saltan', async () => {
    const ply = loadPly();
    const resBin = await ply.parse(buildBinaryPly({
        extra: [
            { decl: 'property float nx', type: 'float', value: 0 },
            { decl: 'property float ny', type: 'float', value: 0 },
            { decl: 'property float nz', type: 'float', value: 1 },
            { decl: 'property uchar red', type: 'uchar', value: 255 },
            { decl: 'property uchar green', type: 'uchar', value: 128 },
            { decl: 'property uchar blue', type: 'uchar', value: 64 },
            { decl: 'property uchar alpha', type: 'uchar', value: 32 },
        ],
    }).buffer);
    cubeCheck(resBin);
});

test('ascii: propiedades extra se saltan', async () => {
    const ply = loadPly();
    const lines = [
        'ply', 'format ascii 1.0',
        'element vertex 8',
        'property float x', 'property float y', 'property float z',
        'property float nx', 'property float ny', 'property float nz',
        'property uchar red', 'property uchar green', 'property uchar blue', 'property uchar alpha',
        'element face 6',
        'property list uchar int vertex_indices',
        'end_header',
    ];
    for (const v of CUBE_VERTS) lines.push(`${v[0]}.0 ${v[1]}.0 ${v[2]}.0 0 0 1 255 128 64 32`);
    for (const f of CUBE_FACES) lines.push('4 ' + f.join(' '));
    const res = await ply.parse(strToBytes(lines.join('\n') + '\n').buffer);
    cubeCheck(res);
});

test('lista de caras con vertex_index (alias) y tipos cortos', async () => {
    const ply = loadPly();
    const lines = [
        'ply', 'format ascii 1.0',
        'element vertex 3',
        'property double x', 'property double y', 'property double z',
        'element face 1',
        'property list uint8 int32 vertex_index',
        'end_header',
        '0 0 0', '1 0 0', '0 1 0',
        '3 0 1 2',
    ];
    const res = await ply.parse(strToBytes(lines.join('\n') + '\n').buffer);
    assert.strictEqual(res.stats.vertices, 3);
    assert.strictEqual(res.stats.triangles, 1);
    assertSameUint(res.indices, new Uint32Array([0, 1, 2]));
});

test('precisión UTM: doubles leídos en Float64 sin pérdida', async () => {
    const ply = loadPly();
    const x0 = 350123.456, y0 = 6301234.789, z0 = 2504.001;
    const lines = [
        'ply', 'format ascii 1.0',
        'element vertex 3',
        'property double x', 'property double y', 'property double z',
        'element face 1',
        'property list uchar int vertex_indices',
        'end_header',
        `${x0} ${y0} ${z0}`,
        `${x0 + 12.5} ${y0 + 3.25} ${z0 + 0.125}`,
        `${x0 + 0.5} ${y0 + 8.75} ${z0 + 1.5}`,
        '3 0 1 2',
    ];
    const res = await ply.parse(strToBytes(lines.join('\n') + '\n').buffer);
    assert.strictEqual(res.origin.x, Math.floor(x0));
    assert.strictEqual(res.origin.y, Math.floor(y0));
    assert.strictEqual(res.origin.z, Math.floor(z0));
    const world = [[x0, y0, z0], [x0 + 12.5, y0 + 3.25, z0 + 0.125], [x0 + 0.5, y0 + 8.75, z0 + 1.5]];
    for (let i = 0; i < 3; i++) {
        for (let k = 0; k < 3; k++) {
            const localF64 = world[i][k] - res.origin[['x', 'y', 'z'][k]];
            assert.ok(Math.abs(res.positions[i * 3 + k] - localF64) < 1e-3,
                `v${i} comp${k}: ${res.positions[i * 3 + k]} vs ${localF64}`);
        }
    }
});

test('binario con doubles UTM: sin pérdida (< 1e-3 m)', async () => {
    const ply = loadPly();
    const x0 = 350123.456, y0 = 6301234.789, z0 = 2504.001;
    const header = [
        'ply', 'format binary_little_endian 1.0',
        'element vertex 3',
        'property double x', 'property double y', 'property double z',
        'element face 1',
        'property list uchar int vertex_indices',
        'end_header',
    ].join('\n') + '\n';
    const head = strToBytes(header);
    const buf = new ArrayBuffer(head.length + 3 * 24 + 1 + 12);
    const dv = new DataView(buf);
    new Uint8Array(buf).set(head, 0);
    let off = head.length;
    const world = [[x0, y0, z0], [x0 + 12.5, y0 + 3.25, z0 + 0.125], [x0 + 0.5, y0 + 8.75, z0 + 1.5]];
    for (const v of world) {
        dv.setFloat64(off, v[0], true); dv.setFloat64(off + 8, v[1], true); dv.setFloat64(off + 16, v[2], true);
        off += 24;
    }
    dv.setUint8(off, 3); off += 1;
    dv.setInt32(off, 0, true); dv.setInt32(off + 4, 1, true); dv.setInt32(off + 8, 2, true);
    const res = await ply.parse(new Uint8Array(buf).buffer);
    assert.strictEqual(res.origin.x, Math.floor(x0));
    for (let i = 0; i < 3; i++) {
        for (let k = 0; k < 3; k++) {
            const localF64 = world[i][k] - res.origin[['x', 'y', 'z'][k]];
            assert.ok(Math.abs(res.positions[i * 3 + k] - localF64) < 1e-3,
                `v${i} comp${k}: ${res.positions[i * 3 + k]} vs ${localF64}`);
        }
    }
});

test('big endian -> error claro en español', async () => {
    const ply = loadPly();
    const bytes = strToBytes('ply\nformat binary_big_endian 1.0\nend_header\n');
    await assert.rejects(ply.parse(bytes.buffer), /big.?endian/i);
});

test('streaming: bloques de 1, 7 y 4096 bytes dan la misma malla (ascii y binario)', async () => {
    const ply = loadPly();
    const asc = buildAsciiPly();
    const bin = buildBinaryPly({ extra: [] });
    const asyncFromChunks = async function* (chunks) {
        for (const c of chunks) yield c;
    };
    for (const size of [1, 7, 4096]) {
        const rAsc = await ply.parse(asyncFromChunks(chunkArray(asc, size)));
        const rBin = await ply.parse(asyncFromChunks(chunkArray(bin, size)));
        assertSameUint(rAsc.indices, rBin.indices);
        assertSameArr(rAsc.positions, rBin.positions);
        assert.strictEqual(rAsc.stats.triangles, 12);
        assert.strictEqual(rBin.stats.vertices, 8);
    }
});

test('upAxis Y convierte (x,y,z) -> (x,-z,y)', async () => {
    const ply = loadPly();
    const lines = [
        'ply', 'format ascii 1.0',
        'element vertex 3',
        'property float x', 'property float y', 'property float z',
        'element face 1',
        'property list uchar int vertex_indices',
        'end_header',
        '1 2 3', '4 5 6', '7 8 9',
        '3 0 1 2',
    ];
    const res = await ply.parse(strToBytes(lines.join('\n') + '\n').buffer, { upAxis: 'Y' });
    // v0: (1,2,3) -> (1,-3,2); origin floor primer vértice ya convertido
    assert.strictEqual(res.origin.x, 1);
    assert.strictEqual(res.origin.y, -3);
    assert.strictEqual(res.origin.z, 2);
    assertSameArr(res.positions.slice(0, 3), new Float32Array([0, 0, 0]));
    assertSameArr(res.positions.slice(3, 6), new Float32Array([3, -3, 3]));
    assertSameArr(res.positions.slice(6, 9), new Float32Array([6, -6, 6]));
});

test('progreso: onProgress monótono con totalBytes', async () => {
    const ply = loadPly();
    const bytes = buildAsciiPly();
    let last = -1, calls = 0;
    await ply.parse(bytes.buffer, { totalBytes: bytes.length }, (f) => {
        assert.ok(f >= last && f >= 0 && f <= 1);
        last = f; calls++;
    });
    assert.ok(calls > 0, 'hubo callbacks');
    assert.ok(last >= 0.99, `última fracción ${last}`);
});

test('sin vértices -> error en español; entrada no soportada -> error', async () => {
    const ply = loadPly();
    await assert.rejects(ply.parse(strToBytes('ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nend_header\n').buffer),
        /no contiene una malla de triángulos válida/);
    await assert.rejects(ply.parse(42), /no soportado/i);
});

test('rendimiento: PLY binario con 500k vértices + 1M triángulos en < 10 s', async () => {
    const ply = loadPly();
    const V = 500000;
    const F = 1000000;
    const header = [
        'ply', 'format binary_little_endian 1.0',
        'element vertex ' + V,
        'property float x', 'property float y', 'property float z',
        'element face ' + F,
        'property list uchar int vertex_indices',
        'end_header',
    ].join('\n') + '\n';
    const head = strToBytes(header);
    const buf = new ArrayBuffer(head.length + V * 12 + F * 13);
    const dv = new DataView(buf);
    new Uint8Array(buf).set(head, 0);
    let off = head.length;
    for (let i = 0; i < V; i++) {
        dv.setFloat32(off, 350000 + (i % 700) * 0.25, true);
        dv.setFloat32(off + 4, 6300000 + (i % 700) * 0.5, true);
        dv.setFloat32(off + 8, 2500 + ((i * 7 + (i % 3) * 13) % 100) * 0.01, true);
        off += 12;
    }
    for (let f = 0; f < F; f++) {
        const a = (f * 2) % V;
        dv.setUint8(off, 3); off += 1;
        dv.setInt32(off, a, true); dv.setInt32(off + 4, (a + 1) % V, true); dv.setInt32(off + 8, (a + 2) % V, true);
        off += 12;
    }
    const t0 = process.hrtime.bigint();
    const res = await ply.parse(new Uint8Array(buf).buffer);
    const dt = Number(process.hrtime.bigint() - t0) / 1e9;
    assert.strictEqual(res.stats.vertices, V);
    assert.strictEqual(res.stats.triangles, F);
    const mb = buf.byteLength / (1024 * 1024);
    console.log(`[perf PLY] ${mb.toFixed(1)} MB en ${dt.toFixed(2)} s = ${(mb / dt).toFixed(1)} MB/s`);
    assert.ok(dt < 10, `parse tardó ${dt.toFixed(2)} s`);
});
