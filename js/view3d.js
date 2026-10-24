globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Promise que resuelve cuando THREE (vendido) está disponible.
     * - Resuelve de inmediato si globalThis.THREE ya existe.
     * - Si no, espera el evento 'simrocas:three-ready' (disparado por js/three-bridge.js).
     * Requiere el importmap + <script type="module" src="js/three-bridge.js">
     * antes de llamar a Viewer3D.
     * @returns {Promise<void>}
     */
    function whenThreeReady() {
        if (globalThis.THREE) {
            return Promise.resolve();
        }
        return new Promise(function (resolve) {
            globalThis.addEventListener('simrocas:three-ready', resolve, { once: true });
        });
    }

    /**
     * Visor 3D con OrbitControls sobre un canvas WebGL.
     * Coordenadas de escena = coordenadas LOCALES del DEM (nunca UTM: la GPU
     * trabaja en float32 y UTM introduce imprecisión al ser coordenadas grandes).
     * Render bajo demanda: solo cuando cambian controles o datos.
     */
    class Viewer3D {
        /**
         * @param {HTMLElement} container Elemento DOM donde se monta el canvas.
         */
        constructor(container) {
            if (!container || container.nodeType !== 1) {
                throw new Error('Viewer3D: container debe ser un elemento del DOM');
            }
            if (!globalThis.THREE) {
                throw new Error('Viewer3D: THREE no está disponible todavía; usa SimRocas.whenThreeReady() antes de construir');
            }
            const THREE = globalThis.THREE;
            this.container = container;
            this._THREE = THREE;
            this._disposed = false;

            this.renderer = new THREE.WebGLRenderer({ antialias: true });
            this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
            this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
            this.canvas = this.renderer.domElement;
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.display = 'block';
            container.appendChild(this.canvas);

            this.scene = new THREE.Scene();
            // Fondo leído de la variable CSS --bg-primary si existe.
            let bg = null;
            try {
                const styles = getComputedStyle(document.documentElement);
                const raw = styles.getPropertyValue('--bg-primary').trim();
                if (raw) { bg = raw; }
            } catch (e) { /* sin getComputedStyle: fondo por defecto */ }
            let bgColor = new THREE.Color(0x11151c);
            if (bg) {
                try { bgColor = new THREE.Color(bg); } catch (e2) { /* valor CSS inválido */ }
            }
            this.scene.background = bgColor;

            // Z hacia ARRIBA (convención de coordenadas del DEM/mundo).
            this.camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 1e6);
            this.camera.up.set(0, 0, 1);
            this.camera.position.set(0, -100, 60);
            this.camera.lookAt(0, 0, 0);

            // Luz hemisférica (cielo/ suelo) + direccional con sombra suave.
            this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
            this.scene.add(this.hemiLight);
            this.dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
            this.dirLight.position.set(0.5, -0.3, 1);
            this.dirLight.position.normalize();
            this.scene.add(this.dirLight);

            this.controls = new THREE.OrbitControls(this.camera, this.canvas);
            this.controls._needsRender = true;
            const invalidate = () => { this.controls._needsRender = true; };
            ['change', 'start', 'end'].forEach(function (ev) {
                this.controls.addEventListener(ev, invalidate);
            }, this);

            this._observers = [];
            this._listeners = [];
            this._resizeObs = new ResizeObserver(() => this._resize());
            this._resizeObs.observe(container);
            this._observers.push(this._resizeObs);
            this._resize();

            this._renderIfNeeded();

            // Limpieza si el contenedor sale del DOM.
            const observer = new MutationObserver(() => {
                if (!document.body.contains(container)) { this.dispose(); }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            this._observers.push(observer);

            SimRocas._viewers = SimRocas._viewers || [];
            SimRocas._viewers.push(this);
        }

        /** Ajusta el canvas al tamaño actual del contenedor. */
        _resize() {
            if (this._disposed || !this.container) { return; }
            const w = this.container.clientWidth || 800;
            const h = this.container.clientHeight || 600;
            if (this.canvas.width !== Math.round(w) ||
                this.canvas.height !== Math.round(h)) {
                this.renderer.setSize(w, h, false);
            }
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.controls._needsRender = true;
        }

        /** Renderiza solo si fue invalidado (cambio de controles o datos). */
        _renderIfNeeded() {
            if (this._disposed) { return; }
            requestAnimationFrame(() => this._renderIfNeeded());
            if (!this.controls._needsRender) { return; }
            this.renderer.render(this.scene, this.camera);
            this.controls._needsRender = false;
        }

        /** Encola un render (llamar tras modificar escenas o datos externos). */
        requestRender() {
            if (this._disposed) { return; }
            this.controls._needsRender = true;
        }

        /**
         * Coloca la cámara para encuadrar las coordenadas locales dadas.
         * @param {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}} bounds
         */
        fitToBounds(bounds) {
            if (!bounds || !Number.isFinite(bounds.maxX - bounds.minX)) {
                throw new Error('Viewer3D.fitToBounds: bounds incompletos');
            }
            const spanX = bounds.maxX - bounds.minX;
            const spanY = bounds.maxY - bounds.minY;
            const spanZ = Math.max(bounds.maxZ - bounds.minZ, 1);
            const cx = (bounds.minX + bounds.maxX) / 2;
            const cy = (bounds.minY + bounds.maxY) / 2;
            const cz = (bounds.minZ + bounds.maxZ) / 2;
            // Cámara a elevación fija (35°): ajustar distancia por las tres dimensiones
            // proyectadas (X por ancho de pantalla; Y y Z por alto).
            const theta = 35 * Math.PI / 180;
            const fovV = (this.camera.fov || 55) * Math.PI / 180;
            const tanV = Math.tan(0.5 * fovV);
            const aspect = this.camera.aspect || 1;
            const tanH = tanV * aspect;
            const margin = 1.15;
            const dW = (spanX * margin) / (2 * tanH);              // encaja en ancho
            const dD = (spanY * margin) / (2 * tanV);              // encaja en alto (sin foreshortening)
            const dH = (spanZ * margin) / (2 * tanV);              // altura vertical
            const dist = Math.max(dW, dD, dH);
            this.camera.position.set(cx, cy - dist * Math.cos(theta), cz + dist * Math.sin(theta));
            this.controls.target.set(cx, cy, cz);
            this.controls.update();
            this.controls._needsRender = true;
        }

        /**
         * Exageración vertical: escala ALTURA de objetos colgando del viewer
         * (no toca el terreno, lo hace setTerrain).
         * @param {number} k factor (>= 0).
         */
        setVerticalExaggeration(k) {
            if (!Number.isFinite(k) || k < 0) {
                throw new Error('Viewer3D: exaggeration debe ser un número >= 0');
            }
            this.verticalExaggeration = k;
            if (this._terrain) {
                this._terrain.scale.z = k;
            }
            // Las capas superpuestas (perfil trazado, línea de sección, curvas,
            // zonas de liberación, trayectorias) cuelgan de grupos con
            // coordenadas locales: propaga la exageración.
            for (const key of ['_profileGroup', '_sectionGroup', '_contourGroup',
                '_zonesGroup', '_trajectoriesGroup']) {
                if (this[key]) { this[key].scale.z = k; }
            }
            this.requestRender();
        }

        /**
         * Coloca un terreno (THREE.Mesh creado por TerrainMesh3D.build) y
         * desecha el anterior. Ajusta cámara si es el primer terreno o si
         * `fit` no es false.
         * @param {THREE.Mesh} mesh
         * @param {{colorMode?: string, exaggeration?: number, fit?: boolean}} [options]
         */
        setTerrain(mesh, options = {}) {
            if (this._disposed) { throw new Error('Viewer3D: instancia ya dispuesta'); }
            if (this._terrain) {
                this.scene.remove(this._terrain);
                if (this._terrain.geometry) { this._terrain.geometry.dispose(); }
                if (this._terrain.material) {
                    if (Array.isArray(this._terrain.material)) {
                        this._terrain.material.forEach(m => m.dispose());
                    } else {
                        this._terrain.material.dispose();
                    }
                }
                this._terrain = null;
            }
            this._terrain = mesh;
            const k = Number.isFinite(options.exaggeration)
                ? Math.max(0, options.exaggeration)
                : (this.verticalExaggeration !== undefined ? this.verticalExaggeration : 1);
            this.verticalExaggeration = k;
            mesh.scale.z = k;
            this.scene.add(mesh);
            const fit = options.fit !== false;
            if (fit && mesh.userData.bounds) {
                this.fitToBounds(mesh.userData.bounds);
            }
            this.requestRender();
        }

        /* --------------------------------------- picking (T3.5 trazado de perfil) */

        /**
         * Lanza un rayo desde coordenadas de cliente (clientX/clientY) contra el
         * terreno y devuelve el punto en coordenadas LOCALES del DEM, DESHACIENDO
         * la exageración vertical (z_local = z_escena / exageración).
         * @param {number} clientX Coordenada de cliente (evento de puntero).
         * @param {number} clientY
         * @returns {{x: number, y: number, z: number}|null} null si no hay
         *          terreno o el rayo no lo toca.
         */
        pickTerrainLocal(clientX, clientY) {
            if (this._disposed || !this._terrain) { return null; }
            const rect = this.canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) { return null; }
            const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
            const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
            if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) { return null; }
            const raycaster = new this._THREE.Raycaster();
            raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
            let hits = [];
            try {
                hits = raycaster.intersectObject(this._terrain, false);
            } catch (e) { return null; }
            if (!hits || hits.length === 0) { return null; }
            const p = hits[0].point;
            const k = (Number.isFinite(this.verticalExaggeration) && this.verticalExaggeration > 0)
                ? this.verticalExaggeration : 1;
            return { x: p.x, y: p.y, z: p.z / k };
        }

        /* ------------------------------- vista en planta (T3.7) y capas 3D */

        /** Color desde una variable CSS de :root (con fallback hexadecimal). */
        _cssColor(varName, fallbackHex) {
            let color = null;
            try {
                const raw = getComputedStyle(document.documentElement)
                    .getPropertyValue(varName).trim();
                if (raw) { color = new this._THREE.Color(raw); }
            } catch (e) { /* valor CSS inválido: usar fallback */ }
            if (!color) { color = new this._THREE.Color(fallbackHex); }
            return color;
        }

        /**
         * Elevación local (sin exageración) con la que se levantan las capas
         * dibujadas sobre el terreno para evitar z-fighting.
         * @private
         */
        _layerLift() {
            const b = this._terrain && this._terrain.userData.bounds;
            if (b && Number.isFinite(b.maxZ) && Number.isFinite(b.minZ)) {
                return Math.max((b.maxZ - b.minZ) * 0.008, 0.25);
            }
            return 1;
        }

        /** Radio local de los marcadores de vértice. @private */
        _markerRadius() {
            const b = this._terrain && this._terrain.userData.bounds;
            if (b && Number.isFinite(b.maxZ) && Number.isFinite(b.minZ)) {
                return Math.max((b.maxZ - b.minZ) * 0.006, 0.35);
            }
            return 0.5;
        }

        /**
         * Crea (o reemplaza) un grupo-linea con marcadores en la escena.
         * @private
         * @param {string} key '_profileGroup' | '_sectionGroup'
         * @param {Array<{x: number, y: number, z: number}>} vertices locales, sin
         *        exageración (z de escena = z·k).
         * @param {{colorVar: string, colorFallback: string}} style
         */
        _upsertPolylineLayer(key, vertices, style) {
            if (!this.scene) { return; }
            const THREE = this._THREE;
            const lift = this._layerLift();
            const positions = new Float32Array(vertices.length * 3);
            for (let i = 0; i < vertices.length; i++) {
                positions[i * 3] = vertices[i].x;
                positions[i * 3 + 1] = vertices[i].y;
                positions[i * 3 + 2] = (Number.isFinite(vertices[i].z)
                    ? vertices[i].z : 0) + lift;
            }
            const material = new THREE.LineBasicMaterial({
                color: this._cssColor(style.colorVar, style.colorFallback),
                depthTest: false, // la polilínea debe verse sobre el terreno
                transparent: true,
                opacity: 0.95
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const line = new THREE.Line(geometry, material);
            line.renderOrder = 10;

            let group = this[key];
            if (!group) {
                group = new THREE.Group();
                group.scale.z = (this.verticalExaggeration === undefined
                    ? 1 : this.verticalExaggeration);
                this.scene.add(group);
                this[key] = group;
            }
            this._disposeGroupChildren(group);
            group.add(line);
            // Markers: esferas pequeñas en cada vértice (sin depthTest, como la línea).
            const radius = Math.min(this._markerRadius(), Math.max(lift * 2, 0.35));
            if (vertices.length) {
                const mkGeom = new THREE.SphereGeometry(radius, 8, 6);
                const mkMat = material.clone();
                for (const v of vertices) {
                    const mk = new THREE.Mesh(mkGeom, mkMat);
                    mk.position.set(v.x, v.y, (Number.isFinite(v.z) ? v.z : 0) + lift);
                    mk.renderOrder = 11;
                    group.add(mk);
                }
            }
            this.requestRender();
        }

        /** Libera los hijos de un grupo de capas (geometrías y materiales). */
        _disposeGroupChildren(group) {
            if (!group) { return; }
            const seen = new Set();
            for (const child of [...group.children]) {
                group.remove(child);
                if (child.geometry && !seen.has(child.geometry)) {
                    seen.add(child.geometry);
                    child.geometry.dispose();
                }
                if (child.material && !seen.has(child.material)) {
                    seen.add(child.material);
                    child.material.dispose();
                }
            }
        }

        _removeLayer(key) {
            const group = this[key];
            if (!group) { return; }
            this._disposeGroupChildren(group);
            this.scene.remove(group);
            this[key] = null;
            this.requestRender();
        }

        /**
         * Dibuja la polilínea EN TRAZADO (vertices locales sin exageración;
         * el z puede ser 0 si aún no se conoce la cota).
         */
        setProfilePolyline(vertices) {
            if (this._disposed) { return null; }
            if (!vertices || vertices.length === 0) {
                this._removeLayer('_profileGroup');
                return null;
            }
            this._upsertPolylineLayer('_profileGroup', vertices, {
                colorVar: '--view3d-profile-line',
                colorFallback: '#4ecdc4'
            });
            return this._profileGroup;
        }

        /**
         * Línea de sección confirmada (tras enviarla al modo 2D): color
         * distinto del trazado en curso.
         */
        setSectionLine(vertices) {
            if (this._disposed) { return null; }
            if (!vertices || vertices.length === 0) {
                this._removeLayer('_sectionGroup');
                return null;
            }
            this._upsertPolylineLayer('_sectionGroup', vertices, {
                colorVar: '--view3d-section-line',
                colorFallback: '#ffa500'
            });
            return this._sectionGroup;
        }

        /** Retira los marcadores del trazado y deja la línea de sección sola. */
        clearProfilePolyline() {
            this._removeLayer('_profileGroup');
        }

        /** Retira la línea de sección de la escena. */
        clearSectionLine() {
            this._removeLayer('_sectionGroup');
        }

        /**
         * Curvas de nivel (T3.7): THREE.LineSegments a partir de posiciones
         * locales [x1, y1, z1, x2, y2, z2, ...] (sim.PlanView.segmentPositions).
         * Cada punto se dibuja a su cota del terreno (drapped); el escalado
         * por exageración lo aplica el grupo.
         * @param {Float32Array} positions null elimina las curvas.
         */
        setContourLines(positions) {
            if (this._disposed) { return null; }
            if (!positions || positions.length === 0) {
                this._removeLayer('_contourGroup');
                return null;
            }
            const THREE = this._THREE;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position',
                new THREE.BufferAttribute(positions, 3));
            const material = new THREE.LineBasicMaterial({
                color: this._cssColor('--view3d-contour', '#8fd3e8'),
                transparent: true,
                opacity: 0.65,
                depthTest: true
            });
            const segs = new THREE.LineSegments(geometry, material);
            let group = this._contourGroup;
            if (!group) {
                group = new THREE.Group();
                group.scale.z = (this.verticalExaggeration === undefined
                    ? 1 : this.verticalExaggeration);
                this.scene.add(group);
                this._contourGroup = group;
            }
            this._disposeGroupChildren(group);
            group.add(segs);
            this.requestRender();
            return group;
        }

        /** Retira las curvas de nivel. */
        clearContourLines() {
            this._removeLayer('_contourGroup');
        }

        /* ------------------------------------- zonas de liberación (T4.6) */

        /**
         * Zonas de liberación: polígonos (línea cerrada + marcadores) y
         * puntos de liberación (marcador). Entradas con coordenadas
         * LOCALES sin exageración (z ya materializada por el llamador):
         *   { type: 'point', x, y, z }
         *   { type: 'polygon', vertices: [{x, y, z}, ...] }
         *   { type: 'drawing', vertices: [...] }  (trazado en curso,
         *                                          polilínea abierta)
         * @param {Array<object>} entries null/[] retira la capa.
         * @returns {THREE.Group|null}
         */
        setZonesLayer(entries) {
            if (this._disposed) { return null; }
            if (!entries || entries.length === 0) {
                this.clearZonesLayer();
                return null;
            }
            const THREE = this._THREE;
            const lift = this._layerLift();
            let group = this._zonesGroup;
            if (!group) {
                group = new THREE.Group();
                group.scale.z = (this.verticalExaggeration === undefined
                    ? 1 : this.verticalExaggeration);
                this.scene.add(group);
                this._zonesGroup = group;
            }
            this._disposeGroupChildren(group);
            const polygonColor = this._cssColor('--canvas-release-detachment', '#4ecdc4');
            const pointColor = this._cssColor('--view3d-section-line', '#ffa500');
            const radius = Math.min(this._markerRadius(), Math.max(lift * 2, 0.35));
            const mkGeom = new THREE.SphereGeometry(radius, 8, 6);
            for (const entry of entries) {
                if (!entry) { continue; }
                if (entry.type === 'point') {
                    const mk = new THREE.Mesh(mkGeom, new THREE.MeshBasicMaterial({
                        color: pointColor, depthTest: false,
                    }));
                    mk.position.set(entry.x, entry.y, (Number.isFinite(entry.z) ? entry.z : 0) + lift);
                    mk.renderOrder = 11;
                    group.add(mk);
                    continue;
                }
                const verts = entry.vertices;
                if (!verts || verts.length === 0) { continue; }
                const closed = entry.type === 'polygon';
                const count = closed ? verts.length + 1 : verts.length;
                const positions = new Float32Array(count * 3);
                for (let k = 0; k < count; k++) {
                    const v = verts[k % verts.length];
                    positions[k * 3] = v.x;
                    positions[k * 3 + 1] = v.y;
                    positions[k * 3 + 2] = (Number.isFinite(v.z) ? v.z : 0) + lift;
                }
                const material = new THREE.LineBasicMaterial({
                    color: closed ? polygonColor : pointColor,
                    depthTest: false,
                    transparent: true,
                    opacity: closed ? 0.95 : 0.7,
                });
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                const line = new THREE.Line(geometry, material);
                line.renderOrder = 10;
                group.add(line);
                const mkMat = new THREE.MeshBasicMaterial({
                    color: closed ? polygonColor : pointColor,
                    depthTest: false,
                });
                for (const v of verts) {
                    const mk = new THREE.Mesh(mkGeom, mkMat);
                    mk.position.set(v.x, v.y, (Number.isFinite(v.z) ? v.z : 0) + lift);
                    mk.renderOrder = 11;
                    group.add(mk);
                }
            }
            this.requestRender();
            return group;
        }

        /** Retira la capa de zonas de liberación. */
        clearZonesLayer() {
            this._removeLayer('_zonesGroup');
        }

        /* --------------------------------- trayectorias de simulación (T4.6) */

        /**
         * Capa de trayectorias: recibe el THREE.Group construido por
         * SimRocas.Trajectories3D.build (LineSegments + Points). Se coloca en
         * un grupo propio con la exageración vertical actual; null la retira.
         * @param {THREE.Group|null} group
         * @returns {THREE.Group|null}
         */
        setTrajectories(group) {
            if (this._disposed) { return null; }
            this.clearTrajectories();
            if (!group) { return null; }
            const k = (Number.isFinite(this.verticalExaggeration) && this.verticalExaggeration > 0)
                ? this.verticalExaggeration : 1;
            group.scale.z = k;
            this.scene.add(group);
            this._trajectoriesGroup = group;
            this.requestRender();
            return group;
        }

        /** Retira la capa de trayectorias (la capa se descarta con sus hijos). */
        clearTrajectories() {
            const group = this._trajectoriesGroup;
            if (!group) { return; }
            this._disposeGroupChildren(group);
            this.scene.remove(group);
            this._trajectoriesGroup = null;
            this.requestRender();
        }

        /**
         * Vista en planta (T3.7): cámara cenital sobre el terreno (guarda y
         * restaura el encuadre previo).
         * @param {boolean} on
         * @returns {boolean} estado final (isTopView).
         */
        setTopView(on) {
            if (this._disposed) { return false; }
            if (on) {
                if (this._topViewSaved) { return this.isTopView = true; }
                const b = (this._terrain && this._terrain.userData.bounds) ||
                    { minX: -50, maxX: 50, minY: -50, maxY: 50, minZ: 0, maxZ: 50 };
                const spanX = Math.max(b.maxX - b.minX, 1);
                const spanY = Math.max(b.maxY - b.minY, 1);
                const cx = (b.minX + b.maxX) / 2;
                const cy = (b.minY + b.maxY) / 2;
                const cz = Number.isFinite(b.maxZ)
                    ? (b.minZ + b.maxZ) / 2 : 0;
                const maxZ = Number.isFinite(b.maxZ) ? b.maxZ : cz;
                const fovV = (this.camera.fov || 55) * Math.PI / 180;
                const tanV = Math.tan(0.5 * fovV);
                const tanH = tanV * (this.camera.aspect || 1);
                const dist = Math.max(spanX / (2 * tanH), spanY / (2 * tanV)) * 1.15 + spanY;
                this._topViewSaved = {
                    position: this.camera.position.clone(),
                    target: this.controls.target.clone(),
                    up: this.camera.up.clone()
                };
                this.camera.up.set(0, 1, 0);
                this.camera.position.set(cx, cy, maxZ + dist);
                this.controls.target.set(cx, cy, cz);
                this.controls.update();
                this.controls._needsRender = true;
                return this.isTopView = true;
            }
            if (this._topViewSaved) {
                const s = this._topViewSaved;
                this.camera.up.copy(s.up);
                this.camera.position.copy(s.position);
                this.controls.target.copy(s.target);
                this.controls.update();
                this._topViewSaved = null;
                this.controls._needsRender = true;
            }
            return this.isTopView = false;
        }

        /** Libera canvas, geometrías, materiales, renderer, observers y listeners. */
        dispose() {
            if (this._disposed) { return; }
            this._disposed = true;
            if (this._terrain) {
                this.scene.remove(this._terrain);
                if (this._terrain.geometry) { this._terrain.geometry.dispose(); }
                if (this._terrain.material) {
                    if (Array.isArray(this._terrain.material)) {
                        this._terrain.material.forEach(m => m.dispose());
                    } else {
                        this._terrain.material.dispose();
                    }
                }
                this._terrain = null;
            }
            this._disposeGroupChildren(this._profileGroup);
            if (this._profileGroup) { this.scene.remove(this._profileGroup); this._profileGroup = null; }
            this._disposeGroupChildren(this._sectionGroup);
            if (this._sectionGroup) { this.scene.remove(this._sectionGroup); this._sectionGroup = null; }
            this._disposeGroupChildren(this._contourGroup);
            if (this._contourGroup) { this.scene.remove(this._contourGroup); this._contourGroup = null; }
            this._disposeGroupChildren(this._zonesGroup);
            if (this._zonesGroup) { this.scene.remove(this._zonesGroup); this._zonesGroup = null; }
            if (this._trajectoriesGroup) {
                this._disposeGroupChildren(this._trajectoriesGroup);
                this.scene.remove(this._trajectoriesGroup);
                this._trajectoriesGroup = null;
            }
            this._observers.forEach(o => { try { o.disconnect(); } catch (e) { /* noop */ } });
            if (this.controls && this.controls.dispose) { this.controls.dispose(); }
            this.renderer.dispose();
            if (this.canvas && this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
            }
            const idx = (SimRocas._viewers || []).indexOf(this);
            if (idx >= 0) { SimRocas._viewers.splice(idx, 1); }
        }
    }

    SimRocas.whenThreeReady = whenThreeReady;
    SimRocas.Viewer3D = Viewer3D;
})(globalThis.SimRocas);
