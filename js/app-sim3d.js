/**
 * SimRocas — App: interfaz de simulación 3D (T4.6). Mixin sobre
 * SimRocas.App.prototype; se carga después de js/app.js (después de todos los
 * mixins con los que comparte el visor).
 *
 * Pestaña 'Simulación 3D' (visible en modo 3D):
 *  - Zonas de liberación dibujadas sobre el terreno (polígono por clics,
 *    cerrar con doble clic/'Terminar', Esc cancela) y puntos puntuales.
 *  - Parámetros y ejecución con Sim3DPool (workers), barra de progreso y
 *    botón Cancelar.
 *  - Resultados: stats, trayectorias 3D (capa de Viewer3D) y mapas de
 *    resultados coloreados sobre la malla + exportación ASC/CSV.
 *
 * GANCHOS DE AUTOMATIZACIÓN (documentados, ejecutables desde consola/smoke):
 *   - app.sim3dAddZoneLocal(vertices)  agrega una zona poligonal
 *     (coordenadas LOCALES del DEM; vertices = [{x, y}, ...]).
 *   - app.sim3dAddPointLocal(x, y)     agrega una zona puntual.
 */
(function (SimRocas) {
    'use strict';

    // Cache-busting del worker de simulación 3D (publicado para verificación).
    const SIM3D_WORKER_VERSION = 1;

    const MAX_ROCKS_3D = 10000;
    const POOL_SIZE_MAX = 8;
    // En caída libre el punto se eleva 5 m sobre la cota del terreno al
    // cargar un perfil nuevo.
    const RELEASE_FALL_CLEARANCE = 5;

    /* ------------------------------------------------ helpers puros ----- */

    /**
     * Colocación del punto de liberación al cargar un perfil 2D nuevo
     * (corrección del defecto de T3.5: la roca quedaba por debajo del
     * terreno). x = x0 + 2 % de la longitud del perfil; y = cota del terreno
     * (desprendimiento) o cota + 5 m (caída libre). Terreno sin dato (NaN) →
     * se usa la cota del extremo del perfil como fallback (nunca por debajo).
     */
    const ReleasePlacement = {
        fromProfile(points, releaseMode, getHeightAt) {
            if (!Array.isArray(points) || points.length < 2) {
                throw new Error('ReleasePlacement.fromProfile: se necesitan al menos 2 puntos del perfil');
            }
            const mode = releaseMode === 'detachment' ? 'detachment' : 'freefall';
            const x0 = points[0].x;
            const x1 = points[points.length - 1].x;
            const length = Math.abs(x1 - x0);
            const x = x0 + length * 0.02;
            let terrainY = NaN;
            if (typeof getHeightAt === 'function') {
                try { terrainY = getHeightAt(x); } catch (err) { /* sin cota */ }
                if (!Number.isFinite(terrainY)) {
                    try { terrainY = getHeightAt(x0); } catch (err2) { /* sin cota */ }
                }
            }
            if (!Number.isFinite(terrainY)) {
                terrainY = points[points.length - 1].y;
            }
            const y = mode === 'detachment' ? terrainY : terrainY + RELEASE_FALL_CLEARANCE;
            return { x: x, y: y, terrainY: terrainY };
        },
    };

    /** hex '#rrggbb' → [r, g, b] en 0..1 (para las rampas de los mapas). */
    function hexToRgb(h) {
        const n = parseInt(h.slice(1), 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    /**
     * Configuración de los mapas de resultados sobre el terreno. `gate`
     * (passCount === 0 → nodata) para los campos derivados de la energía/la
     * altura; probabilidad y detenciones muestran su valor 0 real.
     */
    const MAPS = {
        reachProbability: {
            label: 'Probabilidad de alcance',
            field: 'reachProbability',
            gate: false,
            decimals: 3,
            stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'].map(hexToRgb),
        },
        maxEnergyKJ: {
            label: 'Energía máxima (kJ)',
            field: 'maxEnergyKJ',
            gate: true,
            decimals: 1,
            stops: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'].map(hexToRgb),
        },
        maxBounceHeight: {
            label: 'Altura de rebote (m)',
            field: 'maxBounceHeight',
            gate: true,
            decimals: 1,
            stops: ['#f7fbff', '#6baed6', '#2171b5', '#08306b'].map(hexToRgb),
        },
        stopCount: {
            label: 'Detenciones',
            field: 'stopCount',
            gate: false,
            decimals: 0,
            stops: ['#fee0d2', '#fc9272', '#cb181d', '#67000d'].map(hexToRgb),
        },
    };

    /** Rampa generérica: stops [[r,g,b], ...] y t en [0, 1] (recortado). */
    function rampColor(stops, t) {
        if (!Array.isArray(stops) || stops.length === 0) {
            return [1, 0, 1];
        }
        const tt = (Number.isFinite(t) && t > 0) ? Math.min(1, t) : 0;
        const last = stops.length - 1;
        const seg = tt * last;
        const i = Math.min(last - 1, Math.floor(seg));
        const f = seg - i;
        const a = stops[i];
        const b = stops[i + 1];
        return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
    }

    /** Valor muestrado de un campo del ráster en (x, y); null si sin dato. */
    function sampleRaster(raster, field, x, y) {
        if (!raster || !Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
        }
        const data = raster[field];
        if (!data) {
            return null;
        }
        const i = Math.floor(x / raster.cellSize);
        const j = Math.floor(y / raster.cellSize);
        if (i < 0 || i >= raster.cols || j < 0 || j >= raster.rows) {
            return null;
        }
        return data[j * raster.cols + i];
    }

    /** CSS del gradiente de la leyenda a partir de stops rgb 0..1. */
    function stopsCss(stops) {
        const parts = stops.map((c) => {
            const to = (v) => ('0' + Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16)).slice(-2);
            return '#' + to(c[0]) + to(c[1]) + to(c[2]);
        });
        const step = 100 / (parts.length - 1);
        const stops2 = parts.map((p, k) => p + ' ' + Math.round(k * step) + '%');
        return 'linear-gradient(90deg, ' + stops2.join(', ') + ')';
    }

    SimRocas.Sim3DMaps = {
        MAPS: MAPS,
        rampColor: rampColor,
        sampleRaster: sampleRaster,
        stopsCss: stopsCss,
    };
    SimRocas.ReleasePlacement = ReleasePlacement;
    SimRocas.SIM3D_WORKER_VERSION = SIM3D_WORKER_VERSION;

    /* ------------------------------------------------------- App mixin --- */

    Object.assign(SimRocas.App.prototype, {
        /** Registra los controles de la pestaña 'Simulación 3D'. */
        setupSim3dControls() {
            this.sim3dZones = [];
            this._sim3dZoneId = 1;
            this._sim3dZoneDrawing = false;
            this._sim3dZoneVertices = [];
            this._sim3dPointMode = false;
            this._sim3dDown = null;
            this._sim3dPool = null;
            this._sim3dRunActive = false;
            this.sim3dResult = null;   // { rocks, stats, seed, workers, ms, specs, raster }
            this._sim3dMapField = '';
            this._sim3dTerrainColors = null; // copia de seguridad de colores

            const container = document.getElementById('view3d-container');
            if (container) {
                container.addEventListener('pointerdown', (e) => {
                    this._sim3dDown = { x: e.clientX, y: e.clientY, t: Date.now() };
                });
                container.addEventListener('click', (e) => {
                    this._sim3dOnContainerClick(e);
                });
                container.addEventListener('dblclick', (e) => {
                    if (this._sim3dZoneDrawing) {
                        e.preventDefault();
                        this.sim3dFinishZone();
                    }
                });
            }

            const on = (id, fn) => {
                const el = document.getElementById(id);
                if (el) { el.addEventListener('click', fn); }
            };
            on('btn-sim3d-zone', () => this.sim3dStartZone());
            on('btn-sim3d-zone-finish', () => this.sim3dFinishZone());
            on('btn-sim3d-zone-cancel', () => this.sim3dCancelZone());
            on('btn-sim3d-point', () => this.sim3dStartPointMode());
            on('btn-sim3d-clear-zones', () => this.sim3dClearZones());
            on('btn-sim3d-run', () => this.sim3dRun());
            on('btn-sim3d-cancel', () => this.sim3dCancelRun());
            on('btn-sim3d-export-asc', () => this._sim3dExportAsc());
            on('btn-sim3d-export-csv', () => this._sim3dExportCsv());

            const releaseMode = document.getElementById('sim3d-release-mode');
            if (releaseMode) {
                releaseMode.addEventListener('change', () => {
                    const g = document.getElementById('sim3d-height-group');
                    if (g) { g.style.display = releaseMode.value === 'fall' ? 'block' : 'none'; }
                });
            }

            const mapSelect = document.getElementById('sim3d-map');
            if (mapSelect) {
                mapSelect.addEventListener('change', () => {
                    this._sim3dApplyMap(mapSelect.value);
                });
            }

            const tracks = document.getElementById('sim3d-show-tracks');
            if (tracks) {
                tracks.addEventListener('change', () => {
                    this._sim3dShowTracks(tracks.checked);
                });
            }

            this._sim3dZoneOptions();
        },

        /* --------------------------------------------- zonas de liberación */

        /**
         * Modo 'Dibujar zona': cada clic sobre el terreno agrega un vértice
         * del polígono; doble clic o 'Terminar' cierra; Esc/Cancelar descarta.
         */
        sim3dStartZone() {
            if (!this.dem3d) {
                this._sim3dStatus('Importa un terreno DEM antes de dibujar la zona.', true);
                return;
            }
            this._sim3dPointMode = false;
            this._sim3dZoneDrawing = true;
            this._sim3dZoneVertices = [];
            this._sim3dStatus('Dibujando zona: haz clic sobre el terreno. Doble clic o Terminar cierran; Esc cancela.', false);
            this._sim3dSyncZones();
        },

        /** Modo 'Punto de liberación': el próximo clic crea una zona puntual. */
        sim3dStartPointMode() {
            if (!this.dem3d) {
                this._sim3dStatus('Importa un terreno DEM antes de colocar el punto.', true);
                return;
            }
            this._sim3dZoneDrawing = false;
            this._sim3dZoneVertices = [];
            this._sim3dPointMode = true;
            this._sim3dStatus('Punto de liberación: haz clic sobre el terreno.', false);
            this._sim3dSyncZones();
        },

        /**
         * GANCHO: agrega una zona poligonal en coordenadas locales del DEM.
         * @param {Array<{x: number, y: number}>} vertices >= 3 vértices.
         */
        sim3dAddZoneLocal(vertices) {
            if (!this.dem3d) {
                this._sim3dStatus('Importa un terreno DEM antes de agregar zonas.', true);
                return null;
            }
            if (!Array.isArray(vertices) || vertices.length < 3) {
                this._sim3dStatus('La zona poligonal necesita al menos 3 vértices.', true);
                return null;
            }
            for (const v of vertices) {
                if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) {
                    this._sim3dStatus('Vértice sin coordenadas válidas.', true);
                    return null;
                }
            }
            let area = 0;
            try {
                area = SimRocas.SourceZones.area({ id: 'check', type: 'polygon', vertices: vertices });
            } catch (err) {
                this._sim3dStatus('Zona inválida: ' + err.message, true);
                return null;
            }
            if (!(area > 0)) {
                this._sim3dStatus('Zona degenerada (área 0).', true);
                return null;
            }
            const zone = {
                id: this._sim3dZoneId++,
                type: 'polygon',
                vertices: vertices.map((v) => ({ x: v.x, y: v.y })),
            };
            this.sim3dZones.push(zone);
            this._sim3dSyncZones();
            return zone;
        },

        /**
         * GANCHO: agrega una zona puntual en coordenadas locales del DEM.
         * @param {number} x
         * @param {number} y
         */
        sim3dAddPointLocal(x, y) {
            if (!this.dem3d) {
                this._sim3dStatus('Importa un terreno DEM antes de agregar puntos.', true);
                return null;
            }
            if (!Number.isFinite(x) || !Number.isFinite(y) || !this.dem3d.contains(x, y)) {
                this._sim3dStatus('Punto fuera del terreno.', true);
                return null;
            }
            const zone = { id: this._sim3dZoneId++, type: 'point', x: x, y: y };
            this.sim3dZones.push(zone);
            this._sim3dSyncZones();
            return zone;
        },

        /** Cierra el polígono en trazado (doble clic o botón 'Terminar'). */
        sim3dFinishZone() {
            if (!this._sim3dZoneDrawing) { return; }
            const verts = this._sim3dZoneVertices;
            this._sim3dZoneDrawing = false;
            if (verts.length < 3) {
                this._sim3dStatus('La zona necesita al menos 3 vértices; se descartó el trazado.', true);
                this._sim3dZoneVertices = [];
                this._sim3dSyncZones();
                return;
            }
            this.sim3dAddZoneLocal(verts);
            this._sim3dZoneVertices = [];
            this._sim3dSyncZones();
        },

        /** Esc/Cancelar: descarta el trazado o el modo punto en curso. */
        sim3dCancelZone() {
            this._sim3dZoneDrawing = false;
            this._sim3dPointMode = false;
            this._sim3dZoneVertices = [];
            this._sim3dStatus('Dibujo cancelado.', false);
            this._sim3dSyncZones();
        },

        /** Elimina una zona por id. */
        sim3dDeleteZone(id) {
            const k = this.sim3dZones.findIndex((z) => z.id === id);
            if (k >= 0) {
                this.sim3dZones.splice(k, 1);
                this._sim3dSyncZones();
            }
        },

        /** Elimina todas las zonas. */
        sim3dClearZones() {
            this.sim3dZones = [];
            this._sim3dSyncZones();
        },

        /**
         * Clic sobre el visor: vértice del polígono o punto, según el modo.
         * @private
         */
        _sim3dOnContainerClick(e) {
            if (!this._sim3dZoneDrawing && !this._sim3dPointMode) { return; }
            const down = this._sim3dDown;
            if (down && Date.now() - down.t < 1500) {
                const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
                if (moved > 6) { return; } // arrastre de OrbitControls
            }
            const viewer = this.get3dViewer();
            if (!viewer) { return; }
            const hit = viewer.pickTerrainLocal(e.clientX, e.clientY);
            if (!hit) {
                this._sim3dStatus('Clic fuera del terreno.', true);
                return;
            }
            if (this._sim3dPointMode) {
                this._sim3dPointMode = false;
                const zone = this.sim3dAddPointLocal(hit.x, hit.y);
                if (zone) {
                    this._sim3dStatus('Punto de liberación en (' + hit.x.toFixed(0) + ', ' + hit.y.toFixed(0) + ') m.', false);
                }
            } else {
                this._sim3dZoneVertices.push({ x: hit.x, y: hit.y });
                this._sim3dStatus('Vértice ' + this._sim3dZoneVertices.length + ': (' + hit.x.toFixed(0) + ', ' + hit.y.toFixed(0) + ') m. Doble clic o Terminar cierra.', false);
            }
            this._sim3dSyncZones();
        },

        /** Redibuja las zonas en el visor y actualiza el listado. */
        _sim3dSyncZones() {
            const viewer = this.get3dViewer();
            const dem = this.dem3d;
            const entries = [];
            if (viewer && dem) {
                for (const z of this.sim3dZones) {
                    if (z.type === 'point') {
                        const hz = dem.heightAt(z.x, z.y);
                        entries.push({ type: 'point', x: z.x, y: z.y, z: Number.isFinite(hz) ? hz : 0 });
                    } else {
                        const verts = z.vertices.map((v) => {
                            const hz = dem.heightAt(v.x, v.y);
                            return { x: v.x, y: v.y, z: Number.isFinite(hz) ? hz : 0 };
                        });
                        entries.push({ type: 'polygon', vertices: verts });
                    }
                }
                // Trazado en curso (polilínea abierta, marcado aparte).
                if (this._sim3dZoneDrawing && this._sim3dZoneVertices.length) {
                    entries.push({
                        type: 'drawing',
                        vertices: this._sim3dZoneVertices.map((v) => {
                            const hz = dem.heightAt(v.x, v.y);
                            return { x: v.x, y: v.y, z: Number.isFinite(hz) ? hz : 0 };
                        }),
                    });
                }
            }
            if (viewer) {
                viewer.setZonesLayer(entries);
            }
            // Botón 'Terminar': activo sólo mientras se traza el polígono.
            const finishBtn = document.getElementById('btn-sim3d-zone-finish');
            if (finishBtn) { finishBtn.disabled = !this._sim3dZoneDrawing; }
            this._sim3dUpdateZonesList();
        },

        /** Lista de zonas con área (m²) y botón de borrado. */
        _sim3dUpdateZonesList() {
            const list = document.getElementById('sim3d-zones-list');
            if (!list) { return; }
            list.innerHTML = '';
            for (const z of this.sim3dZones) {
                const row = document.createElement('div');
                row.className = 'sim3d-zone-row';
                const label = document.createElement('span');
                if (z.type === 'point') {
                    label.textContent = 'Punto ' + z.id + ' — (' + z.x.toFixed(1) + ', ' + z.y.toFixed(1) + ')';
                } else {
                    let areaTxt = '—';
                    try {
                        areaTxt = SimRocas.SourceZones.area(z).toLocaleString('es', { maximumFractionDigits: 0 }) + ' m²';
                    } catch (err) { /* sin área */ }
                    label.textContent = 'Zona ' + z.id + ' — polígono · ' + areaTxt + ' · ' + z.vertices.length + ' vértices';
                }
                const del = document.createElement('button');
                del.className = 'btn btn-danger btn-small';
                del.type = 'button';
                del.textContent = '✕';
                del.setAttribute('aria-label', 'Borrar zona ' + z.id);
                del.addEventListener('click', () => this.sim3dDeleteZone(z.id));
                row.appendChild(label);
                row.appendChild(del);
                list.appendChild(row);
            }
            if (this.sim3dZones.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'help-text';
                empty.textContent = 'Sin zonas. Dibuja un polígono o un punto de liberación.';
                list.appendChild(empty);
            }
        },

        /**
         * Método de cálculo: 'Masa concentrada' siempre; 'Cuerpo rígido'
         * deshabilitado ('próximamente') salvo que PhysicsEngine3D exponga
         * soporte vía SimRocas.PhysicsEngine3D.supportedMethods.
         * @private
         */
        _sim3dZoneOptions() {
            const select = document.getElementById('sim3d-method');
            const note = document.getElementById('sim3d-method-note');
            if (!select) { return; }
            const supportedRaw = SimRocas.PhysicsEngine3D && SimRocas.PhysicsEngine3D.supportedMethods;
            const supported = Array.isArray(supportedRaw) ? supportedRaw : ['lumped-mass'];
            select.innerHTML = '';
            const opts = [
                { value: 'lumped-mass', label: 'Masa concentrada' },
                { value: 'rigid-body', label: 'Cuerpo rígido', note: ' (próximamente)' },
            ];
            const enabled = [];
            for (const o of opts) {
                const ok = supported.indexOf(o.value) >= 0;
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.label + (ok ? '' : (o.note || ''));
                if (!ok) {
                    opt.disabled = true;
                } else {
                    enabled.push(o.value);
                }
                select.appendChild(opt);
            }
            if (enabled.length) {
                select.value = enabled[0];
            }
            if (note) {
                note.textContent = supported.indexOf('rigid-body') >= 0
                    ? '' : 'Cuerpo rígido estará disponible próximamente (fase F5).';
            }
        },

        /* ------------------------------------------------------- corrida */

        /**
         * Lee y valida los parámetros del panel. Devuelve el objeto de
         * parámetros o null (con el mensaje mostrado en el panel).
         * @private
         */
        _sim3dCollectParams() {
            const num = (id, fallback) => {
                const el = document.getElementById(id);
                const v = parseFloat(el && el.value);
                return Number.isFinite(v) ? v : fallback;
            };
            const rocks = Math.round(num('sim3d-rocks', 500));
            if (!(rocks >= 1) || rocks > MAX_ROCKS_3D) {
                this._sim3dError('Número de rocas fuera de rango: debe estar entre 1 y ' + MAX_ROCKS_3D + '.');
                return null;
            }
            const diameter = num('sim3d-diameter', 0.5);
            if (!(diameter > 0)) {
                this._sim3dError('Diámetro inválido: debe ser mayor que 0 m.');
                return null;
            }
            const density = num('sim3d-density', 2700);
            if (!(density > 0)) {
                this._sim3dError('Densidad inválida: debe ser mayor que 0 kg/m³.');
                return null;
            }
            const modeEl = document.getElementById('sim3d-release-mode');
            const releaseMode = modeEl && modeEl.value === 'detachment' ? 'detachment' : 'fall';
            const height = releaseMode === 'fall' ? Math.max(0, num('sim3d-height', 2)) : 0;
            const kn = num('sim3d-kn', 0.35);
            const kt = num('sim3d-kt', 0.75);
            if (!(kn >= 0 && kn <= 1) || !(kt >= 0 && kt <= 1)) {
                this._sim3dError('Kn y Kt deben estar en [0, 1].');
                return null;
            }
            const variability = num('sim3d-variability', 10);
            if (!(variability >= 0) || variability > 100) {
                this._sim3dError('La variabilidad debe ser un porcentaje entre 0 y 100.');
                return null;
            }
            const rolling = num('sim3d-rolling', 0.15);
            if (!(rolling >= 0)) {
                this._sim3dError('La fricción de rodadura debe ser >= 0.');
                return null;
            }
            const roughness = num('sim3d-roughness', 0);
            if (!(roughness >= 0)) {
                this._sim3dError('La rugosidad debe ser >= 0°.');
                return null;
            }
            const duration = num('sim3d-duration', 60);
            if (!(duration > 0)) {
                this._sim3dError('La duración máxima debe ser > 0 s.');
                return null;
            }
            const seedEl = document.getElementById('sim3d-seed');
            const seedTxt = (seedEl && seedEl.value ? String(seedEl.value).trim() : '');
            let seed = null;
            if (seedTxt !== '') {
                seed = Math.abs(Math.round(parseFloat(seedTxt)));
                if (!Number.isFinite(seed)) {
                    this._sim3dError('Semilla inválida: debe ser un número entero (o vacía para aleatoria).');
                    return null;
                }
            }
            return {
                rocks: rocks,
                diameter: diameter,
                density: density,
                releaseMode: releaseMode,
                height: height,
                kn: kn,
                kt: kt,
                variability: variability,
                rolling: rolling,
                roughness: roughness,
                duration: duration,
                seed: seed,
            };
        },

        /** 'Ejecutar simulación 3D': validaciones + pool de workers. */
        sim3dRun() {
            if (this._sim3dRunActive) { return; }
            this._sim3dError(null);
            const dem = this.dem3d;
            if (!dem) {
                this._sim3dError('Importa un terreno (DEM 3D) antes de ejecutar la simulación.');
                return;
            }
            if (!this.sim3dZones.length) {
                this._sim3dError('Agrega al menos una zona de liberación (polígono o punto).');
                return;
            }
            const p = this._sim3dCollectParams();
            if (!p) { return; }

            const seed = p.seed !== null ? p.seed : (Date.now() >>> 0) % 2147483647;
            let specs;
            try {
                specs = SimRocas.Simulation3D.buildRockSpecs(dem, {
                    zones: this.sim3dZones,
                    totalRocks: p.rocks,
                    diameter: p.diameter,
                    density: p.density,
                    releaseMode: p.releaseMode,
                    heightAboveGround: p.height,
                    initialVelocity: { vx: 0, vy: 0, vz: 0 },
                    diameterVariability: 0,
                }, SimRocas.seededRandom(seed));
            } catch (err) {
                this._sim3dError('No se pudieron generar las rocas: ' + err.message);
                return;
            }

            const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
            const poolSize = Math.max(1, Math.min(POOL_SIZE_MAX, Math.floor(hw) - 1));
            let pool;
            try {
                pool = new SimRocas.Sim3DPool({
                    workerUrl: 'js/workers/sim3d-worker.js?v=' + SIM3D_WORKER_VERSION,
                    size: poolSize,
                });
            } catch (err) {
                this._sim3dError('No se pudo iniciar el pool de workers: ' + err.message);
                return;
            }
            this._sim3dPool = pool;
            this._sim3dRunActive = true;
            this.sim3dResult = null;
            const runBtn = document.getElementById('btn-sim3d-run');
            const cancelBtn = document.getElementById('btn-sim3d-cancel');
            if (runBtn) { runBtn.disabled = true; }
            if (cancelBtn) { cancelBtn.disabled = false; }
            this._sim3dShowProgress(true);
            this._sim3dUpdateProgress(0, specs.length);

            const engineParams = {
                gravity: 9.81,
                dt: 0.005,
                kn: p.kn,
                kt: p.kt,
                knVariability: p.variability,
                ktVariability: p.variability,
                rollingFriction: p.rolling,
                roughnessDeg: p.roughness,
            };
            pool.run({
                dem: dem,
                engineParams: engineParams,
                simParams: { maxDuration: p.duration, trajectoryInterval: 4, stepsPerRock: 50 },
                rockSpecs: specs,
                seed: seed,
                onProgress: (pr) => this._sim3dUpdateProgress(pr.done, pr.total),
            }).then((result) => {
                this._sim3dRunActive = false;
                this._sim3dPool = null;
                if (runBtn) { runBtn.disabled = false; }
                if (cancelBtn) { cancelBtn.disabled = true; }
                this._sim3dShowProgress(false);
                this._sim3dShowResults(result, seed, specs, poolSize, p);
            }).catch((err) => {
                this._sim3dRunActive = false;
                this._sim3dPool = null;
                if (runBtn) { runBtn.disabled = false; }
                if (cancelBtn) { cancelBtn.disabled = true; }
                this._sim3dShowProgress(false);
                const msg = (err && err.message) || String(err);
                if (msg.indexOf('cancelada') >= 0) {
                    this._sim3dError('Simulación cancelada.');
                } else {
                    this._sim3dError('La simulación 3D falló: ' + msg);
                }
            });
        },

        /** Botón 'Cancelar': termina los workers y rechaza la corrida. */
        sim3dCancelRun() {
            if (this._sim3dPool) {
                this._sim3dPool.cancel();
            }
        },

        /** Barra de progreso de la corrida. @private */
        _sim3dShowProgress(show) {
            const p = document.getElementById('sim3d-progress');
            if (p) { p.style.display = show ? 'block' : 'none'; }
        },

        _sim3dUpdateProgress(done, total) {
            const f = total > 0 ? Math.min(1, done / total) : 0;
            const label = document.getElementById('sim3d-progress-label');
            const fill = document.getElementById('sim3d-progress-fill');
            if (label) {
                label.textContent = 'Simulando… ' + Math.round(f * 100) + '% (' + done + '/' + total + ' rocas)';
            }
            if (fill) { fill.style.width = Math.round(f * 100) + '%'; }
        },

        /** Panel de resultados tras la corrida. @private */
        _sim3dShowResults(result, seed, specs, poolSize, params) {
            const rocks = result.rocks || [];
            const stats = result.stats || {};
            this.sim3dResult = {
                rocks: rocks,
                stats: stats,
                seed: seed,
                workers: result.timing ? result.timing.workers : poolSize,
                ms: result.timing ? result.timing.ms : 0,
                specs: specs,
                params: params || null,
                raster: SimRocas.Results3D.build(this.dem3d, rocks, { cellSize: this.dem3d.cellSize }),
            };
            const put = (id, text) => {
                const el = document.getElementById(id);
                if (el) { el.textContent = text; }
            };
            put('sim3d-stat-total', String(stats.total != null ? stats.total : rocks.length));
            put('sim3d-stat-rest', String(stats.rest != null ? stats.rest : '-'));
            put('sim3d-stat-culled', String(stats.culled != null ? stats.culled : '-'));
            put('sim3d-stat-maxsteps', String(stats.maxSteps != null ? stats.maxSteps : '-'));
            put('sim3d-stat-mean', stats.meanRunout != null ? stats.meanRunout.toFixed(1) + ' m' : '-');
            put('sim3d-stat-p95', stats.p95Runout != null ? stats.p95Runout.toFixed(1) + ' m' : '-');
            put('sim3d-stat-energy', stats.maxEnergyKJ != null ? stats.maxEnergyKJ.toFixed(2) + ' kJ' : '-');
            put('sim3d-stat-time', this.sim3dResult.ms.toFixed(0) + ' ms');
            put('sim3d-stat-workers', String(this.sim3dResult.workers));
            put('sim3d-stat-seed', String(seed));
            const panel = document.getElementById('sim3d-results');
            if (panel) { panel.style.display = 'block'; }

            // Trayectorias (capa propia del visor, hasta 500 rocas muestreadas).
            const tracks = document.getElementById('sim3d-show-tracks');
            this._sim3dShowTracks(!!(tracks && tracks.checked));
            // El mapa vuelve a 'Ninguno' hasta que el usuario elija.
            const mapSel = document.getElementById('sim3d-map');
            if (mapSel) { mapSel.value = ''; }
            this._sim3dApplyMap('');
        },

        /** Muestra/oculta la capa de trayectorias y su leyenda de velocidad. */
        _sim3dShowTracks(show) {
            const viewer = this.get3dViewer();
            const legend = document.getElementById('sim3d-track-legend');
            if (!viewer || !this.sim3dResult) {
                if (viewer) { viewer.setTrajectories(null); }
                if (legend) { legend.style.display = 'none'; }
                return;
            }
            if (!show) {
                viewer.setTrajectories(null);
                if (legend) { legend.style.display = 'none'; }
                return;
            }
            const built = SimRocas.Trajectories3D.build(this.sim3dResult.rocks, {
                maxTracks: 500,
                exaggeration: this.demExaggeration || 1,
                colorBy: 'speed',
            });
            viewer.setTrajectories(built ? built.group : null);
            if (legend) {
                if (built) {
                    const minEl = document.getElementById('sim3d-track-min');
                    const maxEl = document.getElementById('sim3d-track-max');
                    const bar = document.getElementById('sim3d-track-bar');
                    if (bar) { bar.style.background = SimRocas.Trajectories3D.rampCss(); }
                    if (minEl) { minEl.textContent = built.legend.minSpeed.toFixed(1) + ' m/s'; }
                    if (maxEl) { maxEl.textContent = built.legend.maxSpeed.toFixed(1) + ' m/s'; }
                    legend.style.display = 'block';
                } else {
                    legend.style.display = 'none';
                }
            }
        },

        /**
         * Colorized los vértices de la malla de visualización muestreando el
         * ráster del campo elegido. 'Ninguno' restaura la coloración.
         * @private
         */
        _sim3dApplyMap(field) {
            this._sim3dMapField = field === '' ? '' : (SimRocas.Sim3DMaps.MAPS[field] ? field : '');
            const viewer = this.get3dViewer();
            const mesh = this.demMesh3d;
            const legend = document.getElementById('sim3d-map-legend');
            if (!mesh || !this.sim3dResult) {
                if (legend) { legend.style.display = 'none'; }
                return;
            }
            const posAttr = mesh.geometry.getAttribute('position');
            const colAttr = mesh.geometry.getAttribute('color');
            if (!posAttr || !colAttr) { return; }
            // Copia de seguridad de la coloración original (una vez).
            if (!this._sim3dTerrainColors || this._sim3dTerrainColors.length !== colAttr.array.length) {
                this._sim3dTerrainColors = new Float32Array(colAttr.array);
            }
            const colors = colAttr.array;
            const colorsBackup = this._sim3dTerrainColors;
            const spec = field !== '' ? SimRocas.Sim3DMaps.MAPS[field] : null;
            if (!spec) {
                colors.set(colorsBackup);
                colAttr.needsUpdate = true;
                if (viewer) { viewer.requestRender(); }
                if (legend) { legend.style.display = 'none'; }
                return;
            }
            const raster = this.sim3dResult.raster;
            const data = raster[spec.field];
            const passCount = raster.passCount;
            // Pasada 1: rango del campo (celdas con passCount > 0 si gated).
            let min = Infinity;
            let max = -Infinity;
            for (let k = 0; k < data.length; k++) {
                if (spec.gate && passCount[k] === 0) { continue; }
                const v = data[k];
                if (Number.isFinite(v)) {
                    if (v < min) { min = v; }
                    if (v > max) { max = v; }
                }
            }
            if (!Number.isFinite(min)) { min = max = 0; }
            const range = max > min ? max - min : 1;
            // Pasada 2: cada vértice muestrea el ráster en su celda.
            const pos = posAttr.array;
            for (let v = 0; v < pos.length; v += 3) {
                const value = SimRocas.Sim3DMaps.sampleRaster(raster, spec.field, pos[v], pos[v + 1]);
                const idx = Math.floor(pos[v] / raster.cellSize) +
                    Math.floor(pos[v + 1] / raster.cellSize) * raster.cols;
                const hasData = value !== null && idx >= 0 && idx < passCount.length &&
                    passCount[idx] > 0;
                if (value === null || !Number.isFinite(value) || !hasData) {
                    colors[v] = colorsBackup[v];
                    colors[v + 1] = colorsBackup[v + 1];
                    colors[v + 2] = colorsBackup[v + 2];
                } else {
                    const c = SimRocas.Sim3DMaps.rampColor(spec.stops, (value - min) / range);
                    colors[v] = c[0];
                    colors[v + 1] = c[1];
                    colors[v + 2] = c[2];
                }
            }
            colAttr.needsUpdate = true;
            if (viewer) { viewer.requestRender(); }
            // Leyenda (mín–máx + gradiente).
            if (legend) {
                const title = document.getElementById('sim3d-map-legend-title');
                const minEl = document.getElementById('sim3d-map-min');
                const maxEl = document.getElementById('sim3d-map-max');
                const bar = document.getElementById('sim3d-map-bar');
                if (title) { title.textContent = spec.label; }
                if (bar) { bar.style.background = SimRocas.Sim3DMaps.stopsCss(spec.stops); }
                if (minEl) { minEl.textContent = min.toFixed(spec.decimals); }
                if (maxEl) { maxEl.textContent = max.toFixed(spec.decimals); }
                legend.style.display = 'block';
            }
        },

        /** Descarga de texto (Blob) como archivo. @private */
        _sim3dDownloadText(text, filename) {
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        /** 'Exportar ASC' del campo del mapa activo. @private */
        _sim3dExportAsc() {
            if (!this.sim3dResult) {
                this._sim3dError('Ejecuta la simulación 3D antes de exportar.');
                return;
            }
            if (!this._sim3dMapField) {
                this._sim3dError('Selecciona un campo del "Mapa sobre el terreno" para exportar el ASC.');
                return;
            }
            try {
                const text = SimRocas.Results3D.toAsc(this.sim3dResult.raster, this.dem3d, this._sim3dMapField);
                this._sim3dDownloadText(text, 'simrocas_' + this._sim3dMapField + '.asc');
                this._sim3dStatus('ASC exportado: simrocas_' + this._sim3dMapField + '.asc', false);
            } catch (err) {
                this._sim3dError('No se pudo exportar el ASC: ' + err.message);
            }
        },

        /** 'Exportar CSV de rocas' con coordenadas finales MUNDO. @private */
        _sim3dExportCsv() {
            if (!this.sim3dResult) {
                this._sim3dError('Ejecuta la simulación 3D antes de exportar el CSV.');
                return;
            }
            const dem = this.dem3d;
            const rocks = this.sim3dResult.rocks;
            const specs = this.sim3dResult.specs || [];
            const lines = ['id,x,y,z,stop_reason,energia_max_kj,alcance_m'];
            for (let i = 0; i < rocks.length; i++) {
                const r = rocks[i];
                const fx = r.finalX !== undefined ? r.finalX : r.x;
                const fy = r.finalY !== undefined ? r.finalY : r.y;
                const fz = r.finalZ !== undefined ? r.finalZ : r.z;
                const w = dem.localToWorld(fx, fy, fz);
                const sp0 = specs[i] || { x: fx, y: fy };
                const runout = Math.hypot(fx - sp0.x, fy - sp0.y);
                const eKJ = typeof r.maxKineticEnergy === 'number' ? r.maxKineticEnergy / 1000 : 0;
                lines.push([
                    i + 1,
                    w.x.toFixed(2), w.y.toFixed(2), w.z.toFixed(2),
                    r.stopReason || '',
                    eKJ.toFixed(3),
                    runout.toFixed(2),
                ].join(','));
            }
            this._sim3dDownloadText(lines.join('\n') + '\n', 'simrocas_rocas_3d.csv');
            this._sim3dStatus('CSV exportado: simrocas_rocas_3d.csv (' + rocks.length + ' rocas)', false);
        },

        /**
         * Corrección del punto de liberación al cargar un perfil 2D nuevo
         * (desde el 3D y desde STL): x = x0 + 2 % de la longitud, y = cota
         * del terreno (+ 5 m en caída libre). Actualiza el estado y los
         * inputs #release-x/#release-y. Llamado tras terrain.setPoints().
         * @param {Array<{x: number, y: number}>} points Puntos del perfil 2D.
         * @returns {object|null} colocación { x, y, terrainY } o null.
         */
        _syncReleaseAfterProfile(points) {
            if (!this.terrain || !Array.isArray(points) || points.length < 2) {
                return null;
            }
            let place;
            try {
                place = SimRocas.ReleasePlacement.fromProfile(
                    points, this.releaseMode || 'freefall',
                    (x) => this.terrain.getHeightAt(x));
            } catch (err) {
                return null;
            }
            this.releasePoint.x = place.x;
            this.releasePoint.y = place.y;
            const ix = document.getElementById('release-x');
            const iy = document.getElementById('release-y');
            if (ix) { ix.value = place.x.toFixed(1); }
            if (iy) { iy.value = place.y.toFixed(1); }
            return place;
        },

        /** Mensaje de estado (no bloqueante) en el panel de zonas. @private */
        _sim3dStatus(msg, isWarn) {
            const el = document.getElementById('sim3d-zones-status');
            if (!el) {
                if (msg) { console.log('[sim 3D]', msg); }
                return;
            }
            el.textContent = msg || '';
            el.classList.toggle('dem-profile-status-warn', !!isWarn);
            el.style.display = msg ? 'block' : 'none';
        },

        /** Error/validación en el panel de simulación 3D. @private */
        _sim3dError(msg) {
            const el = document.getElementById('sim3d-error');
            if (!el) { return; }
            if (!msg) {
                el.style.display = 'none';
                el.textContent = '';
                return;
            }
            el.textContent = msg;
            el.style.display = 'block';
        },
    });

    // Esc cancela el dibujo de zona/punto (independiente del trazado de perfil).
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && window.app &&
            (window.app._sim3dZoneDrawing || window.app._sim3dPointMode)) {
            window.app.sim3dCancelZone();
        }
    });
})(globalThis.SimRocas);

// Los mixins se cargan tras app.js: en DOMContentLoaded `window.app` existe.
document.addEventListener('DOMContentLoaded', () => {
    if (typeof window !== 'undefined' && window.app &&
        typeof window.app.setupSim3dControls === 'function') {
        window.app.setupSim3dControls();
    }
});
