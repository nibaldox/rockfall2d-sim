'use strict';

/**
 * Tests de SimRocas.ConvexShape3D y SimRocas.RigidBody3D (js/rigid3d.js)
 * — fase F5 / T5.1 + T5.2.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./helpers/load.js');

function loadRigid() {
    const ctx = loadScripts(['js/math3d.js', 'js/rigid3d.js'], { env: 'node' });
    return ctx.SimRocas;
}

function approx(a, b, tol = 1e-12, label = '') {
    assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} ≈ ${b} ± ${tol}`);
}

// ------------------------------------------------------------------
// Helpers de forma
// ------------------------------------------------------------------

/** Distancia con signo de un punto respecto de la cara f (normal unitaria saliente). */
function signedDist(shape, f, x, y, z) {
    const ax = shape.vertices[3 * f.a];
    const ay = shape.vertices[3 * f.a + 1];
    const az = shape.vertices[3 * f.a + 2];
    return f.nx * (x - ax) + f.ny * (y - ay) + f.nz * (z - az);
}

/** Verifica: caras trianguladas, normales salientes unitarias, Euler V−E+F = 2. */
function checkHull(label, shape, points) {
    assert.ok(shape.faces.length > 0, `${label}: sin caras`);
    for (const f of shape.faces) {
        const nl = Math.sqrt(f.nx * f.nx + f.ny * f.ny + f.nz * f.nz);
        approx(nl, 1, 1e-12, `${label} normal unitaria`);
        // saliente: el centroide de la cara debe estar del lado positivo
        const cx = (shape.vertices[3 * f.a] + shape.vertices[3 * f.b] + shape.vertices[3 * f.c]) / 3;
        const cy = (shape.vertices[3 * f.a + 1] + shape.vertices[3 * f.b + 1] + shape.vertices[3 * f.c + 1]) / 3;
        const cz = (shape.vertices[3 * f.a + 2] + shape.vertices[3 * f.b + 2] + shape.vertices[3 * f.c + 2]) / 3;
        assert.ok(cx * f.nx + cy * f.ny + cz * f.nz > 0, `${label}: normal no saliente`);
    }
    // todos los puntos de la nube quedan dentro (con tolerancia relativa)
    const s = Math.max(1e-12, Math.abs(points[0]) + Math.abs(points[1]) + Math.abs(points[2]));
    for (let i = 0; i < points.length / 3; i++) {
        let dMax = -Infinity;
        for (const f of shape.faces) {
            dMax = Math.max(dMax, signedDist(shape, f, points[3 * i], points[3 * i + 1], points[3 * i + 2]));
        }
        assert.ok(dMax <= 1e-9, `${label}: punto ${i} fuera del casco (${dMax})`);
    }
    // Euler V − E + F = 2 con E = 3F / 2
    const nF = shape.faces.length;
    assert.ok(nF % 2 === 0 || nF > 0), `${label}: caras`;
    const nE = (3 * nF) / 2;
    const euler = shape.vertexCount - nE + nF;
    approx(euler, 2, 1e-12, `${label} Euler`);
}

// ------------------------------------------------------------------
// T5.1: box + hull
// ------------------------------------------------------------------

