/**
 * SimRocas 3D — física de masa concentrada (lumped mass) sobre DEM (contrato C7).
 *
 * Modelo: masa puntual con restitución Kn/Kt (GeoRock/CRSP), contacto sostenido
 * separado del impacto por `slideVelocityThreshold`, corrección de penetración
 * energéticamente neutra (carga del ascenso como `_penetrationCorrection` 2D),
 * fricción de rodadura solo con contacto real y sub-pasos adaptativos (misma
 * fórmula que el motor 2D, T0.12).
 *
 * Coordenadas locales del DEM: x este, y norte, z arriba; gravedad (0, 0, −g).
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Roca 3D de masa puntual.
     */
    class Rock3D {
        /**
         * @param {object} opts
         * @param {number} opts.x Coordenada local X inicial (m).
         * @param {number} opts.y Coordenada local Y inicial (m).
         * @param {number} opts.z Coordenada local Z inicial (centro de la esfera, m).
         * @param {number} [opts.vx=0]
         * @param {number} [opts.vy=0]
         * @param {number} [opts.vz=0]
         * @param {number} opts.diameter Diámetro (m).
         * @param {number} opts.density Densidad (kg/m³).
         * @param {number} [opts.sourceId=0]
         * @param {number} [opts.maxImpactsRecorded=200] Tope del array `impacts`.
         * @param {number} [opts.maxTrajectoryPoints=2500] Capacidad de la trayectoria (cuádruplos).
         * @param {number} [opts.trajectoryInterval=4] Pasos entre muestreos.
         */
        constructor(opts = {}) {
            const diameter = opts.diameter;
            const density = opts.density;
            if (!(diameter > 0)) {
                throw new Error('Rock3D: diámetro inválido (' + diameter + ' m) — debe ser mayor que 0');
            }
            if (!(density > 0)) {
                throw new Error('Rock3D: densidad inválida (' + density + ' kg/m³) — debe ser mayor que 0');
            }

            this.x = opts.x || 0;
            this.y = opts.y || 0;
            this.z = opts.z || 0;
            this.vx = opts.vx || 0;
            this.vy = opts.vy || 0;
            this.vz = opts.vz || 0;

            this.diameter = diameter;
            this.radius = diameter / 2;
            this.density = density;
            // Esfera equivalente: m = ρ · (4/3)·π·r³ (coherente con el 2D).
            this.mass = density * (4 / 3) * Math.PI * this.radius * this.radius * this.radius;
            this.sourceId = opts.sourceId || 0;

            this.isResting = false;
            this.stopReason = null; // null | 'rest' | 'culled' | 'maxSteps' | 'maxTime'
            this.bounces = 0;
            this.stepsTaken = 0;
            this.elapsedTime = 0;
            this.sustainedContact = false;
            this._restCheckCount = 0;
            this.restThreshold = 0.08;
            this.slideVelocityThreshold = 0.5;

            // Métricas.
            this.maxKineticEnergy = 0;
            this.maxImpactVelocity = 0;
            this.maxBounceHeight = 0;
            this.totalEnergyDissipated = 0;
            this.finalX = this.x;
            this.finalY = this.y;
            this.finalZ = this.z;

            // Trayectoria: Float32Array preasignado de cuádruplos (x, y, z, speed),
            // devuelto recortado por getTrajectory(); se compacta a la mitad al
            // llenarse (mismo esquema que el motor 2D).
            this.trajectoryInterval = opts.trajectoryInterval !== undefined ? opts.trajectoryInterval : 4;
            this.maxTrajectoryPoints = opts.maxTrajectoryPoints !== undefined ? opts.maxTrajectoryPoints : 2500;
            this.trajectory = new Float32Array(this.maxTrajectoryPoints * 4);
            this.trajectoryLength = 0;
            this._trajStepCounter = 0;

            // Impactos: { x, y, z, energyKJ, vn } con |vn| >= umbral, tope fijo.
            this.maxImpactsRecorded = opts.maxImpactsRecorded !== undefined ? opts.maxImpactsRecorded : 200;
            this.impacts = [];

            // ------------------------------------------------------------------
            // Extensión C7-rigid (T5.3): cuerpo rígido con forma real.
            // ------------------------------------------------------------------
            if (opts.method === 'rigid-body') {
                if (typeof SimRocas.RigidBody3D !== 'function') {
                    throw new Error('Rock3D: method "rigid-body" requiere js/rigid3d.js (SimRocas.RigidBody3D)');
                }
                const principal = opts.principal;
                if (!principal || !(principal.mass > 0) || !principal.vertices || !principal.faces) {
                    throw new Error('Rock3D: method "rigid-body" necesita principal (resultado de ConvexShape3D.toPrincipal) con masa positiva');
                }
                this.method = 'rigid-body';
                this.shapeKind = opts.shape !== undefined ? opts.shape : 'irregular';
                this.shapeSeed = opts.shapeSeed !== undefined ? opts.shapeSeed : null;
                // Masa = densidad · volumen REAL de la forma (a diferencia del
                // modo masa concentrada, que usa la esfera equivalente del
                // diámetro: un irregular de d=1 tiene volumen menor que 0.52).
                this.mass = principal.mass;
                this.volume = principal.volume;
                this.boundingRadius = principal.boundingRadius;
                this.body = new SimRocas.RigidBody3D(principal, {
                    position: { x: this.x, y: this.y, z: this.z },
                    velocity: { x: this.vx, y: this.vy, z: this.vz },
                    orientation: opts.orientation,
                    angularVelocity: opts.angularVelocity,
                });
                // Orientaciones: Float32Array de cuaterniones (w, x, y, z)
                // muestreados junto con la trayectoria (para el visor).
                this.orientations = new Float32Array(this.maxTrajectoryPoints * 4);
                this._orientLength = 0;
            } else {
                this.method = 'lumped-mass';
                this.shapeKind = null;
                this.shapeSeed = null;
                this.body = null;
                this.orientations = null;
                this._orientLength = 0;
            }
        }

        /** Energía cinética (J): traslacional; total (trasl+rot) en rigid. */
        get kineticEnergy() {
            if (this.body) {
                return this.body.kineticEnergy();
            }
            const v2 = this.vx * this.vx + this.vy * this.vy + this.vz * this.vz;
            return 0.5 * this.mass * v2;
        }

        /** Cuaterniones válidos de la trayectoria (subarray recortado). */
        getOrientations() {
            if (!this.orientations) {
                return new Float32Array(0);
            }
            return this.orientations.subarray(0, this._orientLength * 4);
        }

        /** Rapidez (m/s). */
        get speed() {
            const v2 = this.vx * this.vx + this.vy * this.vy + this.vz * this.vz;
            return Math.sqrt(v2);
        }

        /** Cuádruplos válidos de la trayectoria (subarray recortado). */
        getTrajectory() {
            return this.trajectory.subarray(0, this.trajectoryLength * 4);
        }

        /**
         * Compacta la trayectoria a la mitad conservando cada segundo punto.
         * No asigna memoria nueva.
         */
        _downsampleTrajectory() {
            const traj = this.trajectory;
            const n = this.trajectoryLength;
            let write = 0;
            for (let i = 0; i < n; i += 2) {
                const src = i * 4;
                traj[write++] = traj[src];
                traj[write++] = traj[src + 1];
                traj[write++] = traj[src + 2];
                traj[write++] = traj[src + 3];
            }
            this.trajectoryLength = write;
        }
    }

    /**
     * Motor 3D de masa concentrada sobre DEM.
     *
     * El buque caliente NO asigna: la va a `this._n`, la rugosidad a
     * `this._roughN`; todos los temporales internos son escalares.
     */
    class PhysicsEngine3D {
        /**
         * @param {object} [params]
         * @param {number} [params.gravity=9.81]
         * @param {number} [params.dt=0.005]
         * @param {'lumped-mass'|'rigid-body'} [params.method='lumped-mass'] Modelo de contacto (C7-rigid).
         * @param {number} [params.kn=0.35]
         * @param {number} [params.kt=0.75]
         * @param {number} [params.knVariability=10] %
         * @param {number} [params.ktVariability=10] %
         * @param {number} [params.rollingFriction=0.15]
         * @param {number} [params.slideVelocityThreshold=0.5] m/s
         * @param {number} [params.restThreshold=0.08] m/s
         * @param {number} [params.maxSubStepDisplacement=0.1] m
         * @param {number} [params.roughnessDeg=0] Rugosidad CRSP (grados).
         * @param {number} [params.restitutionN=0.35] Restitución normal (rigid, Newton).
         * @param {number} [params.frictionMu=0.5] Cono de Coulomb (rigid).
         * @param {number} [params.rollingResistance=0.05] Amortiguamiento angular en contacto (rigid).
         * @param {number} [params.restAngularThreshold=0.5] rad/s (rigid).
         * @param {function|null} [params.materialAt=null] Gancho (x, y) => {kn, kt, rollingFriction, roughnessDeg, restitutionN, frictionMu}.
         */
        constructor(params = {}) {
            this.gravity = params.gravity !== undefined ? params.gravity : 9.81;
            this.dt = params.dt !== undefined ? params.dt : 0.005;
            this.kn = params.kn !== undefined ? params.kn : 0.35;
            this.kt = params.kt !== undefined ? params.kt : 0.75;
            this.knVariability = params.knVariability !== undefined ? params.knVariability : 10;
            this.ktVariability = params.ktVariability !== undefined ? params.ktVariability : 10;
            this.rollingFriction = params.rollingFriction !== undefined ? params.rollingFriction : 0.15;
            this.slideVelocityThreshold = params.slideVelocityThreshold !== undefined ? params.slideVelocityThreshold : 0.5;
            this.restThreshold = params.restThreshold !== undefined ? params.restThreshold : 0.08;
            this.maxSubStepDisplacement = params.maxSubStepDisplacement !== undefined ? params.maxSubStepDisplacement : 0.1;
            this.roughnessDeg = params.roughnessDeg !== undefined ? params.roughnessDeg : 0;
            this.materialAt = params.materialAt !== undefined ? params.materialAt : null;

            // Modelo de contacto (C7-rigid): 'lumped-mass' por defecto.
            const method = params.method !== undefined ? params.method : 'lumped-mass';
            if (PhysicsEngine3D.supportedMethods.indexOf(method) < 0) {
                throw new Error('PhysicsEngine3D: method "' + String(method) + '" no soportado — usar lumped-mass o rigid-body');
            }
            this.method = method;
            // Parámetros del cuerpo rígido (solo method 'rigid-body').
            this.restitutionN = params.restitutionN !== undefined ? params.restitutionN : 0.35;
            this.frictionMu = params.frictionMu !== undefined ? params.frictionMu : 0.5;
            this.rollingResistance = params.rollingResistance !== undefined ? params.rollingResistance : 0.05;
            this.restAngularThreshold = params.restAngularThreshold !== undefined ? params.restAngularThreshold : 0.5;
            if (this.method === 'rigid-body') {
                if (typeof SimRocas.Physics3DRigid !== 'object') {
                    throw new Error('PhysicsEngine3D: method "rigid-body" requiere js/physics3d-rigid.js (SimRocas.Physics3DRigid)');
                }
                SimRocas.Physics3DRigid.installRigidStatics(this);
            }

            // Outs sin asignación (_n del estilo Dem: {nx, ny, nz}).
            this._n = { nx: 0, ny: 0, nz: 0 };
            this._roughN = { x: 0, y: 0, z: 0 };
            this._perp = { x: 0, y: 0, z: 0 };
            this._scratch = { x: 0, y: 0, z: 0 };
        }

        /**
         * Variación multiplicativa de un coeficiente (mismo criterio que el 2D),
         * acotado a [0, 1].
         */
        randomVariation(base, variability) {
            const variation = variability / 100;
            const factor = 1 + (Math.random() * 2 - 1) * variation;
            return Math.max(0, Math.min(1, base * factor));
        }

        /**
         * Sub-pasos adaptativos: min(64, max(3, ceil(dt·(|v|+g·dt)/maxSubStepDisplacement))).
         * Misma fórmula validada en el motor 2D (T0.12): desplazamiento ≤ ~0.1 m
         * por sub-paso (evita tunneling). NaN-safe: velocidad inválida → 3.
         */
        subStepsFor(rock, dt) {
            const speedEstimate = (Math.sqrt(
                rock.vx * rock.vx + rock.vy * rock.vy + rock.vz * rock.vz,
            ) + this.gravity * dt) || 0;
            return Math.min(64, Math.max(3, Math.ceil(dt * speedEstimate / this.maxSubStepDisplacement)));
        }

        /**
         * Simula un paso completo de duración `this.dt` para una roca.
         * @param {Rock3D} rock
         * @param {SimRocas.Dem} dem
         */
        simulateStep(rock, dem) {
            if (rock.isResting) {
                return;
            }
            if (this.method === 'rigid-body') {
                // C7-rigid: el paso rígido (js/physics3d-rigid.js) incluye su
                // propia cola (métricas, trayectoria, orientaciones).
                this.simulateStepRigid(rock, dem);
                return;
            }

            // Coeficientes con variabilidad una vez por paso.
            let kn = this.randomVariation(this.kn, this.knVariability);
            let kt = this.randomVariation(this.kt, this.ktVariability);
            let rollingFriction = this.rollingFriction;
            let roughnessDeg = this.roughnessDeg;
            if (this.materialAt) {
                const mat = this.materialAt(rock.x, rock.y);
                if (mat) {
                    if (mat.kn !== undefined) { kn = Math.max(0, Math.min(1, mat.kn)); }
                    if (mat.kt !== undefined) { kt = Math.max(0, Math.min(1, mat.kt)); }
                    if (mat.rollingFriction !== undefined) { rollingFriction = mat.rollingFriction; }
                    if (mat.roughnessDeg !== undefined) { roughnessDeg = mat.roughnessDeg; }
                }
            }

            const subSteps = this.subStepsFor(rock, this.dt);
            const h = this.dt / subSteps;
            const g = this.gravity;
            const r = rock.radius;
            const threshold = this.slideVelocityThreshold;

            for (let i = 0; i < subSteps; i++) {
                // 3) Integración Euler semi-implícita: v += g·h, p += v·h.
                rock.vz -= g * h;
                rock.x += rock.vx * h;
                rock.y += rock.vy * h;
                rock.z += rock.vz * h;

                // Culling: fuera de la grilla o celda sin dato → culled.
                const hTerrain = dem.heightAt(rock.x, rock.y);
                const n = dem.normalAt(rock.x, rock.y, this._n);
                if (Number.isNaN(hTerrain) || n === null) {
                    rock.isResting = true;
                    rock.stopReason = 'culled';
                    break;
                }

                // 4) Penetración a lo largo de la normal (Dem.normalAt devuelve
                // {nx, ny, nz}; aplanamos a escalares para el bucle caliente).
                const nzr = n.nz;
                const nxr = n.nx;
                const nyr = n.ny;
                const pen = (hTerrain - (rock.z - r)) * nzr;
                if (pen > 0) {
                    const lift = pen / nzr;
                    const vn = rock.vx * nxr + rock.vy * nyr + rock.vz * nzr;
                    const keBefore = rock.kineticEnergy;
                    let bounced = false;

                    if (vn >= 0) {
                        // Se aleja: sin respuesta de velocidad, solo posición.
                        rock.z += lift;
                    } else if (Math.abs(vn) < threshold) {
                        // 6b) Contacto sostenido: quitar la componente normal,
                        // tangencial SIN kt, lift sin cargo de energía (la
                        // eliminación de vn ya discarta la energía que la
                        // gravedad inyectó para construir esa penetración).
                        rock.vx -= vn * nxr;
                        rock.vy -= vn * nyr;
                        rock.vz -= vn * nzr;
                        rock.z += lift;
                        rock.sustainedContact = true;
                    } else {
                        // 6a) Impacto: ley con la normal perturbada por
                        // rugosidad (la clasificación impacto/sliding se hizo
                        // con la normal REAL, criterio T0.7b fix 1 del 2D).
                        let nx = nxr;
                        let ny = nyr;
                        let nz = nzr;
                        if (roughnessDeg > 0) {
                            const rn = this._perturbNormal(nxr, nyr, nzr, roughnessDeg);
                            if (rn) {
                                const vnR = rock.vx * rn.x + rock.vy * rn.y + rock.vz * rn.z;
                                if (vnR < 0) {
                                    nx = rn.x;
                                    ny = rn.y;
                                    nz = rn.z;
                                }
                                // si la normal perturbada da vn >= 0: solo lift.
                            }
                        }
                        const vnP = rock.vx * nx + rock.vy * ny + rock.vz * nz;
                        if (vnP < 0) {
                            // v' = −kn·vn·n + kt·vt, con vt = v − vn·n
                            const tx = rock.vx - vnP * nx;
                            const ty = rock.vy - vnP * ny;
                            const tz = rock.vz - vnP * nz;
                            rock.vx = -kn * vnP * nx + kt * tx;
                            rock.vy = -kn * vnP * ny + kt * ty;
                            rock.vz = -kn * vnP * nz + kt * tz;
                            rock.bounces++;
                            bounced = true;

                            const impactSpeed = -vnP;
                            if (impactSpeed > rock.maxImpactVelocity) {
                                rock.maxImpactVelocity = impactSpeed;
                            }
                            if (rock.impacts.length < rock.maxImpactsRecorded) {
                                rock.impacts.push({
                                    x: rock.x,
                                    y: rock.y,
                                    z: hTerrain,
                                    energyKJ: keBefore / 1000,
                                    vn: vnP,
                                });
                            }
                        }
                        // 6) Corrección de posición con cargo del ascenso
                        // (energéticamente neutra, como _penetrationCorrection
                        // 2D: si la energía no alcanza, la velocidad queda
                        // intacta).
                        rock.z += lift;
                        if (lift > 0) {
                            const margin = Math.min(1e-4, 0.05 * lift);
                            const total = lift + margin;
                            const climbOut = 2 * g * total;
                            const speedSq = rock.vx * rock.vx + rock.vy * rock.vy + rock.vz * rock.vz;
                            if (speedSq > climbOut) {
                                const f = Math.sqrt(1 - climbOut / speedSq);
                                rock.vx *= f;
                                rock.vy *= f;
                                rock.vz *= f;
                            }
                        }
                    }

                    // Energía disipada por el contacto (incl. fricción de impacto).
                    const keAfter = rock.kineticEnergy;
                    const dissipated = keBefore - keAfter;
                    if (dissipated > 0) {
                        rock.totalEnergyDissipated += dissipated;
                    }
                    if (bounced) {
                        const bounceH = rock.z - hTerrain;
                        if (bounceH > rock.maxBounceHeight) {
                            rock.maxBounceHeight = bounceH;
                        }
                    }

                    // 7) Fricción de rodadura: solo con contacto real. Con la
                    // velocidad ACTUAL (la respuesta del contacto cambia vn;
                    // usar el vn previo restauraría la componente normal).
                    const vnPost = rock.vx * nxr + rock.vy * nyr + rock.vz * nzr;
                    this._applyRollingFriction(rock, nxr, nyr, nzr, rollingFriction, h, vnPost);

                    // 8) Reposo.
                    if (this._checkResting(rock, nxr, nyr, nzr)) {
                        break;
                    }
                } else {
                    // Sin contacto: el estado de contacto sostenido al aire.
                    rock.sustainedContact = false;
                }
            }

            rock.stepsTaken++;
            rock.elapsedTime += this.dt;

            // Métricas y posición final.
            const ke = rock.kineticEnergy;
            if (ke > rock.maxKineticEnergy) {
                rock.maxKineticEnergy = ke;
            }
            rock.finalX = rock.x;
            rock.finalY = rock.y;
            rock.finalZ = rock.z;

            // 9) Trayectoria cada trajectoryInterval pasos + punto final.
            if (rock.isResting) {
                this._recordTrajectory(rock);
            } else {
                rock._trajStepCounter++;
                if (rock._trajStepCounter % rock.trajectoryInterval === 0) {
                    this._recordTrajectory(rock);
                }
            }
        }

        /**
         * Rugosidad CRSP 3D: rota la normal un ángulo uniforme en
         * [0, roughnessDeg] alrededor de un eje aleatorio del plano tangente.
         * Si la normal perturbada queda con nz <= 0, devuelve null
         * (el motor usa la normal real). Escribe en this._roughN.
         */
        _perturbNormal(nx, ny, nz, roughnessDeg) {
            const angle = Math.random() * roughnessDeg * Math.PI / 180;
            // e1 ortogonal a n: metemos n (extensión nx/ny/nz) en un scratch
            // {x, y, z} reutilizado para SimRocas.V3.anyPerpendicular.
            const sn = this._scratch;
            sn.x = nx;
            sn.y = ny;
            sn.z = nz;
            const e1 = SimRocas.V3.anyPerpendicular(this._perp, sn);
            if (e1.x === 0 && e1.y === 0 && e1.z === 0) {
                return null;
            }
            // segundo tangente: t2 = n × e1 (unitario y ortogonal a n y e1)
            const t2x = ny * e1.z - nz * e1.y;
            const t2y = nz * e1.x - nx * e1.z;
            const t2z = nx * e1.y - ny * e1.x;
            const phi = Math.random() * Math.PI * 2;
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);
            const ax = e1.x * cosPhi + t2x * sinPhi;
            const ay = e1.y * cosPhi + t2y * sinPhi;
            const az = e1.z * cosPhi + t2z * sinPhi;
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            const kdv = ax * nx + ay * ny + az * nz; // eje · n
            const cx = ay * nz - az * ny;
            const cy = az * nx - ax * nz;
            const cz = ax * ny - ay * nx;
            const f = 1 - cosA;
            const out = this._roughN;
            out.x = nx * cosA + cx * sinA + ax * kdv * f;
            out.y = ny * cosA + cy * sinA + ay * kdv * f;
            out.z = nz * cosA + cz * sinA + az * kdv * f;
            if (!(out.z > 0)) {
                return null;
            }
            return out;
        }

        /**
         * Fricción de rodadura (contrato paso 7): desaceleración
         * rollingFriction · g · n.z opuesta a la velocidad tangencial,
         * sin invertir su sentido. Solo con contacto real.
         */
        _applyRollingFriction(rock, nx, ny, nz, rollingFriction, h, vn) {
            if (rollingFriction <= 0 || rock.isResting) {
                return;
            }
            // tangencial = v − vn·n
            const tx = rock.vx - vn * nx;
            const ty = rock.vy - vn * ny;
            const tz = rock.vz - vn * nz;
            const tsp = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (tsp <= 0) {
                return;
            }
            const decel = rollingFriction * this.gravity * nz;
            const next = tsp - decel * h;
            const target = next > 0 ? next : 0;
            const f = target / tsp;
            // Escala SOLO la parte tangencial y conserva la componente normal:
            // reemplazar la velocidad completa por la tangencial destruiría la
            // componente normal saliente de un rebote (convertiría cada
            // impacto en contacto pegado).
            rock.vx = tx * f + vn * nx;
            rock.vy = ty * f + vn * ny;
            rock.vz = tz * f + vn * nz;
        }

        /**
         * Criterio de reposo (contrato paso 8): con contacto, al menos 3
         * comprobaciones, speed < restThreshold·slopeFactor con
         * slopeFactor = max(0.1, 1 − 2·tanθ), y (bounces > 2 || contacto
         * sostenido). Al detener: velocidad 0 y posición final fijada.
         */
        _checkResting(rock, nx, ny, nz) {
            rock._restCheckCount++;
            if (rock._restCheckCount < 3) {
                return false;
            }
            const tanTheta = Math.sqrt(nx * nx + ny * ny) / Math.max(nz, 1e-9);
            const restLimit = this.restThreshold * Math.max(0.1, 1 - 2 * tanTheta);
            if (rock.speed < restLimit && (rock.bounces > 2 || rock.sustainedContact)) {
                rock.isResting = true;
                rock.stopReason = 'rest';
                rock.vx = 0;
                rock.vy = 0;
                rock.vz = 0;
                rock.finalX = rock.x;
                rock.finalY = rock.y;
                rock.finalZ = rock.z;
                return true;
            }
            return false;
        }

        /** Registra un cuádruplo (x, y, z, speed) de la trayectoria. */
        _recordTrajectory(rock) {
            const traj = rock.trajectory;
            if (rock.trajectoryLength >= rock.maxTrajectoryPoints) {
                rock._downsampleTrajectory();
                if (rock.trajectoryLength >= rock.maxTrajectoryPoints) {
                    // compactado y aún lleno: libera una ranura y sobreescribe
                    rock.trajectoryLength = rock.maxTrajectoryPoints - 1;
                }
            }
            const pos = rock.trajectoryLength * 4;
            traj[pos] = rock.x;
            traj[pos + 1] = rock.y;
            traj[pos + 2] = rock.z;
            traj[pos + 3] = rock.speed;
            rock.trajectoryLength++;
        }
    }

    SimRocas.Rock3D = Rock3D;
    SimRocas.PhysicsEngine3D = PhysicsEngine3D;
    /** Métodos de contacto soportados (C7-rigid). */
    PhysicsEngine3D.supportedMethods = ['lumped-mass', 'rigid-body'];
})(globalThis.SimRocas);
