/**
 * SimRocas 3D — contacto no suave para cuerpos rígidos sobre el DEM
 * (fase F5, T5.4 + T5.5; extensión C7-rigid del contrato C7).
 *
 * Motor paso a paso para `PhysicsEngine3D.method = 'rigid-body'`. Rock3D lleva
 * un RigidBody3D (js/rigid3d.js, forma principal de ConvexShape3D) y el
 * contacto se resuelve con impulsos secuenciales (Leine et al. 2013; Moreau
 * 1988; referencia 2D validada: js/physics.js _handleNonsmooth):
 *   - normal: ley de Newton con restitución `restitutionN` SOLO en impacto
 *     (|vn| >= slideVelocityThreshold, normal REAL antes de rugosidad,
 *     criterio T0.7 fix 1); en contacto sostenido restitución 0 (Poisson).
 *   - tangencial: cono de Coulomb con μ = `frictionMu`: impulso libre que
 *     anula el deslizamiento del punto de contacto, acotado a μ·jn_total
 *     (stick/slip automático) — signo corregido como en el 2D (T0.7 fix 3).
 *   - hasta 4 contactos más profundos (vértices), 4 iteraciones secuenciales
 *     por sub-paso; masa efectiva con el tensor de inercia en mundo:
 *     k = 1/m + (r×d)·I_world⁻¹·(r×d).
 *   - restitución aplicada UNA vez por contacto y sub-paso (las iteraciones
 *     siguientes solo persiguen vn = 0; evita sobreaplicar la restitución).
 *   - corrección de posición por la penetración máxima (levanta a lo largo de
 *     la normal del DEM: Δp = n·pen) con cargo de energía como
 *     `_penetrationCorrection` 2D: el ascenso m·g·lift se descuenta de la
 *     rapidez (energéticamente neutro; velocidad intacta si no alcanza).
 *   - rugosidad CRSP perturbando la normal SOLO en impactos.
 *   - amortiguamiento angular en contacto (rollingResistance): |ω| decrece
 *     rollingResistance·g·n.z/boundingRadius por segundo, sin invertir.
 *   - reposo: speed < restThreshold·slopeFactor y |ω| < restAngularThreshold
 *     durante 3 chequeos CONSECUTIVOS con contacto (slopeFactor =
 *     max(0.1, 1 − 2·tanθ), idem 2D/G7).
 *   - culling: fuera del DEM o celda sin dato → 'culled' (idem lumped-mass).
 *
 * Contacto por VÉRTICES sobre el casco convexo (el DEM es una malla de
 * alturas; sin cara-contra-cara ni aristas contra celdas — ver limitaciones
 * en docs/contracts-3d.md). Sub-pasos adaptativos por velocidad máxima de
 * vértice: |v| + |ω|·boundingRadius (+ g·dt).
 *
 * Además expone `SimRocas.Rigid3DFactory`: construcción de la forma principal
 * (irregular/box/ellipsoid) y de la actitud inicial a partir de la spec, con
 * un PRNG sembrado por `shapeSeed` para que el pool reproduzca la forma.
 *
 * Coordenadas locales del DEM: x este, y norte, z arriba; gravedad (0, 0, −g).
 * Puro en datos: sin DOM; funciona en ventana, Web Worker y Node (load.js).
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    const V3 = SimRocas.V3;

    /** Contactos (vértices) resueltos por sub-paso. */
    const MAX_CONTACTS = 4;
    /** Iteraciones del solver de impulsos secuenciales por sub-paso. */
    const SOLVER_ITERATIONS = 4;

    // ------------------------------------------------------------------
    // Factoría de formas rígidas (specs → forma principal + actitud)
    // ------------------------------------------------------------------

    const Rigid3DFactory = {
        /**
         * Construye la forma principal (toPrincipal) a partir de una spec:
         *   { shape: 'irregular'|'box'|'ellipsoid', diameter, density,
         *     aspect?: {b, c} relativos (defecto 1), segments? (ellipsoid),
         *     shapeSeed }.
         * La forma 'irregular' consume el rng sembrado (shapeSeed) para que
         * el pool reproduzca exactamente la misma forma.
         */
        buildPrincipal(spec, rng) {
            if (!spec || !(spec.diameter > 0)) {
                throw new Error('Rigid3DFactory.buildPrincipal: spec.diameter debe ser > 0');
            }
            if (!(spec.density > 0)) {
                throw new Error('Rigid3DFactory.buildPrincipal: spec.density debe ser > 0');
            }
            if (typeof rng !== 'function') {
                throw new Error('Rigid3DFactory.buildPrincipal: necesita un rng sembrado (shapeSeed)');
            }
            if (typeof SimRocas.ConvexShape3D !== 'object') {
                throw new Error('Rigid3DFactory.buildPrincipal: falta js/rigid3d.js (SimRocas.ConvexShape3D)');
            }
            const shape = spec.shape !== undefined ? spec.shape : 'irregular';
            const aspect = spec.aspect || { b: 1, c: 1 };
            if (!(aspect.b > 0) || !(aspect.c > 0)) {
                throw new Error('Rigid3DFactory.buildPrincipal: aspect.b y aspect.c deben ser > 0');
            }
            const d = spec.diameter;
            const r = d / 2;
            let hull;
            if (shape === 'irregular') {
                hull = SimRocas.ConvexShape3D.irregular(d, rng, {});
            } else if (shape === 'box') {
                hull = SimRocas.ConvexShape3D.box(d, d * aspect.b, d * aspect.c);
            } else if (shape === 'ellipsoid') {
                const segments = spec.segments !== undefined ? spec.segments : 16;
                hull = SimRocas.ConvexShape3D.ellipsoid(r, r * aspect.b, r * aspect.c, segments);
            } else {
                throw new Error('Rigid3DFactory.buildPrincipal: shape "' + String(shape) + '" no soportada (usar "irregular", "box" o "ellipsoid")');
            }
            return SimRocas.ConvexShape3D.toPrincipal(hull, spec.density);
        },

        /**
         * Actitud inicial reproducible: orientación aleatoria (cuaternión
         * unitario por eje aleatorio + ángulo uniforme en [0, 2π)) y ω
         * inicial pequeña (|ω| ≤ omegaMax, defecto 0.2 rad/s) alrededor del
         * mismo eje. Consume el rng de la spec (determinista por roca).
         */
        initOrientation(rng, omegaMax = 0.2) {
            let ax = 0;
            let ay = 0;
            let az = 0;
            let l2 = 0;
            do {
                ax = 2 * rng() - 1;
                ay = 2 * rng() - 1;
                az = 2 * rng() - 1;
                l2 = ax * ax + ay * ay + az * az;
            } while (l2 < 1e-6 || l2 > 1);
            const inv = 1 / Math.sqrt(l2);
            ax *= inv;
            ay *= inv;
            az *= inv;
            const angle = rng() * Math.PI * 2;
            const orientation = SimRocas.Quat.fromAxisAngle({}, { x: ax, y: ay, z: az }, angle);
            const angularVelocity = { x: 0, y: 0, z: 0 };
            if (omegaMax > 0) {
                const mag = omegaMax * rng();
                angularVelocity.x = ax * mag;
                angularVelocity.y = ay * mag;
                angularVelocity.z = az * mag;
            }
            return { orientation: orientation, angularVelocity: angularVelocity };
        },
    };

    // ------------------------------------------------------------------
    // Paso rígido (llamado por PhysicsEngine3D.simulateStep)
    // ------------------------------------------------------------------

    /**
     * Paso completo (dt del motor) de una roca rígida: sub-pasos adaptativos,
     * contactos por vértices con impulsos secuenciales y registro de
     * trayectoria + orientaciones. Instalado como `engine.simulateStepRigid`.
     */
    function simulateStepRigid(rock, dem) {
        if (!rock.body) {
            throw new Error('simulateStep: method "rigid-body" necesita una Rock3D con body (RigidBody3D)');
        }
        const body = rock.body;
        const dt = this.dt;
        const g = this.gravity;

        // Parámetros con gancho de material (una vez por paso, como lumped).
        let restitutionN = this.restitutionN;
        let frictionMu = this.frictionMu;
        let rollingResistance = this.rollingResistance;
        let roughnessDeg = this.roughnessDeg;
        if (this.materialAt) {
            const mat = this.materialAt(rock.x, rock.y);
            if (mat) {
                if (mat.restitutionN !== undefined) { restitutionN = mat.restitutionN; }
                if (mat.frictionMu !== undefined) { frictionMu = mat.frictionMu; }
                if (mat.rollingResistance !== undefined) { rollingResistance = mat.rollingResistance; }
                if (mat.roughnessDeg !== undefined) { roughnessDeg = mat.roughnessDeg; }
            }
        }

        // Sub-pasos adaptativos por velocidad máxima de vértice:
        //   vEst = |v| + |ω|·boundingRadius (+ g·dt como el 2D/lumped).
        const v = body.velocity;
        const w = body.angularVelocityWorld;
        const vEst = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) +
            Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z) * body.boundingRadius + g * dt;
        const subSteps = Math.min(64, Math.max(3,
            Math.ceil(dt * vEst / this.maxSubStepDisplacement)));
        const h = dt / subSteps;

        for (let s = 0; s < subSteps && !rock.isResting; s++) {
            // 1) Movimiento libre (traslación exacta + rotación midpoint).
            body.integrateFree(h, this._gRigid);
            if (globalThis.__RIGID_DEBUG) {
                console.log('[DBG] substep s=%d z=%s vz=%s', s, body.position.z.toFixed(5), body.velocity.z.toFixed(4));
            }

            // 2) Culling en el centro de masa (idem lumped-mass).
            const hCom = dem.heightAt(body.position.x, body.position.y);
            if (Number.isNaN(hCom) || dem.normalAt(body.position.x, body.position.y, this._n) === null) {
                rock.isResting = true;
                rock.stopReason = 'culled';
                break;
            }

            // 3) Contacto + impulsos secuenciales + corrección + rodadura.
            if (!resolveContactsRigid.call(this, rock, dem, restitutionN, frictionMu,
                rollingResistance, roughnessDeg, h)) {
                // sin contacto: el estado de contacto sostenido cesa y el
                // contador de chequeos de reposo se reinicia (3 consecutivos).
                rock.sustainedContact = false;
                rock._restCheckCount = 0;
                continue;
            }
            rock._restCheckCount++;

            // 4) Reposo (3 chequeos consecutivos con contacto).
            if (checkRestRigid.call(this, rock, dem)) {
                break;
            }
        }

        // --- cola común: sincronización, métricas, trayectoria ------------
        rock.stepsTaken++;
        rock.elapsedTime += dt;
        rock.x = body.position.x;
        rock.y = body.position.y;
        rock.z = body.position.z;
        rock.vx = body.velocity.x;
        rock.vy = body.velocity.y;
        rock.vz = body.velocity.z;

        const ke = rock.kineticEnergy;
        if (ke > rock.maxKineticEnergy) {
            rock.maxKineticEnergy = ke;
        }
        rock.finalX = body.position.x;
        rock.finalY = body.position.y;
        rock.finalZ = body.position.z;

        if (rock.isResting) {
            recordTrajectoryRigid(this, rock);
        } else {
            rock._trajStepCounter++;
            if (rock._trajStepCounter % rock.trajectoryInterval === 0) {
                recordTrajectoryRigid(this, rock);
            }
        }
    }

    /** Registra el cuádruplo (x, y, z, speed) y el cuaternión actual. */
    function recordTrajectoryRigid(engine, rock) {
        engine._recordTrajectory(rock);
        recordOrientation(engine, rock);
    }

    /**
     * Anota el cuaternión en `rock.orientations` (4 floats por muestra,
     * alineada con la trayectoria). Al llenarse, compacta a la mitad como la
     * trayectoria para mantener la alineación temporal.
     */
    function recordOrientation(engine, rock) {
        if (!rock.orientations) {
            return;
        }
        if (rock._orientLength >= rock.maxTrajectoryPoints) {
            downsampleOrientations(rock);
            if (rock._orientLength >= rock.maxTrajectoryPoints) {
                rock._orientLength = rock.maxTrajectoryPoints - 1;
            }
        }
        const q = rock.body.orientation;
        const pos = rock._orientLength * 4;
        rock.orientations[pos] = q.w;
        rock.orientations[pos + 1] = q.x;
        rock.orientations[pos + 2] = q.y;
        rock.orientations[pos + 3] = q.z;
        rock._orientLength++;
    }

    function downsampleOrientations(rock) {
        const arr = rock.orientations;
        const n = rock._orientLength;
        let write = 0;
        for (let i = 0; i < n; i += 2) {
            const src = i * 4;
            arr[write++] = arr[src];
            arr[write++] = arr[src + 1];
            arr[write++] = arr[src + 2];
            arr[write++] = arr[src + 3];
        }
        rock._orientLength = write;
    }

    /**
     * Detecta los vértices penetrados (hasta MAX_CONTACTS más profundos por
     * penetración a lo largo de la normal del DEM), resuelve impulsos
     * secuenciales, corrige la posición y amortigua la rotación.
     * @returns {boolean} true si hubo al menos un contacto.
     */
    function resolveContactsRigid(rock, dem, restitutionN, frictionMu,
        rollingResistance, roughnessDeg, h) {
        const body = rock.body;
        const sc = this._rigidScratch;
        // velocidades por referencia (el solver muta estos objetos in situ)
        const v = body.velocity;
        const w = body.angularVelocityWorld;
        const verts = body.worldVertices();
        const pos = body.position;
        const invM = 1 / body.mass;

        // 1) Vértices bajo el terreno: pen = (hT − vz)·n.z (a lo largo de la
        //    normal del DEM en el (x, y) del vértice). Top-MAX_CONTACTS.
        let count = 0;
        const vc = body.shape.vertexCount;
        if (globalThis.__RIGID_DEBUG) { console.log('[DBG] resolve enter posZ=%s vZ=%s verts=%d', body.position.z.toFixed(5), body.velocity.z.toFixed(4), vc); }
        for (let i = 0; i < vc; i++) {
            const vx = verts[3 * i];
            const vy = verts[3 * i + 1];
            const vz = verts[3 * i + 2];
            const hT = dem.heightAt(vx, vy);
            if (!(hT > vz)) {
                continue; // sin contacto (NaN también cae aquí)
            }
            if (globalThis.__RIGID_DEBUG) { console.log('[DBG] vert %d hit: vz=%s hT=%s', i, vz.toFixed(5), hT.toFixed(5)); }
            const n = dem.normalAt(vx, vy, sc.nTmp);
            if (n === null || !(n.nz > 0)) {
                continue;
            }
            const pen = (hT - vz) * n.nz;
            if (!(pen > 0)) {
                continue;
            }
            if (count < MAX_CONTACTS) {
                sc.slotVert[count] = i;
                sc.slotPen[count] = pen;
                sc.slotHeight[count] = hT;
                count++;
            } else {
                let minJ = 0;
                for (let j = 1; j < MAX_CONTACTS; j++) {
                    if (sc.slotPen[j] < sc.slotPen[minJ]) { minJ = j; }
                }
                if (pen > sc.slotPen[minJ]) {
                    sc.slotVert[minJ] = i;
                    sc.slotPen[minJ] = pen;
                    sc.slotHeight[minJ] = hT;
                }
            }
        }
        if (count === 0) {
            return false;
        }
        // orden descendente por penetración (inserción, ≤ 4 elementos)
        for (let i = 1; i < count; i++) {
            const vi = sc.slotVert[i];
            const pi = sc.slotPen[i];
            const hi = sc.slotHeight[i];
            let j = i - 1;
            while (j >= 0 && sc.slotPen[j] < pi) {
                sc.slotVert[j + 1] = sc.slotVert[j];
                sc.slotPen[j + 1] = sc.slotPen[j];
                sc.slotHeight[j + 1] = sc.slotHeight[j];
                j--;
            }
            sc.slotVert[j + 1] = vi;
            sc.slotPen[j + 1] = pi;
            sc.slotHeight[j + 1] = hi;
        }
        const nContacts = count;

        // 2) Normales del DEM y brazos r por contacto (fijos durante el solve).
        //    La normal del MÁS PROFUNDO se guarda real (restNx/restNz) para la
        //    corrección de posición y el reposo; la rugosidad solo reemplaza
        //    la normal usada por el IMPULSO (slot 0).
        for (let i = 0; i < nContacts; i++) {
            const px = verts[3 * sc.slotVert[i]];
            const py = verts[3 * sc.slotVert[i] + 1];
            const pz = verts[3 * sc.slotVert[i] + 2];
            sc.rx[i] = px - pos.x;
            sc.ry[i] = py - pos.y;
            sc.rz[i] = pz - pos.z;
            const n = dem.normalAt(px, py, sc.nTmp);
            sc.nx[i] = n !== null ? n.nx : 0;
            sc.ny[i] = n !== null ? n.ny : 0;
            sc.nz[i] = n !== null ? n.nz : 1;
        }
        sc.restNx = sc.nx[0];
        sc.restNy = sc.ny[0];
        sc.restNz = sc.nz[0];

        // 3) Clasificación impacto/sostenido con la normal REAL del más
        //    profundo (criterio T0.7 fix 1 del 2D, trasladado a 3D).
        const wcx0 = v.x + w.y * sc.rz[0] - w.z * sc.ry[0];
        const wcy0 = v.y + w.z * sc.rx[0] - w.x * sc.rz[0];
        const wcz0 = v.z + w.x * sc.ry[0] - w.y * sc.rx[0];
        const vn0 = wcx0 * sc.nx[0] + wcy0 * sc.ny[0] + wcz0 * sc.nz[0];
        const isImpact = (-vn0 >= this.slideVelocityThreshold) && restitutionN > 0;
        sc.isImpact[0] = isImpact ? 1 : 0;

        // Rugosidad: perturbar la normal del impacto (solo impactos).
        if (isImpact && roughnessDeg > 0) {
            const rn = this._perturbNormal(sc.nx[0], sc.ny[0], sc.nz[0], roughnessDeg);
            if (rn) {
                const vnR = v.x * rn.x + v.y * rn.y + v.z * rn.z +
                    (w.y * sc.rz[0] - w.z * sc.ry[0]) * rn.x +
                    (w.z * sc.rx[0] - w.x * sc.rz[0]) * rn.y +
                    (w.x * sc.ry[0] - w.y * sc.rx[0]) * rn.z;
                if (vnR < 0) {
                    sc.nx[0] = rn.x;
                    sc.ny[0] = rn.y;
                    sc.nz[0] = rn.z;
                }
            }
        }

        // 4b) Clasificación por contacto (normal REAL, antes de rugosidad):
        //     |vn0| >= umbral → impacto con objetivo vn* = −en·vn0 (Newton);
        //     resto → sostenido con objetivo vn* = 0 (restitución 0).
        const R = this._rigidR;
        SimRocas.Quat.toMat3(R, body.orientation);
        const ix = body.invInertiaDiag.x;
        const iy = body.invInertiaDiag.y;
        const iz = body.invInertiaDiag.z;
        for (let i = 0; i < nContacts; i++) {
            const rx = sc.rx[i];
            const ry = sc.ry[i];
            const rz = sc.rz[i];
            const nx = sc.nx[i];
            const ny = sc.ny[i];
            const nz = sc.nz[i];
            // r×n
            sc.rNx[i] = ry * nz - rz * ny;
            sc.rNy[i] = rz * nx - rx * nz;
            sc.rNz[i] = rx * ny - ry * nx;
            // I⁻¹_w·(r×n) = R·diag(ix,iy,iz)·(Rᵀ·(r×n))
            const bx = R[0] * sc.rNx[i] + R[3] * sc.rNy[i] + R[6] * sc.rNz[i];
            const by = R[1] * sc.rNx[i] + R[4] * sc.rNy[i] + R[7] * sc.rNz[i];
            const bz = R[2] * sc.rNx[i] + R[5] * sc.rNy[i] + R[8] * sc.rNz[i];
            sc.cx[i] = R[0] * (bx * ix) + R[1] * (by * iy) + R[2] * (bz * iz);
            sc.cy[i] = R[3] * (bx * ix) + R[4] * (by * iy) + R[5] * (bz * iz);
            sc.cz[i] = R[6] * (bx * ix) + R[7] * (by * iy) + R[8] * (bz * iz);
            sc.fn[i] = invM + sc.rNx[i] * sc.cx[i] + sc.rNy[i] * sc.cy[i] + sc.rNz[i] * sc.cz[i];
            // vn0 = v·n + ω·(r×n) (identidad (ω×r)·n = ω·(r×n))
            const vn0i = v.x * nx + v.y * ny + v.z * nz +
                w.x * sc.rNx[i] + w.y * sc.rNy[i] + w.z * sc.rNz[i];
            if (vn0i < -this.slideVelocityThreshold && restitutionN > 0) {
                sc.impactFl[i] = 1;
                sc.vnTarget[i] = -restitutionN * vn0i;
            } else {
                sc.impactFl[i] = 0;
                sc.vnTarget[i] = 0;
            }
            sc.jnTotal[i] = 0;
            sc.jtTotal[i] = 0;
        }

        // 5) Iteraciones secuenciales: normal (Newton una vez, luego a vn=0)
        //    + cono de Coulomb sobre el impulso normal ACUMULADO.
        sc.keStart = body.kineticEnergy();
        if (globalThis.__RIGID_DEBUG) {
            console.log('[DBG] contacts=%d isImpact=%s pen0=%s vn0=%s targets=%s fn=%s impFl=%s',
                nContacts, isImpact, sc.slotPen[0].toFixed(5), vn0.toFixed(4),
                Array.prototype.slice.call(sc.vnTarget).map((x) => x.toFixed(2)),
                Array.prototype.slice.call(sc.fn).map((x) => (x * body.mass).toFixed(3)),
                Array.prototype.slice.call(sc.impactFl));
            console.log('[DBG] normals x:', Array.prototype.slice.call(sc.nx).map((x) => x.toFixed(3)),
                'y:', Array.prototype.slice.call(sc.ny).map((x) => x.toFixed(3)),
                'z:', Array.prototype.slice.call(sc.nz).map((x) => x.toFixed(3)));
        }
        for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
            // barrido SIMÉTRICO: adelante en iteraciones pares, atrás en
            // impares — compensa el orden sistemático de Gauss-Seidel
            // (reduce el sobreimpulso y el par residual en contactos
            // coplanares, p. ej. las 4 esquinas de una cara plana).
            const fwd = (iter % 2 === 0);
            for (let k = 0; k < nContacts; k++) {
                const i = fwd ? k : (nContacts - 1 - k);
                const rx = sc.rx[i];
                const ry = sc.ry[i];
                const rz = sc.rz[i];
                const nx = sc.nx[i];
                const ny = sc.ny[i];
                const nz = sc.nz[i];
                // wc = v + ω×r
                const wcx = v.x + w.y * rz - w.z * ry;
                const wcy = v.y + w.z * rx - w.x * rz;
                const wcz = v.z + w.x * ry - w.y * rx;
                const vn = wcx * nx + wcy * ny + wcz * nz;
                let jn = (sc.vnTarget[i] - vn) / sc.fn[i];
                if (jn <= 0) {
                    continue; // ya separándose o por encima del objetivo
                }
                sc.jnTotal[i] += jn;
                v.x += jn * nx * invM;
                v.y += jn * ny * invM;
                v.z += jn * nz * invM;
                w.x += sc.cx[i] * jn;
                w.y += sc.cy[i] * jn;
                w.z += sc.cz[i] * jn;

                // --- cono de Coulomb: impulso tangencial que anula el
                // deslizamiento del punto, acotado al HOLGURA del cono
                // acumulado (Σjt ≤ μ·Σjn; stick/slip).
                const wcfx = v.x + w.y * rz - w.z * ry;
                const wcfy = v.y + w.z * rx - w.x * rz;
                const wcfz = v.z + w.x * ry - w.y * rx;
                const vnF = wcfx * nx + wcfy * ny + wcfz * nz;
                const vtx = wcfx - vnF * nx;
                const vty = wcfy - vnF * ny;
                const vtz = wcfz - vnF * nz;
                const vtSp = Math.sqrt(vtx * vtx + vty * vty + vtz * vtz);
                if (vtSp > 1e-12) {
                    // dirección OPUESTA al deslizamiento (signo corregido,
                    // T0.7 fix 3 del 2D): t̂ = −vt/|vt|
                    const tx = -vtx / vtSp;
                    const ty = -vty / vtSp;
                    const tz = -vtz / vtSp;
                    const rTx = ry * tz - rz * ty;
                    const rTy = rz * tx - rx * tz;
                    const rTz = rx * ty - ry * tx;
                    const bx = R[0] * rTx + R[3] * rTy + R[6] * rTz;
                    const by = R[1] * rTx + R[4] * rTy + R[7] * rTz;
                    const bz = R[2] * rTx + R[5] * rTy + R[8] * rTz;
                    const cx = R[0] * (bx * ix) + R[1] * (by * iy) + R[2] * (bz * iz);
                    const cy = R[3] * (bx * ix) + R[4] * (by * iy) + R[5] * (bz * iz);
                    const cz = R[6] * (bx * ix) + R[7] * (by * iy) + R[8] * (bz * iz);
                    const ft = invM + rTx * cx + rTy * cy + rTz * cz;
                    const jtFree = vtSp / ft; // stick completo
                    const jtHead = frictionMu * sc.jnTotal[i] - sc.jtTotal[i];
                    const jt = Math.min(jtFree, Math.max(0, jtHead));
                    if (jt > 0) {
                        sc.jtTotal[i] += jt;
                        v.x += jt * tx * invM;
                        v.y += jt * ty * invM;
                        v.z += jt * tz * invM;
                        w.x += cx * jt;
                        w.y += cy * jt;
                        w.z += cz * jt;
                    }
                }
                if (globalThis.__RIGID_DEBUG) {
                    console.log('[DBG] it=%d i=%d vn=%s fn=%s jn=%s vz=%s', iter, i, vn.toFixed(4), (sc.fn[i] * body.mass).toFixed(3), jn.toFixed(1), v.z.toFixed(4));
                }
            }
        }

        // 6) Corrección de posición por la penetración máxima a lo largo de
        //    la normal REAL del contacto más profundo: Δp = n·pen (la
        //    rugosidad NO altera la geometría). El ascenso (componente
        //    vertical) se cobra a la rapidez como en 2D.
        const pen0 = sc.slotPen[0];
        const nx0 = sc.restNx;
        const ny0 = sc.restNy;
        const nz0 = sc.restNz;
        pos.x += nx0 * pen0;
        pos.y += ny0 * pen0;
        pos.z += nz0 * pen0;
        if (isImpact) {
            const rise = Math.max(0, nz0 * pen0);
            const margin = Math.min(1e-4, 0.05 * rise);
            const climbOut = 2 * this.gravity * (rise + margin);
            const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
            if (speedSq > climbOut) {
                const f = Math.sqrt(1 - climbOut / speedSq);
                v.x *= f;
                v.y *= f;
                v.z *= f;
            }
            // si la energía no alcanza, la velocidad queda intacta.
        }

        // 7) Amortiguamiento de rodadura en contacto: |ω| decrece
        //    rollingResistance·g·n.z/boundingRadius por segundo, sin invertir.
        if (rollingResistance > 0) {
            const wm = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
            if (wm > 0) {
                const decel = rollingResistance * this.gravity * nz0 / body.boundingRadius;
                const next = wm - decel * h;
                const target = next > 0 ? next : 0;
                const fW = target / wm;
                w.x *= fW;
                w.y *= fW;
                w.z *= fW;
            }
        }

        // 8) Energía disipada por el contacto (impulsos + fricción; el cargo
        //    del ascenso ya redujo la KE y también computa).
        const keAfter = body.kineticEnergy();
        if (sc.keStart > keAfter) {
            rock.totalEnergyDissipated += sc.keStart - keAfter;
        }

        // 9) Registro del impacto (uno por sub-paso, como el 2D por contacto).
        if (globalThis.__RIGID_DEBUG && nContacts > 0) {
            let jtSum = 0; let jnSum = 0;
            for (let i = 0; i < nContacts; i++) { jnSum += sc.jnTotal[i]; jtSum += sc.jtTotal[i]; }
            console.log('[DBG]  post: imp=%s jnSum=%f jtSum=%f ratio=%s vx=%s w=%s',
                isImpact, jnSum / body.mass, jtSum / body.mass, (jtSum / jnSum).toFixed(3), body.velocity.x.toFixed(4),
                Math.hypot(body.angularVelocityWorld.x, body.angularVelocityWorld.y, body.angularVelocityWorld.z).toFixed(4));
        }
        if (isImpact) {
            rock.bounces++;
            const impactSpeed = -vn0;
            if (impactSpeed > rock.maxImpactVelocity) {
                rock.maxImpactVelocity = impactSpeed;
            }
            if (rock.impacts.length < rock.maxImpactsRecorded) {
                rock.impacts.push({
                    x: pos.x,
                    y: pos.y,
                    z: sc.slotHeight[0],
                    energyKJ: rock.kineticEnergy / 1000,
                    vn: vn0,
                });
            }
        } else {
            rock.sustainedContact = true;
        }
        return true;
    }

    /**
     * Criterio de reposo rígido: 3 chequeos consecutivos con contacto
     * (el contador se reinicia al volar, en simulateStepRigid), speed <
     * restThreshold·slopeFactor, |ω| < restAngularThreshold y contacto
     * sostenido (o rebotes previos). Al detener: velocidades a cero.
     */
    function checkRestRigid(rock, dem) {
        const body = rock.body;
        if (rock._restCheckCount < 3) {
            return false;
        }
        const sc = this._rigidScratch;
        const tanTheta = Math.sqrt(sc.restNx * sc.restNx + sc.restNy * sc.restNy) /
            Math.max(sc.restNz, 1e-9);
        const slopeFactor = Math.max(0.1, 1 - 2 * tanTheta);
        const v = body.velocity;
        const w = body.angularVelocityWorld;
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        const omega = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
        if (speed < this.restThreshold * slopeFactor &&
            omega < this.restAngularThreshold &&
            (rock.bounces > 2 || rock.sustainedContact)) {
            rock.isResting = true;
            rock.stopReason = 'rest';
            body.velocity.x = 0;
            body.velocity.y = 0;
            body.velocity.z = 0;
            body.angularVelocityWorld.x = 0;
            body.angularVelocityWorld.y = 0;
            body.angularVelocityWorld.z = 0;
            rock.vx = 0;
            rock.vy = 0;
            rock.vz = 0;
            rock.finalX = body.position.x;
            rock.finalY = body.position.y;
            rock.finalZ = body.position.z;
            return true;
        }
        void dem;
        return false;
    }

    // ------------------------------------------------------------------
    // Instalación: buffers por motor (sin asignación en el bucle caliente)
    // ------------------------------------------------------------------

    function installRigidStatics(engine) {
        engine.simulateStepRigid = simulateStepRigid;
        engine._gRigid = { x: 0, y: 0, z: -engine.gravity };
        engine._rigidR = new Float64Array(9);
        // Ranuras de contacto (memoria fija, reutilizada por sub-paso).
        engine._rigidScratch = {
            nTmp: { nx: 0, ny: 0, nz: 0 },
            slotVert: new Int32Array(MAX_CONTACTS),
            slotPen: new Float64Array(MAX_CONTACTS),
            slotHeight: new Float64Array(MAX_CONTACTS),
            rx: new Float64Array(MAX_CONTACTS),
            ry: new Float64Array(MAX_CONTACTS),
            rz: new Float64Array(MAX_CONTACTS),
            nx: new Float64Array(MAX_CONTACTS),
            ny: new Float64Array(MAX_CONTACTS),
            nz: new Float64Array(MAX_CONTACTS),
            rNx: new Float64Array(MAX_CONTACTS),
            rNy: new Float64Array(MAX_CONTACTS),
            rNz: new Float64Array(MAX_CONTACTS),
            cx: new Float64Array(MAX_CONTACTS),
            cy: new Float64Array(MAX_CONTACTS),
            cz: new Float64Array(MAX_CONTACTS),
            fn: new Float64Array(MAX_CONTACTS),
            impactFl: new Int32Array(MAX_CONTACTS),
            vnTarget: new Float64Array(MAX_CONTACTS),
            jnTotal: new Float64Array(MAX_CONTACTS),
            jtTotal: new Float64Array(MAX_CONTACTS),
            isImpact: new Int32Array(1),
            restNx: 0,
            restNy: 0,
            restNz: 1,
            keStart: 0,
        };
    }

    SimRocas.Rigid3DFactory = Rigid3DFactory;
    SimRocas.Physics3DRigid = {
        simulateStepRigid: simulateStepRigid,
        installRigidStatics: installRigidStatics,
        Rigid3DFactory: Rigid3DFactory,
        MAX_CONTACTS: MAX_CONTACTS,
        SOLVER_ITERATIONS: SOLVER_ITERATIONS,
    };
})(globalThis.SimRocas);