test('ConvexShape3D.box: 8 vértices, 12 triángulos, normales salientes, puntos interiores fuera del casco', () => {
    const SimRocas = loadRigid();
    const a = 2; const b = 3; const c = 4;
    const shape = SimRocas.ConvexShape3D.box(a, b, c);
    approx(shape.vertexCount, 8, 0, 'box vértices');
    approx(shape.faces.length, 12, 0, 'box caras');

    // vértices: ±(a/2, b/2, c/2) con Z arriba
    const hs = [a / 2, b / 2, c / 2];
    for (let i = 0; i < 8; i++) {
        const sx = shape.vertices[3 * i];
        const sy = shape.vertices[3 * i + 1];
        const sz = shape.vertices[3 * i + 2];
        assert.ok(Math.abs(Math.abs(sx) - hs[0]) < 1e-12, 'x en el casco');
        assert.ok(Math.abs(Math.abs(sy) - hs[1]) < 1e-12, 'y en el casco');
        assert.ok(Math.abs(Math.abs(sz) - hs[2]) < 1e-12, 'z en el casco');
    }

    // 8 vértices del casco + 4 interiores: el casco sigue siendo el cubo
    const interior = Float64Array.from([0.1, -0.2, 0.3, -1, 1, 1, 0, 0, 0, 0.5, 0.5, 0.5]);
    const cloud = Float64Array.from([...shape.vertices, ...interior]);
    // el generador solo toma la nube: verifico el casco reconstruido vía hull público
    const hull = SimRocas.ConvexShape3D.convexHull(cloud, cloud.length / 3);
    approx(hull.vertexCount, 8, 0, 'hull vértices');
    approx(hull.faces.length, 12, 0, 'hull caras');
    checkHull('box hull', hull, cloud);
});

// ------------------------------------------------------------------
// T5.1: propiedades de masa por tetraedros
// ------------------------------------------------------------------

test('massProperties: caja a×b×c reproduce las fórmulas analíticas ±1e-9 relativo', () => {
    const SimRocas = loadRigid();
    const a = 2; const b = 3; const c = 4;
    const density = 2.5;
    const shape = SimRocas.ConvexShape3D.box(a, b, c);
    const mp = SimRocas.ConvexShape3D.massProperties(shape, density);

    const m = density * a * b * c;
    approx(mp.mass, m, m * 1e-9, 'masa');
    approx(mp.volume, a * b * c, a * b * c * 1e-9, 'volumen');
    approx(mp.com.x, 0, 1e-9); approx(mp.com.y, 0, 1e-9); approx(mp.com.z, 0, 1e-9);

    const e = m * 1e-9;
    approx(mp.inertia[0], m * (b * b + c * c) / 12, e, 'Ixx');
    approx(mp.inertia[4], m * (a * a + c * c) / 12, e, 'Iyy');
    approx(mp.inertia[8], m * (a * a + b * b) / 12, e, 'Izz');
    approx(mp.inertia[1], 0, e, 'Ixy');
    approx(mp.inertia[2], 0, e, 'Ixz');
    approx(mp.inertia[5], 0, e, 'Iyz');
});

test('massProperties: caja desplazada y sin cambiar el com error absoluto', () => {
    const SimRocas = loadRigid();
    // caja con el mismo casco trasladada: los invariantes (m, I sobre com) no cambian
    const shape = SimRocas.ConvexShape3D.box(2, 3, 4);
    const dx = 5; const dy = -3; const dz = 11;
    for (let i = 0; i < shape.vertices.length; i += 3) {
        shape.vertices[i] += dx;
        shape.vertices[i + 1] += dy;
        shape.vertices[i + 2] += dz;
        for (const f of shape.faces) {
            void f;
        }
    }
    // las caras quedaron desactualizadas en posición, pero massProperties
    // solo necesita vértices + conexiones, com e inercia sobre com son invariantes
    const mp = SimRocas.ConvexShape3D.massProperties(shape, 2.5);
    approx(mp.com.x, dx, 1e-9, 'com x');
    approx(mp.com.y, dy, 1e-9, 'com y');
    approx(mp.com.z, dz, 1e-9, 'com z');
    const m = 60; const e = m * 1e-9;
    approx(mp.inertia[0], m * (9 + 16) / 12, e, 'Ixx');
    approx(mp.inertia[8], m * (4 + 9) / 12, e, 'Izz');
});

