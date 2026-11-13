/**
 * SimRocas 3D — cuerpo rígido con forma real (fase F5, T5.1 + T5.2).
 *
 * ConvexShape3D: generadores de poliedros convexos en coordenadas del cuerpo
 * (contrato C7: Z arriba) + casco convexo 3D (quickhull) + propiedades de
 * masa exactas por descomposición en tetraedros con integrales bariéntricas
 * del simplex (Tonon 2004; equivalente a Mirtich 1996 sin ensamblaje).
 *
 * RigidBody3D: movimiento libre sin par de contacto. Traslación exacta para
 * aceleración constante en el paso; rotación con midpoint implícito en las
 * ecuaciones de Euler del cuerpo (punto fijo convergido, conserva energía y
 * |L| a la precisión de la convergencia) y actitud por mapa exponencial en
 * el marco del cuerpo. El bucle de `integrateFree` y `worldVertices` no
 * asigna: todo temporal es buffer de instancia o escalares locales.
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    const V3 = SimRocas.V3;
    const Quat = SimRocas.Quat;
    const Mat3 = SimRocas.Mat3;

    const _flow = { x: 0, y: 0, z: 0 };
    const _axis = { x: 0, y: 0, z: 0 };
    const _Lbody = { x: 0, y: 0, z: 0 };
    const _qTmp = { w: 0, x: 0, y: 0, z: 0 };

    // ------------------------------------------------------------------
    // Casco convexo 3D (quickhull)
    // ------------------------------------------------------------------

    /**
     * Construye el casco convexo de una nube de N puntos.
     *
     * @param {Float64Array} points coordenadas fila mayor (x, y, z) por punto
     * @param {number} count número de puntos
     * @returns {{vertices: Float64Array, vertexCount: number, faces: Array}}
     *   caras = [{a, b, c, nx, ny, nz}] triángulos con normal unitaria
     *   saliente.
     */
    function convexHull(points, count) {
        if (count < 4) {
            throw new Error('Se necesitan al menos 4 puntos no coplanares para un casco convexo 3D');
        }

        // ---------- deduplicación (puntos casi idénticos, p. ej. polos) ----------
        let P = points;
        let N = count;
        {
            const scale0 = bboxScale(points, count);
            const tol2 = (1e-12 * scale0) * (1e-12 * scale0);
            let keep = 0;
            let dup = 0;
            for (let i = 0; i < N; i++) {
                let dupIdx = -1;
                for (let j = 0; j < keep; j++) {
                    const dx = P[3 * i] - P[3 * j];
                    const dy = P[3 * i + 1] - P[3 * j + 1];
                    const dz = P[3 * i + 2] - P[3 * j + 2];
                    if (dx * dx + dy * dy + dz * dz <= tol2) { dupIdx = j; break; }
                }
                if (dupIdx >= 0) { dup++; continue; }
                if (i !== keep) {
                    P[3 * keep] = P[3 * i];
                    P[3 * keep + 1] = P[3 * i + 1];
                    P[3 * keep + 2] = P[3 * i + 2];
                }
                keep++;
            }
            N = keep;
            void dup;
        }
        if (N < 4) {
            throw new Error('Se necesitan al menos 4 puntos no coplanares para un casco convexo 3D');
        }

        // ---------- tolerancias relativas ----------
        const scale = bboxScale(P, N);
        if (!(scale > 0)) {
            throw new Error('Los puntos están degenerados (escala nula): no definen un casco convexo 3D');
        }
        const eps = 1e-9 * scale;

        // ---------- simplex inicial (4 puntos extremos no coplanares) ----------
        let p0 = 0;
        for (let i = 1; i < N; i++) {
            if (P[3 * i] < P[3 * p0]) p0 = i;
        }
        let p1 = -1;
        let d1 = 0;
        for (let i = 0; i < N; i++) {
            const dx = P[3 * i] - P[3 * p0];
            const dy = P[3 * i + 1] - P[3 * p0 + 1];
            const dz = P[3 * i + 2] - P[3 * p0 + 2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d > d1) { d1 = d; p1 = i; }
        }
        const l0x = P[3 * p1] - P[3 * p0];
        const l0y = P[3 * p1 + 1] - P[3 * p0 + 1];
        const l0z = P[3 * p1 + 2] - P[3 * p0 + 2];
        let p2 = -1;
        let d2 = 0;
        for (let i = 0; i < N; i++) {
            const dx = P[3 * i] - P[3 * p0];
            const dy = P[3 * i + 1] - P[3 * p0 + 1];
            const dz = P[3 * i + 2] - P[3 * p0 + 2];
            const cx = l0y * dz - l0z * dy;
            const cy = l0z * dx - l0x * dz;
            const cz = l0x * dy - l0y * dx;
            const d = cx * cx + cy * cy + cz * cz;
            if (d > d2) { d2 = d; p2 = i; }
        }
        const n0x = l0y * (P[3 * p2 + 2] - P[3 * p0 + 2]) - l0z * (P[3 * p2 + 1] - P[3 * p0 + 1]);
        const n0y = l0z * (P[3 * p2] - P[3 * p0]) - l0x * (P[3 * p2 + 2] - P[3 * p0 + 2]);
        const n0z = l0x * (P[3 * p2 + 1] - P[3 * p0 + 1]) - l0y * (P[3 * p2] - P[3 * p0]);
        let p3 = -1;
        let d3 = 0;
        for (let i = 0; i < N; i++) {
            const dx = P[3 * i] - P[3 * p0];
            const dy = P[3 * i + 1] - P[3 * p0 + 1];
            const dz = P[3 * i + 2] - P[3 * p0 + 2];
            const d = Math.abs(n0x * dx + n0y * dy + n0z * dz);
            if (d > d3) { d3 = d; p3 = i; }
        }
        if (p1 < 0 || p2 < 0 || p3 < 0 || d3 <= 1e-18 * scale * scale * scale) {
            throw new Error('Los puntos son (casi) coplanares: no definen un casco convexo 3D');
        }

        // interior de referencia (centroide del simplex inicial)
        const c0x = (P[3 * p0] + P[3 * p1] + P[3 * p2] + P[3 * p3]) / 4;
        const c0y = (P[3 * p0 + 1] + P[3 * p1 + 1] + P[3 * p2 + 1] + P[3 * p3 + 1]) / 4;
        const c0z = (P[3 * p0 + 2] + P[3 * p1 + 2] + P[3 * p2 + 2] + P[3 * p3 + 2]) / 4;

        // ---------- caras ----------
        // face = { a, b, c, nx, ny, nz, outside: [índices], far, farDist }
        const used = [p0, p1, p2, p3];
        const assigned = new Set(used);
        const faceList = [];

        function makeFace(a, b, c) {
            const ax = P[3 * a]; const ay = P[3 * a + 1]; const az = P[3 * a + 2];
            const bx = P[3 * b]; const by = P[3 * b + 1]; const bz = P[3 * b + 2];
            const cx = P[3 * c]; const cy = P[3 * c + 1]; const cz = P[3 * c + 2];
            let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
            let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
            let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len <= 0 || !isFinite(len)) {
                return null; // degenerada
            }
            if (nx * (ax - c0x) + ny * (ay - c0y) + nz * (az - c0z) < 0) {
                const t = b;
                b = c;
                c = t; // v + c intercambiados → normal al otro lado
                nx = -nx;
                ny = -ny;
                nz = -nz;
            }
            const inv = 1 / len;
            return {
                a,
                b,
                c,
                nx: nx * inv,
                ny: ny * inv,
                nz: nz * inv,
                outside: [],
                far: -1,
                farDist: -1,
            };
        }

        faceList.push(makeFace(p0, p1, p2), makeFace(p0, p1, p3), makeFace(p0, p2, p3), makeFace(p1, p2, p3));

        function assignPoint(i) {
            let best = null;
            let bestD = eps;
            for (const f of faceList) {
                if (!f) continue;
                const d = f.nx * (P[3 * i] - P[3 * f.a]) +
                    f.ny * (P[3 * i + 1] - P[3 * f.a + 1]) +
                    f.nz * (P[3 * i + 2] - P[3 * f.a + 2]);
                if (d > bestD) { bestD = d; best = f; }
            }
            if (best) {
                best.outside.push(i);
                if (bestD > best.farDist) { best.far = i; best.farDist = bestD; }
            }
            // sin cara fuera del épsilon: punto interior (se descarta)
        }

        for (let i = 0; i < N; i++) {
            if (assigned.has(i)) continue;
            assignPoint(i);
        }

        // ---------- bucle principal: resuelve conflictos ----------
        for (;;) {
            let f0 = null;
            for (const f of faceList) {
                if (f && f.outside !== null && f.outside.length > 0) { f0 = f; break; }
            }
            if (!f0) break;

            const v = f0.far;
            assigned.add(v);

            // caras visibles desde v
            const visible = [];
            for (const f of faceList) {
                if (!f) continue;
                const d = f.nx * (P[3 * v] - P[3 * f.a]) +
                    f.ny * (P[3 * v + 1] - P[3 * f.a + 1]) +
                    f.nz * (P[3 * v + 2] - P[3 * f.a + 2]);
                if (d > eps) visible.push(f);
            }
            // aristas del horizonte: aparecen exactamente una vez entre visibles
            const horizonte = [];
            for (const f of visible) {
                const edges = [[f.a, f.b], [f.b, f.c], [f.c, f.a]];
                for (const e of edges) {
                    let count = 0;
                    for (const g of visible) {
                        if ((g.a === e[0] && g.b === e[1]) || (g.b === e[0] && g.c === e[1]) || (g.c === e[0] && g.a === e[1]) ||
                            (g.a === e[1] && g.b === e[0]) || (g.b === e[1] && g.c === e[0]) || (g.c === e[1] && g.a === e[0])) {
                            count++;
                        }
                    }
                    if (count === 1) horizonte.push(e);
                }
            }

            // candidatos: puntos fuera de las caras visibles
            const candidatos = [];
            for (const f of visible) {
                for (const i of f.outside) candidatos.push(i);
                f.outside = null; // vaciado definitivo
            }
            // retira las caras visibles
            for (let i = 0; i < faceList.length; i++) {
                if (visible.indexOf(faceList[i]) >= 0) faceList[i] = null;
            }

            // nuevas caras: vértice v sobre cada arista del horizonte
            for (const e of horizonte) {
                const nf = makeFace(v, e[1], e[0]);
                if (nf) faceList.push(nf);
            }

            // reasignación de candidatos
            for (const i of candidatos) {
                if (i === v) continue;
                assignPoint(i);
            }
        }

        // ---------- compactar salida ----------
        const live = faceList.filter(f => f !== null);
        if (live.length === 0) {
            throw new Error('El casco convexo quedó vacío: nube degenerada');
        }
        const map = new Map();
        const verts = [];
        for (const f of live) {
            for (const idx of [f.a, f.b, f.c]) {
                if (!map.has(idx)) {
                    map.set(idx, verts.length / 3);
                    verts.push(P[3 * idx], P[3 * idx + 1], P[3 * idx + 2]);
                }
            }
        }

        return {
            vertices: new Float64Array(verts),
            vertexCount: verts.length / 3,
            faces: live.map(f => ({
                a: map.get(f.a),
                b: map.get(f.b),
                c: map.get(f.c),
                nx: f.nx,
                ny: f.ny,
                nz: f.nz,
            })),
        };
    }

    function bboxScale(P, n) {
        let minX = Infinity; let minY = Infinity; let minZ = Infinity;
        let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
            const x = P[3 * i];
            const y = P[3 * i + 1];
            const z = P[3 * i + 2];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
        return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    }

    // ------------------------------------------------------------------
    // Generador de formas rígidas
    // ------------------------------------------------------------------

    const ConvexShape3D = {

        /**
         * Caja de lados completos a×b×c centrada en el origen: inercias
         * Ixx = m(b²+c²)/12, Iyy = m(a²+c²)/12, Izz = m(a²+b²)/12.
         */
        box(a, b, c) {
            const hx = a / 2;
            const hy = b / 2;
            const hz = c / 2;
            const pts = new Float64Array([
                -hx, -hy, -hz, hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz,
                -hx, -hy, hz, hx, -hy, hz, -hx, hy, hz, hx, hy, hz,
            ]);
            return convexHull(pts, 8);
        },

        /**
         * Elipsoide de SEMIEJES a, b, c (Ixx = m(b²+c²)/5) centrado en el
         * origen: casco convexo del polígono inscrito de resolución
         * `segments` (latitudes y longitudes, defecto 32).
         */
        ellipsoid(a, b, c, segments = 32) {
            const nLat = Math.max(4, segments);
            const nLon = Math.max(6, segments);
            const pts = [];
            for (let j = 0; j <= nLat; j++) {
                const theta = Math.PI * j / nLat;
                const st = Math.sin(theta);
                const ct = Math.cos(theta);
                for (let i = 0; i < nLon; i++) {
                    const phi = 2 * Math.PI * i / nLon;
                    pts.push(a * st * Math.cos(phi), b * st * Math.sin(phi), c * ct);
                }
            }
            return convexHull(new Float64Array(pts), pts.length / 3);
        },

        /**
         * Bloque irregular realista: casco convexo de N puntos aleatorios
         * sobre un elipsoide con semiejes aleatorios acotados
         * (opts.aspectMin..opts.aspectMax, defecto 0.7..1.3) y jitter de
         * radio (opts.jitter, defecto 0.12). El bloque queda acotado por
         * `diameter` (el radio máximo es diameter/2). `rng` debe devolver
         * [0, 1).
         */
        irregular(diameter, rng, opts = {}) {
            const nPts = opts.points ?? 20;
            const jitter = opts.jitter ?? 0.12;
            const aMin = opts.aspectMin ?? 0.7;
            const aMax = opts.aspectMax ?? 1.3;
            if (typeof rng !== 'function') {
                throw new Error('irregular() necesita un generador aleatorio rng');
            }
            if (!(diameter > 0)) {
                throw new Error('El diámetro del bloque irregular debe ser positivo');
            }
            const r = diameter / 2;
            const fx = aMin + (aMax - aMin) * rng();
            const fy = aMin + (aMax - aMin) * rng();
            const fz = aMin + (aMax - aMin) * rng();
            const pts = [];
            let maxLin = 0;
            while (pts.length < 3 * nPts) {
                let ux = 2 * rng() - 1;
                let uy = 2 * rng() - 1;
                let uz = 2 * rng() - 1;
                const l2 = ux * ux + uy * uy + uz * uz;
                if (l2 < 1e-6 || l2 > 1) continue; // densidad angular aceptable
                const inv = 1 / Math.sqrt(l2);
                ux *= inv; uy *= inv; uz *= inv;
                const jf = 1 + jitter * (2 * rng() - 1);
                const x = ux * fx * jf;
                const y = uy * fy * jf;
                const z = uz * fz * jf;
                const lin = Math.sqrt(x * x + y * y + z * z);
                if (lin > maxLin) maxLin = lin;
                pts.push(x, y, z);
            }
            if (maxLin > 0) {
                const f = r / maxLin;
                for (let i = 0; i < pts.length; i++) pts[i] *= f;
            }
            const hull = convexHull(new Float64Array(pts), pts.length / 3);
            // acotar por diámetro MEDIDO DESDE EL CENTRO DE MASA (el radio
            // envolvente que informa toPrincipal es exactamente ese máximo)
            const mp0 = ConvexShape3D.massProperties(hull, 1.0);
            let maxR = 0;
            for (let i = 0; i < hull.vertexCount; i++) {
                const dxv = hull.vertices[3 * i] - mp0.com.x;
                const dyv = hull.vertices[3 * i + 1] - mp0.com.y;
                const dzv = hull.vertices[3 * i + 2] - mp0.com.z;
                const d = Math.sqrt(dxv * dxv + dyv * dyv + dzv * dzv);
                if (d > maxR) maxR = d;
            }
            if (maxR > r) {
                const f = r / maxR;
                const comps = ['x', 'y', 'z'];
                for (let i = 0; i < hull.vertexCount; i++) {
                    for (let k = 0; k < 3; k++) {
                        const c = comps[k];
                        const idx = 3 * i + k;
                        hull.vertices[idx] = mp0.com[c] + f * (hull.vertices[idx] - mp0.com[c]);
                    }
                }
            }
            return hull;
        },

        /** Casco convexo público (para nubes arbitrarias). */
        convexHull(points, count) {
            return convexHull(points, count);
        },

        // --------------------------------------------------------------
        // Propiedades de masa por descomposición en tetraedros
        // (Tonon 2004: integrales bariéntricas exactas del simplex)
        // --------------------------------------------------------------

        /**
         * Volumen, masa, centro de masa y tensor de inercia (sobre el centro
         * de masa, en el marco de los vértices). Descompone el sólido en
         * tetraedros (centroide de vértices, cara) — la estrella desde un
         * punto interior tesela el casco sin solapamientos ni signos — e
         * integra con las fórmulas exactas:
         *   ∫x_i x_j dV = (V/10)(A_iA_j + B_iB_j + C_iC_j)
         *               + (V/20)(A_iB_j + B_iA_j + A_iC_j + C_iA_j + B_iC_j + C_iB_j)
         * @returns {{volume, mass, com, inertia: Float64Array(9) fila mayor}}
         */
        massProperties(shape, density) {
            if (!(density > 0)) {
                throw new Error('La densidad debe ser positiva');
            }
            if (!shape || shape.faces.length === 0) {
                throw new Error('La forma no tiene caras: no se pueden calcular propiedades de masa');
            }
            const V = shape.vertices;

            // apex: centroide de los vértices (interior del casco convexo)
            const nv = shape.vertexCount;
            let gx = 0; let gy = 0; let gz = 0;
            for (let i = 0; i < nv; i++) {
                gx += V[3 * i];
                gy += V[3 * i + 1];
                gz += V[3 * i + 2];
            }
            gx /= nv; gy /= nv; gz /= nv;

            let vol = 0;
            let m1x = 0; let m1y = 0; let m1z = 0;
            let s00 = 0; let s01 = 0; let s02 = 0; let s11 = 0; let s12 = 0; let s22 = 0;

            for (const f of shape.faces) {
                const Ax = V[3 * f.a] - gx; const Ay = V[3 * f.a + 1] - gy; const Az = V[3 * f.a + 2] - gz;
                const Bx = V[3 * f.b] - gx; const By = V[3 * f.b + 1] - gy; const Bz = V[3 * f.b + 2] - gz;
                const Cx = V[3 * f.c] - gx; const Cy = V[3 * f.c + 1] - gy; const Cz = V[3 * f.c + 2] - gz;
                const vt = Math.abs((Ax * (By * Cz - Bz * Cy) +
                    Ay * (Bz * Cx - Bx * Cz) +
                    Az * (Bx * Cy - By * Cx)) / 6);
                if (!(vt > 0)) continue;
                vol += vt;
                const w0 = vt / 10;
                const w1 = vt / 20;
                m1x += density * vt * (Ax + Bx + Cx) / 4;
                m1y += density * vt * (Ay + By + Cy) / 4;
                m1z += density * vt * (Az + Bz + Cz) / 4;
                s00 += density * (w0 * (Ax * Ax + Bx * Bx + Cx * Cx) + w1 * 2 * (Ax * Bx + Ax * Cx + Bx * Cx));
                s11 += density * (w0 * (Ay * Ay + By * By + Cy * Cy) + w1 * 2 * (Ay * By + Ay * Cy + By * Cy));
                s22 += density * (w0 * (Az * Az + Bz * Bz + Cz * Cz) + w1 * 2 * (Az * Bz + Az * Cz + Bz * Cz));
                s01 += density * (w0 * (Ax * Ay + Bx * By + Cx * Cy) + w1 * (Ax * By + Ay * Bx + Ax * Cy + Ay * Cx + Bx * Cy + By * Cx));
                s02 += density * (w0 * (Ax * Az + Bx * Bz + Cx * Cz) + w1 * (Ax * Bz + Az * Bx + Ax * Cz + Az * Cx + Bx * Cz + Bz * Cx));
                s12 += density * (w0 * (Ay * Az + By * Bz + Cy * Cz) + w1 * (Ay * Bz + Az * By + Ay * Cz + Az * Cy + By * Cz + Bz * Cy));
            }

            if (!(vol > 0)) {
                throw new Error('El casco es degenerado: volumen nulo');
            }
            const mass = density * vol;
            const cx = gx + m1x / mass;
            const cy = gy + m1y / mass;
            const cz = gz + m1z / mass;

            // I sobre el apex: I = tr(M)·Id − M; luego ejes paralelos al com
            const trM = s00 + s11 + s22;
            const dx = m1x / mass; const dy = m1y / mass; const dz = m1z / mass;
            const d2 = dx * dx + dy * dy + dz * dz;
            const inertia = new Float64Array(9);
            inertia[0] = (trM - s00) - mass * (d2 - dx * dx);
            inertia[1] = (-s01) + mass * dx * dy;
            inertia[2] = (-s02) + mass * dx * dz;
            inertia[3] = inertia[1];
            inertia[4] = (trM - s11) - mass * (d2 - dy * dy);
            inertia[5] = (-s12) + mass * dy * dz;
            inertia[6] = inertia[2];
            inertia[7] = inertia[5];
            inertia[8] = (trM - s22) - mass * (d2 - dz * dz);

            return { volume: vol, mass, com: { x: cx, y: cy, z: cz }, inertia };
        },

        /**
         * Traslada la forma al centro de masa y rota a ejes principales
         * (tensor diagonal). Los vértices quedan v' = Eᵀ·(v − com) con E
         * columnas = autovectores en orden ascendente de momentos; la base
         * se fuerza dextrógira.
         *
         * @returns {{vertices, vertexCount, faces, mass, volume, inertiaDiag, boundingRadius}}
         */
        toPrincipal(shape, density) {
            const mp = ConvexShape3D.massProperties(shape, density);
            const evals = { x: 0, y: 0, z: 0 };
            const evecs = new Float64Array(9);
            if (!Mat3.jacobiEigen(evals, evecs, mp.inertia)) {
                throw new Error('La diagonalización del tensor de inercia no convergió');
            }
            // orden DESCENDENTE en inertiaDiag (x = eje de mayor momento):
            // intercambia autovalor/eigenvector de las columnas 0 y 2
            {
                const t = evals.x;
                evals.x = evals.z;
                evals.z = t;
                for (let r = 0; r < 3; r++) {
                    const tv = evecs[r * 3];
                    evecs[r * 3] = evecs[r * 3 + 2];
                    evecs[r * 3 + 2] = tv;
                }
            }
            // base dextrógira
            const det =
                evecs[0] * (evecs[4] * evecs[8] - evecs[5] * evecs[7]) -
                evecs[3] * (evecs[1] * evecs[8] - evecs[2] * evecs[7]) +
                evecs[6] * (evecs[1] * evecs[5] - evecs[2] * evecs[4]);
            if (det < 0) {
                evecs[2] = -evecs[2];
                evecs[5] = -evecs[5];
                evecs[8] = -evecs[8];
            }

            const nv = shape.vertexCount;
            const src = shape.vertices;
            const map = new Map();
            const verts = [];
            const faces = [];
            for (const f of shape.faces) {
                const ia = [];
                for (const idx of [f.a, f.b, f.c]) {
                    if (!map.has(idx)) {
                        map.set(idx, verts.length / 3);
                        const vx = src[3 * idx] - mp.com.x;
                        const vy = src[3 * idx + 1] - mp.com.y;
                        const vz = src[3 * idx + 2] - mp.com.z;
                        verts.push(
                            evecs[0] * vx + evecs[3] * vy + evecs[6] * vz,
                            evecs[1] * vx + evecs[4] * vy + evecs[7] * vz,
                            evecs[2] * vx + evecs[5] * vy + evecs[8] * vz,
                        );
                    }
                    ia.push(map.get(idx));
                }
                const a = ia[0];
                const b = ia[1];
                const c = ia[2];
                const ax = verts[3 * a]; const ay = verts[3 * a + 1]; const az = verts[3 * a + 2];
                const bx = verts[3 * b]; const by = verts[3 * b + 1]; const bz = verts[3 * b + 2];
                const cx = verts[3 * c]; const cy = verts[3 * c + 1]; const cz = verts[3 * c + 2];
                let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
                let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
                let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (len > 0) {
                    nx /= len; ny /= len; nz /= len;
                }
                faces.push({ a, b, c, nx, ny, nz });
            }

            let br = 0;
            for (let i = 0; i < verts.length; i += 3) {
                const d = verts[i] * verts[i] + verts[i + 1] * verts[i + 1] + verts[i + 2] * verts[i + 2];
                if (d > br) br = d;
            }

            return {
                vertices: new Float64Array(verts),
                vertexCount: verts.length / 3,
                faces,
                mass: mp.mass,
                volume: mp.volume,
                inertiaDiag: { x: evals.x, y: evals.y, z: evals.z },
                boundingRadius: Math.sqrt(br),
            };
        },
    };

    // ------------------------------------------------------------------
    // Cuerpo rígido 3D
    // ------------------------------------------------------------------

    const _qDelta = { w: 0, x: 0, y: 0, z: 0 };
    const _qProd = { w: 0, x: 0, y: 0, z: 0 };
    const _wMid = { x: 0, y: 0, z: 0 };
    const _wNext = { x: 0, y: 0, z: 0 };
    const _LImp = { x: 0, y: 0, z: 0 };

    /**
     * Cuerpo rígido 3D con forma principal (el resultado de
     * ConvexShape3D.toPrincipal) y movimiento libre sin par de contacto.
     *
     * @param {object} principal { vertices, vertexCount, faces, mass, volume,
     *   inertiaDiag, boundingRadius }
     * @param {object} [opts] { position, velocity, angularVelocity, orientation }
     */
    function RigidBody3D(principal, opts = {}) {
        if (!principal || !(principal.mass > 0)) {
            throw new Error('RigidBody3D necesita una forma principal con masa positiva');
        }
        const zero = { x: 0, y: 0, z: 0 };
        this.shape = principal;
        this.mass = principal.mass;
        this.volume = principal.volume;
        this.boundingRadius = principal.boundingRadius;
        this.inertiaDiag = {
            x: principal.inertiaDiag.x,
            y: principal.inertiaDiag.y,
            z: principal.inertiaDiag.z,
        };
        this.invInertiaDiag = {
            x: 1 / principal.inertiaDiag.x,
            y: 1 / principal.inertiaDiag.y,
            z: 1 / principal.inertiaDiag.z,
        };
        this.position = V3.copy({}, opts.position ?? zero);
        this.velocity = V3.copy({}, opts.velocity ?? zero);
        this.orientation = opts.orientation ? Quat.copy({}, opts.orientation) : Quat.identity({});
        this.angularVelocityWorld = V3.copy({}, opts.angularVelocity ?? zero);
        this.isResting = false;
        this.stopReason = null;

        // buffers de instancia (el bucle caliente no asigna)
        this._R = new Float64Array(9);
        this._worldVerts = new Float64Array(3 * principal.vertexCount);
    }

    /**
     * Paso de movimiento libre: traslación y rotación (sin gravedad si
     * `gravity` es null).
     */
    RigidBody3D.prototype.integrateFree = function (h, gravity) {
        const gx = gravity ? gravity.x : 0;
        const gy = gravity ? gravity.y : 0;
        const gz = gravity ? gravity.z : 0;
        const p = this.position;
        const v = this.velocity;

        // traslación exacta para aceleración constante en el paso
        p.x += v.x * h + 0.5 * gx * h * h;
        p.y += v.y * h + 0.5 * gy * h * h;
        p.z += v.z * h + 0.5 * gz * h * h;
        v.x += gx * h;
        v.y += gy * h;
        v.z += gz * h;

        // ---- rotación libre sin par (ecuaciones de Euler en el cuerpo) ----
        const R = this._R;
        Quat.toMat3(R, this.orientation);
        const w = this.angularVelocityWorld;
        // ω_b = Rᵀ·ω_w
        const w0x = R[0] * w.x + R[3] * w.y + R[6] * w.z;
        const w0y = R[1] * w.x + R[4] * w.y + R[7] * w.z;
        const w0z = R[2] * w.x + R[5] * w.y + R[8] * w.z;

        // ε(ω) = I⁻¹·(−ω_b × (I·ω_b)) con I diagonal
        const Ix = this.inertiaDiag.x;
        const Iy = this.inertiaDiag.y;
        const Iz = this.inertiaDiag.z;
        const invx = this.invInertiaDiag.x;
        const invy = this.invInertiaDiag.y;
        const invz = this.invInertiaDiag.z;

        const flow = (wx, wy, wz, s) => {
            const Iwx = Ix * wx;
            const Iwy = Iy * wy;
            const Iwz = Iz * wz;
            _flow.x = invx * (wy * Iwz - wz * Iwy) * s;
            _flow.y = invy * (wz * Iwx - wx * Iwz) * s;
            _flow.z = invz * (wx * Iwy - wy * Iwx) * s;
            return _flow;
        };

        // midpoint implícito: ω½ = ω₀ + (h/2)·ε(ω½) — punto fijo convergido
        let mx = w0x;
        let my = w0y;
        let mz = w0z;
        const half = 0.5 * h;
        for (let k = 0; k < 8; k++) {
            flow(mx, my, mz, half);
            const nx2 = w0x + _flow.x;
            const ny2 = w0y + _flow.y;
            const nz2 = w0z + _flow.z;
            const dx = nx2 - mx;
            const dy = ny2 - my;
            const dz = nz2 - mz;
            mx = nx2; my = ny2; mz = nz2;
            if (dx * dx + dy * dy + dz * dz < 1e-26 * (mx * mx + my * my + mz * mz + 1e-30)) {
                break;
            }
        }
        // extrapolación del midpoint: ω_b(h) = ω₀ + h·ε(ω½)
        flow(mx, my, mz, h);
        const nwx = w0x + _flow.x;
        const nwy = w0y + _flow.y;
        const nwz = w0z + _flow.z;

        // actitud: exponencial en el marco del cuerpo (rotación derecha)
        // q ← q ⊗ exp(½·ω½·h), normalizada
        const om = Math.sqrt(mx * mx + my * my + mz * mz);
        if (om > 0) {
            _axis.x = mx / om;
            _axis.y = my / om;
            _axis.z = mz / om;
            Quat.fromAxisAngle(_qDelta, _axis, om * h);
            Quat.multiply(_qProd, this.orientation, _qDelta);
            Quat.normalize(this.orientation, _qProd);
        }

        // ω_world nueva con la actitud actualizada: ω_w = R_new·ω_b(h)
        Quat.toMat3(R, this.orientation);
        w.x = R[0] * nwx + R[1] * nwy + R[2] * nwz;
        w.y = R[3] * nwx + R[4] * nwy + R[5] * nwz;
        w.z = R[6] * nwx + R[7] * nwy + R[8] * nwz;
        return this;
    };

    /**
     * out (Float64Array): vértices del cuerpo en coordenadas del mundo, fila
     * mayor. Sin `out` (o de tamaño insuficiente) devuelve su buffer interno
     * reutilizable.
     */
    RigidBody3D.prototype.worldVertices = function (out) {
        const dst = out && out.length >= this._worldVerts.length ? out : this._worldVerts;
        const R = this._R;
        Quat.toMat3(R, this.orientation);
        const V = this.shape.vertices;
        const p = this.position;
        const n = this.shape.vertexCount;
        for (let i = 0; i < n; i++) {
            const x = V[3 * i];
            const y = V[3 * i + 1];
            const z = V[3 * i + 2];
            dst[3 * i] = p.x + R[0] * x + R[1] * y + R[2] * z;
            dst[3 * i + 1] = p.y + R[3] * x + R[4] * y + R[5] * z;
            dst[3 * i + 2] = p.z + R[6] * x + R[7] * y + R[8] * z;
        }
        return dst;
    };

    /** Energía cinética total (J): ½·m·|v|² + ½·ω_b·I·ω_b. */
    RigidBody3D.prototype.kineticEnergy = function () {
        const R = this._R;
        Quat.toMat3(R, this.orientation);
        const w = this.angularVelocityWorld;
        const wx = R[0] * w.x + R[3] * w.y + R[6] * w.z;
        const wy = R[1] * w.x + R[4] * w.y + R[7] * w.z;
        const wz = R[2] * w.x + R[5] * w.y + R[8] * w.z;
        const I = this.inertiaDiag;
        const v = this.velocity;
        return 0.5 * this.mass * (v.x * v.x + v.y * v.y + v.z * v.z) +
            0.5 * (wx * I.x * wx + wy * I.y * wy + wz * I.z * wz);
    };

    /** out = L_world = R·(I·ω_b) (conservado en la rotación libre). */
    RigidBody3D.prototype.angularMomentumWorld = function (out) {
        const R = this._R;
        Quat.toMat3(R, this.orientation);
        const w = this.angularVelocityWorld;
        const wx = R[0] * w.x + R[3] * w.y + R[6] * w.z;
        const wy = R[1] * w.x + R[4] * w.y + R[7] * w.z;
        const wz = R[2] * w.x + R[5] * w.y + R[8] * w.z;
        const I = this.inertiaDiag;
        _Lbody.x = I.x * wx;
        _Lbody.y = I.y * wy;
        _Lbody.z = I.z * wz;
        out.x = R[0] * _Lbody.x + R[1] * _Lbody.y + R[2] * _Lbody.z;
        out.y = R[3] * _Lbody.x + R[4] * _Lbody.y + R[5] * _Lbody.z;
        out.z = R[6] * _Lbody.x + R[7] * _Lbody.y + R[8] * _Lbody.z;
        return out;
    };

    /**
     * Impulso J en pointWorld: Δv = J/m; Δω_world = I_world⁻¹·(r×J) con
     * I_world = R·I_b·Rᵀ. El punto no se traslada.
     */
    RigidBody3D.prototype.applyImpulseAt = function (impulse, pointWorld) {
        const p = this.position;
        const rx = pointWorld.x - p.x;
        const ry = pointWorld.y - p.y;
        const rz = pointWorld.z - p.z;

        this.velocity.x += impulse.x / this.mass;
        this.velocity.y += impulse.y / this.mass;
        this.velocity.z += impulse.z / this.mass;

        // ΔL_world = r×J → al cuerpo: ΔL_b = Rᵀ·ΔL; Δω_b = I⁻¹·ΔL_b;
        // Δω_world = R·Δω_b
        const Lx = ry * impulse.z - rz * impulse.y;
        const Ly = rz * impulse.x - rx * impulse.z;
        const Lz = rx * impulse.y - ry * impulse.x;

        const R = this._R;
        Quat.toMat3(R, this.orientation);
        _LImp.x = R[0] * Lx + R[3] * Ly + R[6] * Lz; // Rᵀ·L
        _LImp.y = R[1] * Lx + R[4] * Ly + R[7] * Lz;
        _LImp.z = R[2] * Lx + R[5] * Ly + R[8] * Lz;
        _LImp.x *= this.invInertiaDiag.x;
        _LImp.y *= this.invInertiaDiag.y;
        _LImp.z *= this.invInertiaDiag.z;
        const w = this.angularVelocityWorld;
        w.x += R[0] * _LImp.x + R[1] * _LImp.y + R[2] * _LImp.z;
        w.y += R[3] * _LImp.x + R[4] * _LImp.y + R[5] * _LImp.z;
        w.z += R[6] * _LImp.x + R[7] * _LImp.y + R[8] * _LImp.z;
        return this;
    };

    SimRocas.ConvexShape3D = ConvexShape3D;
    SimRocas.RigidBody3D = RigidBody3D;
})(globalThis.SimRocas);
