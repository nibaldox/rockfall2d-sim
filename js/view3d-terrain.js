globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    /**
     * Utilidades puras (sin THREE) para tests headless y worker.
     * Coordenadas de escena = coordenadas LOCALES del DEM.
     */

    /** Pendiente en grados a partir de una normal unitaria {nx, ny, nz} con nz > 0. */
    function slopeDegFromNormal(nx, ny, nz) {
        if (![nx, ny, nz].every(Number.isFinite) || nz <= 0) {
            return NaN;
        }
        // Pendiente = ángulo con el plano horizontal = atan2(|n_z|, sqrt(nx^2+ny^2)) -> deg.
        const len = Math.hypot(nx, ny, nz);
        if (len === 0) { return NaN; }
        return Math.atan2(Math.hypot(nx, ny), nz) * 180 / Math.PI;
    }

    /** Construye [r, g, b] (0..1) de un color THREE; utilidad de test puro no usada acá. */
    function _clamp01(v) {
        return (v < 0) ? 0 : (v > 1) ? 1 : v;
    }

    /**
     * Rampa hipsométrica por cota: azul → verde → amarillo → marrón → blanco.
     * t en [0, 1] (fracción de la cota entre minZ y maxZ); fuera se recorta.
     * @returns {[number, number, number]} rgb en 0..1.
     */
    function colorForElevation(t) {
        if (!Number.isFinite(t)) {
            return [0.8, 0.2, 0.2]; // rosa-rojo reservado para NaN
        }
        t = _clamp01(t);
        // Paradas hipsométricas estándar.
        const stops = [
            { t: 0.00, c: [0.23, 0.49, 0.94] }, // azul (agua base)
            { t: 0.20, c: [0.29, 0.70, 0.37] }, // verde
            { t: 0.45, c: [0.85, 0.85, 0.38] }, // amarillo verdoso
            { t: 0.70, c: [0.72, 0.55, 0.28] }, // marrón
            { t: 1.00, c: [0.98, 0.98, 0.98] }  // blanco (cumbre)
        ];
        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i];
            const b = stops[i + 1];
            if (t >= a.t && t <= b.t) {
                const f = (t - a.t) / (b.t - a.t || 1);
                return [
                    a.c[0] + f * (b.c[0] - a.c[0]),
                    a.c[1] + f * (b.c[1] - a.c[1]),
                    a.c[2] + f * (b.c[2] - a.c[2])
                ];
            }
        }
        return stops[stops.length - 1].c;
    }

    /**
     * Color por pendiente: 0° verde → 35° amarillo → >60° rojo.
     * >73° (nearly vertical) → gris.
     * @param {number} slopeDeg
     * @returns {[number, number, number]} rgb en 0..1.
     */
    function colorForSlope(slopeDeg) {
        if (!Number.isFinite(slopeDeg) || slopeDeg < 0) {
            return [0.7, 0.15, 0.15]; // NaN sin datos
        }
        let d = slopeDeg;
        if (d >= 73) {
            return [0.45, 0.45, 0.45]; // gris casi vertical
        }
        if (d <= 0) { return [0.15, 0.75, 0.2]; }
        if (d <= 35) {
            const f = d / 35;
            // verde → amarillo
            return [0.15 + f * (0.90 - 0.15), 0.75 + f * (0.90 - 0.75), 0.2 + f * (0.25 - 0.2)];
        }
        if (d <= 60) {
            const f = (d - 35) / 25;
            // amarillo → rojo
            return [0.90 + f * (0.90 - 0.90), 0.90 - f * (0.90 - 0.20), 0.25 - f * 0.2];
        }
        const f = (d - 60) / 13; // 60 → 73
        // rojo → gris
        return [0.90 + f * (0.45 - 0.90), 0.20 + f * (0.45 - 0.20), 0.05 + f * (0.45 - 0.05)];
    }

    // ---------------------------------------------------------------- fromDem

    /**
     * Genera un displayMesh {positions Float32Array xyz locales, indices Uint32Array}
     * desde un Dem, con stride entero mínimo tal que 2·(cols/stride)·(rows/stride)
     * <= maxTriangles. Triángulos con algún vértice NaN se excluyen.
     * @param {SimRocas.Dem} dem
     * @param {number} [maxTriangles=750000]
     */
    function displayMeshFromDem(dem, maxTriangles = 750000) {
        if (!dem || !dem.cols || !dem.rows || !dem.heights) {
            throw new Error('TerrainMesh3D.fromDem: dem inválido');
        }
        if (!Number.isInteger(maxTriangles) || maxTriangles < 2) {
            throw new Error('TerrainMesh3D.fromDem: maxTriangles debe ser entero >= 2');
        }
        const cols = dem.cols;
        const rows = dem.rows;
        let stride = 1;
        while (2 * Math.ceil(cols / stride) * Math.ceil(rows / stride) > maxTriangles) {
            stride++;
        }
        // Indices de los nodos muestreados (con stride): grid regular.
        const gi = [];
        for (let i = 0; i < cols; i += stride) { gi.push(i); }
        if (gi[gi.length - 1] !== cols - 1) { gi.push(cols - 1); }
        const gj = [];
        for (let j = 0; j < rows; j += stride) { gj.push(j); }
        if (gj[gj.length - 1] !== rows - 1) { gj.push(rows - 1); }
        const gw = gi.length;

        // Muestrea (o NaN) cada nodo de la subgrilla.
        const gz = new Float64Array(gw * gj.length);
        let anyNaN = false;
        for (let aj = 0; aj < gj.length; aj++) {
            for (let ai = 0; ai < gw; ai++) {
                const zi = dem.heights[gj[aj] * cols + gi[ai]];
                if (!Number.isFinite(zi)) {
                    anyNaN = true;
                    gz[aj * gw + ai] = NaN;
                } else {
                    gz[aj * gw + ai] = zi;
                }
            }
        }

        // Sweep para contar triángulos válidos (cada quad genera 2 si los 4 nodos son finitos).
        let triCount = 0;
        for (let bj = 0; bj < gj.length - 1; bj++) {
            for (let bi = 0; bi < gw - 1; bi++) {
                const z00 = gz[bj * gw + bi];
                const z10 = gz[bj * gw + bi + 1];
                const z01 = gz[(bj + 1) * gw + bi];
                const z11 = gz[(bj + 1) * gw + bi + 1];
                const ok = [z00, z10, z01, z11].every(Number.isFinite);
                if (ok) { triCount += 2; }
            }
        }

        const cs = dem.cellSize;
        const positions = new Float32Array(triCount * 9);
        const indices = new Uint32Array(triCount * 3);
        let posOffset = 0;
        let idxOffset = 0;
        const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
        const pushVertex = function (xi, yi, z) {
            const x = xi * cs;
            const y = yi * cs;
            positions[posOffset++] = x;
            positions[posOffset++] = y;
            positions[posOffset++] = z;
            if (x < bounds.minX) { bounds.minX = x; }
            if (x > bounds.maxX) { bounds.maxX = x; }
            if (y < bounds.minY) { bounds.minY = y; }
            if (y > bounds.maxY) { bounds.maxY = y; }
            if (z < bounds.minZ) { bounds.minZ = z; }
            if (z > bounds.maxZ) { bounds.maxZ = z; }
        };
        // Oriente los quads con y hacia el norte (Winding CCW visto desde +z).
        for (let bj = 0; bj < gj.length - 1; bj++) {
            for (let bi = 0; bi < gw - 1; bi++) {
                const i0 = gi[bi];
                const j0 = gj[bj];
                const i1 = gi[bi + 1];
                const j1 = gj[bj + 1];
                const z00 = gz[bj * gw + bi];
                const z10 = gz[bj * gw + bi + 1];
                const z01 = gz[(bj + 1) * gw + bi];
                const z11 = gz[(bj + 1) * gw + bi + 1];
                if (![z00, z10, z01, z11].every(Number.isFinite)) { continue; }
                // Triángulo A: (i0,j0) -> (i1,j0) -> (i0,j1)
                let base = posOffset / 3;
                pushVertex(i0, j0, z00);
                pushVertex(i1, j0, z10);
                pushVertex(i0, j1, z01);
                indices[idxOffset++] = base;
                indices[idxOffset++] = base + 1;
                indices[idxOffset++] = base + 2;
                // Triángulo B: (i1,j0) -> (i1,j1) -> (i0,j1)
                base = posOffset / 3;
                pushVertex(i1, j0, z10);
                pushVertex(i1, j1, z11);
                pushVertex(i0, j1, z01);
                indices[idxOffset++] = base;
                indices[idxOffset++] = base + 1;
                indices[idxOffset++] = base + 2;
            }
        }
        // Recorta en caso de que el sweep real difiera (defensivo; no debería).
        if (triCount * 9 !== posOffset) {
            const out = { positions: positions.slice(0, posOffset), indices: indices.slice(0, idxOffset), bounds, stride, triangles: posOffset / 9, hasNodata: anyNaN };
            return out;
        }
        return { positions, indices, bounds, stride, triangles: triCount, hasNodata: anyNaN };
    }

    /**
     * Malla de terreno coloreada por vértice. Modo 'elevation' (rampa hipsométrica)
     * o 'slope' (0° verde → 35° amarillo → >60° rojo/gris).
     * Material MeshLambertMaterial con vertexColors.
     */
    class TerrainMesh3D {
        /**
         * Construye un THREE.Mesh a partir de un displayMesh
         * {positions Float32Array xyz locales, indices Uint32Array}.
         * @param {object} displayMesh
         * @param {{colorMode?: 'elevation'|'slope', exaggeration?: number}} [options]
         */
        static build(displayMesh, options = {}) {
            const THREE = globalThis.THREE;
            if (!THREE) { throw new Error('TerrainMesh3D.build: THREE no está disponible'); }
            if (!displayMesh || !(displayMesh.positions instanceof Float32Array) || !(displayMesh.indices instanceof Uint32Array)) {
                throw new Error('TerrainMesh3D.build: displayMesh inválido (se esperaba {positions, indices})');
            }
            const colorMode = options.colorMode === 'slope' ? 'slope' : 'elevation';
            const positions = displayMesh.positions;
            const indices = displayMesh.indices;
            const n = positions.length / 3;
            const colors = new Float32Array(n * 3);

            // Rango de cota y prepares de pendiente por vértice.
            let minZ = Infinity;
            let maxZ = -Infinity;
            for (let v = 0; v < n; v++) {
                const z = positions[v * 3 + 2];
                if (Number.isFinite(z)) {
                    if (z < minZ) { minZ = z; }
                    if (z > maxZ) { maxZ = z; }
                }
            }
            const zRange = (maxZ > minZ) ? (maxZ - minZ) : 1;

            // Normales por triángulo (acumulan en vértices).
            const normals = new Float32Array(n * 3);
            const p = positions;
            for (let t = 0; t < indices.length; t += 3) {
                const a = indices[t] * 3;
                const b = indices[t + 1] * 3;
                const c = indices[t + 2] * 3;
                const ux = p[b] - p[a];
                const uy = p[b + 1] - p[a + 1];
                const uz = p[b + 2] - p[a + 2];
                const vx = p[c] - p[a];
                const vy = p[c + 1] - p[a + 1];
                const vz = p[c + 2] - p[a + 2];
                let nx = uy * vz - uz * vy;
                let ny = uz * vx - ux * vz;
                let nz = ux * vy - uy * vx;
                const len = Math.hypot(nx, ny, nz);
                if (len > 0) { nx /= len; ny /= len; nz /= len; }
                // nz < 0 (culling invertido): invierte la normal para que siempre apunte arriba.
                if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
                for (const vi of [a, b, c]) {
                    normals[vi] += nx;
                    normals[vi + 1] += ny;
                    normals[vi + 2] += nz;
                }
            }
            // Normaliza.
            for (let v = 0; v < n; v++) {
                const x = normals[v * 3];
                const y = normals[v * 3 + 1];
                const z = normals[v * 3 + 2];
                const len = Math.hypot(x, y, z);
                if (len > 0) {
                    normals[v * 3] = x / len;
                    normals[v * 3 + 1] = y / len;
                    normals[v * 3 + 2] = z / len;
                }
            }

            for (let v = 0; v < n; v++) {
                const z = positions[v * 3 + 2];
                let rgb;
                if (colorMode === 'slope') {
                    const slope = slopeDegFromNormal(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
                    rgb = colorForSlope(slope);
                } else {
                    rgb = colorForElevation((z - minZ) / zRange);
                }
                colors[v * 3] = rgb[0];
                colors[v * 3 + 1] = rgb[1];
                colors[v * 3 + 2] = rgb[2];
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            geometry.setIndex(new THREE.BufferAttribute(indices, 1));
            geometry.computeVertexNormals();
            const material = new THREE.MeshLambertMaterial({ vertexColors: true });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.userData.colorMode = colorMode;
            mesh.userData.displayMesh = displayMesh;
            mesh.userData.bounds = displayMesh.bounds || null;
            if (Number.isFinite(options.exaggeration) && options.exaggeration > 0) {
                mesh.scale.z = options.exaggeration;
            }
            return mesh;
        }

        /**
         * Cambia el modo de color de una malla creada con build() (mutando in place
         * el atributo 'color').
         * @param {THREE.Mesh} mesh mesh retornado por TerrainMesh3D.build.
         * @param {'elevation'|'slope'} mode
         */
        static setColorMode(mesh, mode) {
            const THREE = globalThis.THREE;
            if (!THREE) { throw new Error('TerrainMesh3D.setColorMode: THREE no disponible'); }
            if (mode !== 'elevation' && mode !== 'slope') {
                throw new Error("TerrainMesh3D.setColorMode: mode debe ser 'elevation' o 'slope'");
            }
            const geometry = mesh.geometry;
            const positions = geometry.getAttribute('position');
            const colors = geometry.getAttribute('color');
            if (!positions || !colors) {
                throw new Error('TerrainMesh3D.setColorMode: geometría sin position/color');
            }
            const minZ = mesh.userData.bounds && Number.isFinite(mesh.userData.bounds.minZ) ? mesh.userData.bounds.minZ : null;
            const maxZ = mesh.userData.bounds && Number.isFinite(mesh.userData.bounds.maxZ) ? mesh.userData.bounds.maxZ : null;
            const n = positions.count;
            const zRange = maxZ !== null ? Math.max(maxZ - minZ, 1) : 1;
            let localMinZ = null;
            let localMaxZ = null;
            if (minZ === null || maxZ === null) {
                for (let v = 0; v < n; v++) {
                    const z = positions.array[v * 3 + 2];
                    if (Number.isFinite(z)) {
                        if (localMinZ === null || z < localMinZ) { localMinZ = z; }
                        if (localMaxZ === null || z > localMaxZ) { localMaxZ = z; }
                    }
                }
            }
            const lo = minZ !== null ? minZ : localMinZ;
            const hi = maxZ !== null ? maxZ : localMaxZ;
            const rng = (hi > lo) ? (hi - lo) : 1;
            for (let v = 0; v < n; v++) {
                const z = positions.array[v * 3 + 2];
                let p = { x: positions.array[v * 3], y: positions.array[v * 3 + 1], z: z };
                let rgb;
                if (mode === 'slope') {
                    // Usa la normal del atributo 'normal' (calculada por computeVertexNormals()).
                    const nzPos = geometry.getAttribute('normal');
                    const slope = slopeDegFromNormal(nzPos.array[v * 3], nzPos.array[v * 3 + 1], nzPos.array[v * 3 + 2]);
                    rgb = colorForSlope(slope);
                } else {
                    rgb = colorForElevation((z - lo) / rng);
                }
                colors.array[v * 3] = rgb[0];
                colors.array[v * 3 + 1] = rgb[1];
                colors.array[v * 3 + 2] = rgb[2];
            }
            colors.needsUpdate = true;
            mesh.userData.colorMode = mode;
        }

        /**
         * Atajo: displayMesh desde un Dem + THREE.Mesh listo para setTerrain().
         * @param {SimRocas.Dem} dem
         * @param {number} [maxTriangles=750000]
         * @param {{colorMode?: string, exaggeration?: number}} [options]
         */
        static fromDem(dem, maxTriangles = 750000, options = {}) {
            const displayMesh = displayMeshFromDem(dem, maxTriangles);
            return TerrainMesh3D.build(displayMesh, options);
        }

        static get utils() {
            return { slopeDegFromNormal, colorForSlope, colorForElevation, displayMeshFromDem };
        }
    }

    SimRocas.displayMeshFromDem = displayMeshFromDem;
    SimRocas.slopeDegFromNormal = slopeDegFromNormal;
    SimRocas.colorForSlope = colorForSlope;
    SimRocas.colorForElevation = colorForElevation;
    SimRocas.TerrainMesh3D = TerrainMesh3D;
})(globalThis.SimRocas);