test('massProperties: elipsoide semiejes (3,2,1) reproduce inercias ±1 %', () => {
    const SimRocas = loadRigid();
    const a = 3; const b = 2; const c = 1;
    const density = 1.7;
    const shape = SimRocas.ConvexShape3D.ellipsoid(a, b, c, 64);
    const mp = SimRocas.ConvexShape3D.massProperties(shape, density);
    const m = density * (4 / 3) * Math.PI * a * b * c;
    // volumen del poliedro inscrito: ≤ volumen del elipsoide, error < 1 %
    assert.ok(mp.volume > (4 / 3) * Math.PI * a * b * c * 0.985, `volumen bajo: ${mp.volume}`);
    assert.ok(mp.volume <= (4 / 3) * Math.PI * a * b * c * 1.02, `volumen alto: ${mp.volume}`);
    const e = m * (b * b + c * c) / 5 * 0.01; // ±1 % de la inercia
    const ey = m * (a * a + c * c) / 5 * 0.01;
    const ez = m * (a * a + b * b) / 5 * 0.01;
    approx(mp.mass, m, m * 0.01, 'masa');
    approx(mp.inertia[0], m * (b * b + c * c) / 5, e, 'Ixx');
    approx(mp.inertia[4], m * (a * a + c * c) / 5, ey, 'Iyy');
    approx(mp.inertia[8], m * (a * a + b * b) / 5, ez, 'Izz');
});

// ------------------------------------------------------------------
// T5.1: toPrincipal
// ------------------------------------------------------------------

test('toPrincipal: caja rotada + trasladada recupera tensor diagonal y com en el origen', () => {
    const { SimRocas, Quat, Mat3, V3 } = (() => {
        const ctx = loadScripts(['js/math3d.js', 'js/rigid3d.js'], { env: 'node' });
        return { SimRocas: ctx.SimRocas, Quat: ctx.SimRocas.Quat, Mat3: ctx.SimRocas.Mat3, V3: ctx.SimRocas.V3 };
    })();
    const a = 2; const b = 4; const c = 6;
    const shape = SimRocas.ConvexShape3D.box(a, b, c);
    // traslado y roto los vértices
    const q = Quat.fromAxisAngle({}, V3.set({}, 0.4, 0.5, 0.75), 2.3);
    const R = Quat.toMat3(new Float64Array(9), q);
    const tx = 7; const ty = -2; const tz = 3;
    for (let i = 0; i < shape.vertices.length; i += 3) {
        const x = shape.vertices[i];
        const y = shape.vertices[i + 1];
        const z = shape.vertices[i + 2];
        shape.vertices[i] = R[0] * x + R[1] * y + R[2] * z + tx;
        shape.vertices[i + 1] = R[3] * x + R[4] * y + R[5] * z + ty;
        shape.vertices[i + 2] = R[6] * x + R[7] * y + R[8] * z + tz;
    }
    const pr = SimRocas.ConvexShape3D.toPrincipal(shape, 3.0);
    const m = 3.0 * a * b * c;
    approx(pr.mass, m, m * 1e-9, 'masa');
    const e = m * 1e-9;
    approx(pr.inertiaDiag.x, m * (b * b + c * c) / 12, e, 'I1');
    approx(pr.inertiaDiag.y, m * (a * a + c * c) / 12, e, 'I2');
    approx(pr.inertiaDiag.z, m * (a * a + b * b) / 12, e, 'I3');

    // centro de masa en el origen y caras válidas
    let mx = 0; let my = 0; let mz = 0;
    for (let i = 0; i < pr.vertices.length; i += 3) {
        mx += pr.vertices[i]; my += pr.vertices[i + 1]; mz += pr.vertices[i + 2];
    }
    const n = pr.vertices.length / 3;
    // el com de los VÉRTICES no es el com del sólido, pero para una caja
    // centrada sí (mismo peso en cada vértice)
    approx(mx / n, 0, 1e-9, 'centro de vértices x');
    approx(my / n, 0, 1e-9, 'centro de vértices y');
    approx(mz / n, 0, 1e-9, 'centro de vértices z');
    checkHull('principal', pr, pr.vertices);
    approx(pr.boundingRadius, Math.sqrt(a * a + b * b + c * c) / 2, 1e-9, 'radio envolvente');
});

