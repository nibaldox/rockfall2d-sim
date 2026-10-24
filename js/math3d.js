/**
 * SimRocas 3D — matemática vectorial (contrato C7).
 *
 * Funciones escalares sin asignación sobre objetos {x, y, z} con parámetro
 * `out`. Todas devuelven `out` (excepto dot/length, escalares). Los objetos
 * de entrada nunca se modifican; el que llama reutiliza el `out`.
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    const V3 = {
        /**
         * Escribe (x, y, z) en out.
         * @param {{x: number, y: number, z: number}} out
         * @param {number} x
         * @param {number} y
         * @param {number} z
         * @returns {{x: number, y: number, z: number}} out
         */
        set(out, x, y, z) {
            out.x = x;
            out.y = y;
            out.z = z;
            return out;
        },

        /** out = a. */
        copy(out, a) {
            out.x = a.x;
            out.y = a.y;
            out.z = a.z;
            return out;
        },

        /** out = a + b. */
        add(out, a, b) {
            out.x = a.x + b.x;
            out.y = a.y + b.y;
            out.z = a.z + b.z;
            return out;
        },

        /** out = a − b. */
        sub(out, a, b) {
            out.x = a.x - b.x;
            out.y = a.y - b.y;
            out.z = a.z - b.z;
            return out;
        },

        /** out = a · s. */
        scale(out, a, s) {
            out.x = a.x * s;
            out.y = a.y * s;
            out.z = a.z * s;
            return out;
        },

        /** out = a + b · s. */
        addScaled(out, a, b, s) {
            out.x = a.x + b.x * s;
            out.y = a.y + b.y * s;
            out.z = a.z + b.z * s;
            return out;
        },

        /** Producto escalar. */
        dot(a, b) {
            return a.x * b.x + a.y * b.y + a.z * b.z;
        },

        /** out = a × b (producto vectorial). */
        cross(out, a, b) {
            const x = a.y * b.z - a.z * b.y;
            const y = a.z * b.x - a.x * b.z;
            const z = a.x * b.y - a.y * b.x;
            out.x = x;
            out.y = y;
            out.z = z;
            return out;
        },

        /** Longitud euclídea. */
        length(a) {
            return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
        },

        /**
         * Normaliza a en out. Devuelve la longitud original; con vector nulo
         * escribe (0, 0, 0) y devuelve 0 (sin NaN).
         * @returns {number} longitud de a (0 si es nulo)
         */
        normalize(out, a) {
            const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
            if (len === 0) {
                out.x = 0;
                out.y = 0;
                out.z = 0;
                return 0;
            }
            const inv = 1 / len;
            out.x = a.x * inv;
            out.y = a.y * inv;
            out.z = a.z * inv;
            return len;
        },

        /**
         * Rodrigues: out = v rotado `angleRad` alrededor del eje unitario
         * axisUnit (regla de la mano derecha). v y out pueden coincidir;
         * axisUnit debe estar normalizado.
         */
        rotateAroundAxis(out, v, axisUnit, angleRad) {
            // Rodrigues: w = v·cosθ + (k×v)·sinθ + k·(k·v)·(1−cosθ).
            // Todo en temporales escalares: v puede coincidir con out.
            const cosA = Math.cos(angleRad);
            const sinA = Math.sin(angleRad);
            const ax = axisUnit.x;
            const ay = axisUnit.y;
            const az = axisUnit.z;
            const kdv = ax * v.x + ay * v.y + az * v.z;
            const cx = ay * v.z - az * v.y;
            const cy = az * v.x - ax * v.z;
            const cz = ax * v.y - ay * v.x;
            const f = 1 - cosA;
            const nx = v.x * cosA + cx * sinA + ax * kdv * f;
            const ny = v.y * cosA + cy * sinA + ay * kdv * f;
            const nz = v.z * cosA + cz * sinA + az * kdv * f;
            out.x = nx;
            out.y = ny;
            out.z = nz;
            return out;
        },

        /**
         * Un perpendicular a la normal unitaria unitN: determinista y estable
         * incluso con normales casi verticales (el clásico eje X falla cuando
         * n ≈ ±X). Construye una base con el componente mínimo.
         */
        anyPerpendicular(out, unitN) {
            const ax = Math.abs(unitN.x);
            const ay = Math.abs(unitN.y);
            const az = Math.abs(unitN.z);
            let px;
            let py;
            let pz;
            if (ax <= ay && ax <= az) {
                px = 1;
                py = 0;
                pz = 0;
            } else if (ay <= az) {
                px = 0;
                py = 1;
                pz = 0;
            } else {
                px = 0;
                py = 0;
                pz = 1;
            }
            // p × n es ortogonal a ambos y, p unitario con n no paralelo a p,
            // su longitud es 1.
            const cx = py * unitN.z - pz * unitN.y;
            const cy = pz * unitN.x - px * unitN.z;
            const cz = px * unitN.y - py * unitN.x;
            const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
            if (len === 0) {
                out.x = 0;
                out.y = 0;
                out.z = 0;
                return out;
            }
            const inv = 1 / len;
            out.x = cx * inv;
            out.y = cy * inv;
            out.z = cz * inv;
            return out;
        },
    };

    /**
     * Cuaterniones {w, x, y, z} con parámetro `out`, sin asignación en el
     * bucle caliente. Convención: `q` mapea coordenadas del cuerpo a mundo
     * (q̇ = ½ · (0, ω_mundo) ⊗ q; rotateVector = q·v·q⁻¹).
     */
    const Quat = {
        /** out = identidad (1, 0, 0, 0). */
        identity(out) {
            out.w = 1;
            out.x = 0;
            out.y = 0;
            out.z = 0;
            return out;
        },

        /** out = a. */
        copy(out, a) {
            out.w = a.w;
            out.x = a.x;
            out.y = a.y;
            out.z = a.z;
            return out;
        },

        /**
         * out = rotación de `angleRad` alrededor del eje `axis` (se normaliza
         * internamente, como el resto de la API tolera ejes no unitarios).
         */
        fromAxisAngle(out, axis, angleRad) {
            let nx = axis.x;
            let ny = axis.y;
            let nz = axis.z;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 0) {
                nx /= len;
                ny /= len;
                nz /= len;
            }
            const half = 0.5 * angleRad;
            const s = Math.sin(half);
            out.w = Math.cos(half);
            out.x = nx * s;
            out.y = ny * s;
            out.z = nz * s;
            return out;
        },

        /**
         * out = a ⊗ b (producto de Hamilton): b se aplica primero y a después;
         * equivale a componer R(a)·R(b).
         */
        multiply(out, a, b) {
            const aw = a.w;
            const ax = a.x;
            const ay = a.y;
            const az = a.z;
            const bw = b.w;
            const bx = b.x;
            const by = b.y;
            const bz = b.z;
            out.w = aw * bw - ax * bx - ay * by - az * bz;
            out.x = aw * bx + ax * bw + ay * bz - az * by;
            out.y = aw * by + ay * bw + az * bx - ax * bz;
            out.z = aw * bz + az * bw + ax * by - ay * bx;
            return out;
        },

        /** out = q⁻¹ para |q| = 1 (conjugado). */
        conjugate(out, q) {
            out.w = q.w;
            out.x = -q.x;
            out.y = -q.y;
            out.z = -q.z;
            return out;
        },

        /** out = q normalizado (tolera out === q). */
        normalize(out, q) {
            const s = q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z;
            const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
            out.w = q.w * inv;
            out.x = q.x * inv;
            out.y = q.y * inv;
            out.z = q.z * inv;
            return out;
        },

        /**
         * out = q · v · q⁻¹ (v de cuerpo → mundo). v y out pueden coincidir.
         */
        rotateVector(out, q, v) {
            const vx = v.x;
            const vy = v.y;
            const vz = v.z;
            const qx = q.x;
            const qy = q.y;
            const qz = q.z;
            // t = 2·qv×v; out = v + q.w·t + qv×t (en temporales escalares)
            const tx = 2 * (qy * vz - qz * vy);
            const ty = 2 * (qz * vx - qx * vz);
            const tz = 2 * (qx * vy - qy * vx);
            out.x = vx + q.w * tx + qy * tz - qz * ty;
            out.y = vy + q.w * ty + qz * tx - qx * tz;
            out.z = vz + q.w * tz + qx * ty - qy * tx;
            return out;
        },

        /**
         * Paso de integración de la actitud: out = normalize(q + ½·h·(0,ω)⊗q),
         * con ω en el marco del mundo. Un Euler explícito renormalizado.
         */
        integrate(out, q, omegaWorld, h) {
            const qw = q.w;
            const qx = q.x;
            const qy = q.y;
            const qz = q.z;
            const wx = omegaWorld.x;
            const wy = omegaWorld.y;
            const wz = omegaWorld.z;
            const s = 0.5 * h;
            // derivada: ½ · (0,ω) ⊗ q → (−ω·qv, q.w·ω + ω×qv)
            const dw = -(wx * qx + wy * qy + wz * qz) * s;
            const dx = (qw * wx + wy * qz - wz * qy) * s;
            const dy = (qw * wy + wz * qx - wx * qz) * s;
            const dz = (qw * wz + wx * qy - wy * qx) * s;
            const w = qw + dw;
            const x = qx + dx;
            const y = qy + dy;
            const z = qz + dz;
            const n2 = w * w + x * x + y * y + z * z;
            const inv = n2 > 0 ? 1 / Math.sqrt(n2) : 0;
            out.w = w * inv;
            out.x = x * inv;
            out.y = y * inv;
            out.z = z * inv;
            return out;
        },

        /**
         * out (Float64Array fila mayor) = matriz de rotación de q
         * (cuerpo → mundo; las filas son las imágenes de los ejes del mundo
         * expresadas… convención estándar R·e_i = q·e_i·q⁻¹).
         */
        toMat3(out, q) {
            const x2 = q.x + q.x;
            const y2 = q.y + q.y;
            const z2 = q.z + q.z;
            const xx = q.x * x2;
            const yy = q.y * y2;
            const zz = q.z * z2;
            const xy = q.x * y2;
            const xz = q.x * z2;
            const yz = q.y * z2;
            const wx = q.w * x2;
            const wy = q.w * y2;
            const wz = q.w * z2;
            out[0] = 1 - yy - zz;
            out[1] = xy - wz;
            out[2] = xz + wy;
            out[3] = xy + wz;
            out[4] = 1 - xx - zz;
            out[5] = yz - wx;
            out[6] = xz - wy;
            out[7] = yz + wx;
            out[8] = 1 - xx - yy;
            return out;
        },
    };

    /**
     * Matrices 3×3 en Float64Array(9) fila mayor (out[3·r + c]). Los `out`
     * de multiply/rotateTensor/jacobiEigen no pueden aliasar las entradas.
     */
    const _mScratch1 = new Float64Array(9);
    const _mScratch2 = new Float64Array(9);
    const _mScratch3 = new Float64Array(9);
    const Mat3 = {
        identity(out) {
            out.fill(0);
            out[0] = 1;
            out[4] = 1;
            out[8] = 1;
            return out;
        },

        multiply(out, a, b) {
            const a0 = a[0];
            const a1 = a[1];
            const a2 = a[2];
            const a3 = a[3];
            const a4 = a[4];
            const a5 = a[5];
            const a6 = a[6];
            const a7 = a[7];
            const a8 = a[8];
            const b0 = b[0];
            const b1 = b[1];
            const b2 = b[2];
            const b3 = b[3];
            const b4 = b[4];
            const b5 = b[5];
            const b6 = b[6];
            const b7 = b[7];
            const b8 = b[8];
            out[0] = a0 * b0 + a1 * b3 + a2 * b6;
            out[1] = a0 * b1 + a1 * b4 + a2 * b7;
            out[2] = a0 * b2 + a1 * b5 + a2 * b8;
            out[3] = a3 * b0 + a4 * b3 + a5 * b6;
            out[4] = a3 * b1 + a4 * b4 + a5 * b7;
            out[5] = a3 * b2 + a4 * b5 + a5 * b8;
            out[6] = a6 * b0 + a7 * b3 + a8 * b6;
            out[7] = a6 * b1 + a7 * b4 + a8 * b7;
            out[8] = a6 * b2 + a7 * b5 + a8 * b8;
            return out;
        },

        transpose(out, a) {
            const a0 = a[0];
            const a1 = a[1];
            const a2 = a[2];
            const a3 = a[3];
            const a4 = a[4];
            const a5 = a[5];
            const a6 = a[6];
            const a7 = a[7];
            const a8 = a[8];
            out[0] = a0;
            out[1] = a3;
            out[2] = a6;
            out[3] = a1;
            out[4] = a4;
            out[5] = a7;
            out[6] = a2;
            out[7] = a5;
            out[8] = a8;
            return out;
        },

        /** out ({x,y,z}) = m·v. */
        mulVec(out, m, v) {
            const x = m[0] * v.x + m[1] * v.y + m[2] * v.z;
            const y = m[3] * v.x + m[4] * v.y + m[5] * v.z;
            const z = m[6] * v.x + m[7] * v.y + m[8] * v.z;
            out.x = x;
            out.y = y;
            out.z = z;
            return out;
        },

        /** out (Float64Array) = matriz de rotación de q (igual que Quat.toMat3). */
        fromQuat(out, q) {
            return Quat.toMat3(out, q);
        },

        /** out = R·I·Rᵀ (tensor de inercia rotado; I simétrica 3×3). */
        rotateTensor(out, R, I) {
            Mat3.multiply(_mScratch1, R, I);
            Mat3.transpose(_mScratch2, R);
            return Mat3.multiply(out, _mScratch1, _mScratch2);
        },

        /** out = inversa de la matriz simétrica m (sin validar simetría). */
        inverseSym(out, m) {
            const c0 = m[0];
            const c1 = m[1];
            const c2 = m[2];
            const c3 = m[4];
            const c4 = m[5];
            const c5 = m[8];
            // cofactores de la simétrica [[c0,c1,c2],[c1,c3,c4],[c2,c4,c5]]
            const i0 = c3 * c5 - c4 * c4;
            const i1 = c2 * c4 - c1 * c5;
            const i2 = c1 * c4 - c2 * c3;
            const i4 = c0 * c5 - c2 * c2;
            const i5 = c1 * c2 - c0 * c4;
            const i8 = c0 * c3 - c1 * c1;
            const det = c0 * i0 + c1 * i1 + c2 * i2;
            if (!isFinite(det) || det === 0) {
                throw new Error('Matriz simétrica singular: no se puede invertir');
            }
            const inv = 1 / det;
            out[0] = i0 * inv;
            out[1] = i1 * inv;
            out[2] = i2 * inv;
            out[3] = i1 * inv;
            out[4] = i4 * inv;
            out[5] = i5 * inv;
            out[6] = i2 * inv;
            out[7] = i5 * inv;
            out[8] = i8 * inv;
            return out;
        },

        /**
         * Descomposición espectral de una matriz simétrica 3×3 por iteración
         * de Jacobi (cíclica, umbral relativo). Devuelve los autovalores en
         * `evals` ({x,y,z}, orden ascendente) y los vectores propios como
         * COLUMNAS de `evecs` (Float64Array(9) fila mayor: vector z →
         * (evecs[6], evecs[7], evecs[8])). Devuelve false si no converge.
         */
        jacobiEigen(evals, evecs, m) {
            const a = _mScratch1;
            a.set(m);
            const v = _mScratch2;
            Mat3.identity(v);
            const j = _mScratch3;
            const t1 = new Float64Array(9);

            let scale = 0;
            for (let i = 0; i < 9; i++) {
                scale = Math.max(scale, Math.abs(a[i]));
            }
            if (scale === 0) {
                Mat3.identity(evecs);
                evals.x = 0;
                evals.y = 0;
                evals.z = 0;
                return true;
            }
            const eps = 1e-15 * scale;

            for (let sweep = 0; sweep < 64; sweep++) {
                let off = 0;
                for (let i = 0; i < 3; i++) {
                    for (let k = i + 1; k < 3; k++) {
                        off = Math.max(off, Math.abs(a[i * 3 + k]));
                    }
                }
                if (off <= eps) {
                    // pares (autovalor, columna) ordenados ascendente
                    const cols = [
                        { val: a[0], col: 0 },
                        { val: a[4], col: 1 },
                        { val: a[8], col: 2 },
                    ].sort((p, q) => p.val - q.val);
                    for (let c = 0; c < 3; c++) {
                        const src = cols[c];
                        if (c === 0) evals.x = src.val;
                        else if (c === 1) evals.y = src.val;
                        else evals.z = src.val;
                        for (let r = 0; r < 3; r++) {
                            evecs[r * 3 + c] = v[r * 3 + src.col];
                        }
                    }
                    return true;
                }
                // rotaciones de Givens cíclicas: A ← Jᵀ·A·J, V ← V·J
                for (let p = 0; p < 2; p++) {
                    for (let q = p + 1; q < 3; q++) {
                        const apq = a[p * 3 + q];
                        if (Math.abs(apq) <= eps) {
                            continue;
                        }
                        const tau = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
                        const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
                        const c = 1 / Math.sqrt(t * t + 1);
                        const s = t * c;
                        // J: rotación de columnas p,q
                        Mat3.identity(j);
                        j[p * 3 + p] = c;
                        j[p * 3 + q] = s;
                        j[q * 3 + p] = -s;
                        j[q * 3 + q] = c;
                        Mat3.multiply(t1, a, j);  // A·J
                        Mat3.multiply(v, v, j);   // V·J (same J)
                        Mat3.transpose(j, j);     // Jᵀ
                        Mat3.multiply(a, j, t1);  // Jᵀ·(A·J)
                    }
                }
            }
            return false;
        },
    };

    SimRocas.V3 = V3;
    SimRocas.Quat = Quat;
    SimRocas.Mat3 = Mat3;
})(globalThis.SimRocas);