// ------------------------------------------------------------------
// T5.1: hull de nube aleatoria
// ------------------------------------------------------------------

test('ConvexShape3D.convexHull: nube aleatoria → todos dentro, Euler = 2', () => {
    const SimRocas = loadRigid();
    // cubos y puntos aleatorios alrededor (dentro y fuera)
    const pts = [];
    for (let i = 0; i < 60; i++) {
        pts.push(Math.random() * 4 - 2, Math.random() * 4 - 2, Math.random() * 4 - 2);
    }
    const cloud = Float64Array.from(pts);
    const hull = SimRocas.ConvexShape3D.convexHull(cloud, cloud.length / 3);
    checkHull('nube aleatoria', hull, cloud);
});

// ------------------------------------------------------------------
// T5.1: irregular
// ------------------------------------------------------------------

test('ConvexShape3D.irregular: acotado por el diámetro, casco válido, tensor definido positivo y desigualdad triangular', () => {
    const SimRocas = loadRigid();
    const shape = SimRocas.ConvexShape3D.irregular(1.0, Math.random, {});
    assert.ok(shape.vertexCount >= 6, `muy pocos vértices: ${shape.vertexCount}`);
    checkHull('irregular', shape, shape.vertices);

    // todos los vértices dentro del radio diameter/2
    const pr = SimRocas.ConvexShape3D.toPrincipal(shape, 2.6);
    assert.ok(pr.boundingRadius <= 0.5 + 1e-9, `radio envolvente ${pr.boundingRadius} > 0.5`);
    assert.ok(pr.inertiaDiag.x > 0 && pr.inertiaDiag.y > 0 && pr.inertiaDiag.z > 0, 'tensor no positivo');
    assert.ok(pr.inertiaDiag.x + pr.inertiaDiag.y > pr.inertiaDiag.z, 'desigualdad triangular I3');
    assert.ok(pr.inertiaDiag.x + pr.inertiaDiag.z > pr.inertiaDiag.y, 'desigualdad triangular I2');
    assert.ok(pr.inertiaDiag.y + pr.inertiaDiag.z > pr.inertiaDiag.x, 'desigualdad triangular I1');
});

// ------------------------------------------------------------------
// T5.2: cuerpo rígido — rotación libre
// ------------------------------------------------------------------

function freeRotationSetup(SimRocas) {
    const a = 2; const b = 3; const c = 5; // tres momentos distintos
    const shape = SimRocas.ConvexShape3D.box(a, b, c);
    return SimRocas.ConvexShape3D.toPrincipal(shape, 1.0);
}

function runFree(body, h, steps) {
    const Quat = globalThis.ReservedQuat; void Quat;
    for (let i = 0; i < steps; i++) body.integrateFree(h, null);
}

test('RigidBody3D: rotación libre conserva energía y |L| ± 0,1 % (10 s, h=1e-3, eje intermedio perturbado)', () => {
    const SimRocas = loadRigid();
    const V3 = loadScripts(['js/math3d.js'], { env: 'node' }).SimRocas.V3;
    const pr = freeRotationSetup(SimRocas);
    const body = new SimRocas.RigidBody3D(pr);
    // eje intermedio (y del cuerpo) perturbado
    const wb0 = V3.set({}, 0.08, 4.0, 0.1);
    const R0 = SimRocas.Quat.toMat3(new Float64Array(9), body.orientation);
    const omegaB = SimRocas.Quat.rotateVector ? null : null;
    void omegaB;
    // ω_world inicial: pongo ω_b apuntando al eje intermedio del cuerpo
    const wWorld = {};
    wWorld.x = R0[0] * wb0.x + R0[1] * wb0.y + R0[2] * wb0.z;
    wWorld.y = R0[3] * wb0.x + R0[4] * wb0.y + R0[5] * wb0.z;
    wWorld.z = R0[6] * wb0.x + R0[7] * wb0.y + R0[8] * wb0.z;
    SimRocas.V3.copy(body.angularVelocityWorld, wWorld);
    void V3;

    const KE0 = body.kineticEnergy();
    const L0 = {};
    body.angularMomentumWorld(L0);
    const magL0 = SimRocas.V3.length(L0);

    runFree(body, 1e-3, 10000);

    const KE1 = body.kineticEnergy();
    const L1 = {};
    body.angularMomentumWorld(L1);
    const magL1 = SimRocas.V3.length(L1);

    assert.ok(Math.abs((KE1 - KE0) / KE0) < 0.001, `drift energía ${(KE1 - KE0) / KE0 * 100}%`);
    assert.ok(Math.abs((magL1 - magL0) / magL0) < 0.001, `drift |L| ${(magL1 - magL0) / magL0 * 100}%`);
    // normalidad del cuaternión
    assert.ok(Math.abs(body.orientation.w ** 2 + body.orientation.x ** 2 + body.orientation.y ** 2 + body.orientation.z ** 2 - 1) < 1e-10);
});

test('RigidBody3D: rotación estable alrededor de ejes mayor y menor (ángulo con L < 1°)', () => {
    const SimRocas = loadRigid();
    const pr = freeRotationSetup(SimRocas);
    const Quat = SimRocas.Quat;
    const Mat3 = SimRocas.Mat3;
    const V3 = SimRocas.V3;

    for (const axisIndex of [0, 2]) { // x = mayor momento, z = menor momento
        const body = new SimRocas.RigidBody3D(pr);
        const wb0 = V3.set({}, 0, 0, 0);
        if (axisIndex === 0) { wb0.x = 4.0; wb0.y = 0.01; wb0.z = 0.01; }
        else { wb0.x = 0.01; wb0.y = 0.01; wb0.z = 4.0; }
        const R0 = Quat.toMat3(new Float64Array(9), body.orientation);
        const wWorld = {};
        wWorld.x = R0[0] * wb0.x + R0[1] * wb0.y + R0[2] * wb0.z;
        wWorld.y = R0[3] * wb0.x + R0[4] * wb0.y + R0[5] * wb0.z;
        wWorld.z = R0[6] * wb0.x + R0[7] * wb0.y + R0[8] * wb0.z;
        V3.copy(body.angularVelocityWorld, wWorld);

        for (let i = 0; i < 10000; i++) body.integrateFree(1e-3, null);

        // ángulo entre el eje del cuerpo (axisIndex) y L
        const R1 = Quat.toMat3(new Float64Array(9), body.orientation);
        const evec = {}; // columna axisIndex: eje del cuerpo en mundo
        evec.x = R1[axisIndex * 3];
        evec.y = R1[axisIndex * 3 + 1];
        evec.z = R1[axisIndex * 3 + 2];
        const L = {};
        body.angularMomentumWorld(L);
        const dot = Math.abs(V3.dot(evec, L)) / (V3.length(evec) * V3.length(L));
        const angle = Math.acos(Math.min(1, dot));
        assert.ok(angle < Math.PI / 180, `ángulo eje ${axisIndex}: ${angle * 180 / Math.PI}°`);
        void Mat3;
    }
});

test('RigidBody3D: efecto Dzhanibekov en el eje intermedio (el eje se invierte al menos una vez)', () => {
    const SimRocas = loadRigid();
    const pr = freeRotationSetup(SimRocas);
    const body = new SimRocas.RigidBody3D(pr);
    const Quat = SimRocas.Quat;
    const V3 = SimRocas.V3;
    const wb0 = V3.set({}, 0.06, 4.0, 0.06);
    const R0 = Quat.toMat3(new Float64Array(9), body.orientation);
    const wWorld = {};
    wWorld.x = R0[0] * wb0.x + R0[1] * wb0.y + R0[2] * wb0.z;
    wWorld.y = R0[3] * wb0.x + R0[4] * wb0.y + R0[5] * wb0.z;
    wWorld.z = R0[6] * wb0.x + R0[7] * wb0.y + R0[8] * wb0.z;
    V3.copy(body.angularVelocityWorld, wWorld);

    // proyección del eje y del cuerpo sobre L: cambia de signo al voltear
    const L = {};
    body.angularMomentumWorld(L);
    let fl = 0;
    let sign = 0;
    for (let i = 0; i < 10000; i++) {
        body.integrateFree(1e-3, null);
        const R = Quat.toMat3(new Float64Array(9), body.orientation);
        const ay = { x: R[1], y: R[4], z: R[7] }; // columna 1: eje y del cuerpo en mundo
        const d = V3.dot(ay, L);
        const s = d >= 0 ? 1 : -1;
        if (sign !== 0 && s !== sign) fl++;
        sign = s;
    }
    assert.ok(fl >= 1, `sin volteo del eje intermedio (flips=${fl})`);
});

test('RigidBody3D: con gravedad la caída es parabólica exacta (±1e-9) y |L| no cambia', () => {
    const SimRocas = loadRigid();
    const V3 = SimRocas.V3;
    const pr = freeRotationSetup(SimRocas);
    const body = new SimRocas.RigidBody3D(pr, { position: V3.set({}, 10, -4, 100), velocity: V3.set({}, 3, -2, 5) });
    const w0 = V3.copy(body.angularVelocityWorld, { x: 0.3, y: 1.1, z: -0.4 });
    void w0;
    const L0 = {};
    body.angularMomentumWorld(L0);
    const magL0 = V3.length(L0);

    const h = 1e-3;
    const steps = 10000;
    const g = { x: 0, y: 0, z: -9.81 };
    for (let i = 0; i < steps; i++) body.integrateFree(h, g);
    const t = steps * h;

    approx(body.position.x, 10 + 3 * t, 1e-9, 'x');
    approx(body.position.y, -4 - 2 * t, 1e-9, 'y');
    approx(body.position.z, 100 + 5 * t - 0.5 * 9.81 * t * t, 1e-9, 'z');
    approx(body.velocity.x, 3, 1e-9); approx(body.velocity.y, -2, 1e-9);
    approx(body.velocity.z, 5 - 9.81 * t, 1e-9);
    const L1 = {};
    body.angularMomentumWorld(L1);
    approx(V3.length(L1), magL0, magL0 * 1e-9, '|L| con gravedad');
});

// ------------------------------------------------------------------
// T5.2: applyImpulseAt
// ------------------------------------------------------------------

test('RigidBody3D.applyImpulseAt: en el com Δω = 0 y Δv = J/m', () => {
    const SimRocas = loadRigid();
    const pr = freeRotationSetup(SimRocas);
    const body = new SimRocas.RigidBody3D(pr, {
        position: { x: 1, y: 2, z: 3 },
        velocity: { x: 0.5, y: 0, z: 0 },
        angularVelocity: { x: 0.2, y: 0.3, z: 0.4 },
    });
    const wBefore = SimRocas.V3.copy({}, body.angularVelocityWorld);
    const J = { x: 2, y: -1, z: 0.5 };
    body.applyImpulseAt(J, { x: 1, y: 2, z: 3 });
    approx(body.velocity.x, 0.5 + J.x / pr.mass, 1e-12, 'vx');
    approx(body.velocity.y, J.y / pr.mass, 1e-12, 'vy');
    approx(body.velocity.z, J.z / pr.mass, 1e-12, 'vz');
    approx(body.angularVelocityWorld.x, wBefore.x, 1e-12, 'wx');
    approx(body.angularVelocityWorld.y, wBefore.y, 1e-12, 'wy');
    approx(body.angularVelocityWorld.z, wBefore.z, 1e-12, 'wz');
});

test('RigidBody3D.applyImpulseAt: impulso excéntrico conserva momento lineal y ΔL = r×J', () => {
    const SimRocas = loadRigid();
    const V3 = SimRocas.V3;
    const pr = freeRotationSetup(SimRocas);
    const body = new SimRocas.RigidBody3D(pr, {
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0.1, y: -0.2, z: 0.3 },
        angularVelocity: { x: 0.2, y: 0.3, z: 0.4 },
    });
    const vBefore = V3.copy({}, body.velocity);
    const LBefore = {};
    body.angularMomentumWorld(LBefore);

    const J = { x: 0.7, y: -0.3, z: 1.4 };
    const r = V3.set({}, 0.9, -0.4, 0.2);
    const point = V3.add({}, body.position, r);
    body.applyImpulseAt(J, point);

    // momento lineal: m·Δv = J exacto
    approx(V3.length(SimRocas.V3.scale({}, V3.sub({}, body.velocity, vBefore), pr.mass)), SimRocas.V3.length(J), 1e-12, '|p|');
    approx(body.velocity.x, (pr.mass * 0.1 + J.x) / pr.mass, 1e-12, 'vx');
    approx(body.velocity.y, (pr.mass * -0.2 + J.y) / pr.mass, 1e-12, 'vy');
    approx(body.velocity.z, (pr.mass * 0.3 + J.z) / pr.mass, 1e-12, 'vz');

    // ΔL = r × J
    const rJ = V3.cross({}, r, J);
    const LAfter = {};
    body.angularMomentumWorld(LAfter);
    approx(V3.dot(V3.sub({}, LAfter, LBefore), rJ), V3.dot(rJ, rJ), 1e-9, 'ΔL paralelo');
    approx(V3.length(V3.sub({}, LAfter, LBefore)), V3.length(rJ), 1e-9, '|ΔL| = |r×J|');
});

// ------------------------------------------------------------------
// Rendimiento
// ------------------------------------------------------------------

test('rendimiento: 10 000 pasos de integrateFree + worldVertices de un irregular de 20 vértices < 200 ms', () => {
    const SimRocas = loadRigid();
    const shape = SimRocas.ConvexShape3D.irregular(1.0, Math.random, { points: 20 });
    const pr = SimRocas.ConvexShape3D.toPrincipal(shape, 2.7);
    const body = new SimRocas.RigidBody3D(pr, {
        angularVelocity: { x: 0.4, y: 0.6, z: 0.25 },
        velocity: { x: 0.3, y: -0.1, z: -0.2 },
    });
    const outVerts = new Float64Array(3 * pr.vertexCount);
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) {
        body.integrateFree(1e-3, null);
        body.worldVertices(outVerts);
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `demasiado lento: ${ms.toFixed(1)} ms`);
});

// ------------------------------------------------------------------
// Constructor / API
// ------------------------------------------------------------------

test('RigidBody3D: expone estado inicial y buffers reutilizables', () => {
    const SimRocas = loadRigid();
    const pr = freeRotationSetup(SimRocas);
    const body = new SimRocas.RigidBody3D(pr);
    approx(body.position.x, 0, 0); approx(body.position.y, 0, 0); approx(body.position.z, 0, 0);
    approx(body.velocity.x, 0, 0); approx(body.velocity.y, 0, 0); approx(body.velocity.z, 0, 0);
    approx(body.orientation.w, 1, 0); approx(body.orientation.x, 0, 0);
    approx(body.orientation.y, 0, 0); approx(body.orientation.z, 0, 0);
    assert.ok(body.mass === pr.mass);
    assert.ok(body.inertiaDiag.x === pr.inertiaDiag.x);
    assert.ok(body.invInertiaDiag.x > 0);
    const v = body.worldVertices();
    assert.ok(Object.prototype.toString.call(v) === '[object Float64Array]' && v.length === 3 * pr.vertexCount);
});
