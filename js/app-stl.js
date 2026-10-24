/**
 * SimRocas — App: importación de STL y contornos 3D (T0.9).
 * Mixin sobre SimRocas.App.prototype; se carga después de js/app.js.
 */

Object.assign(SimRocas.App.prototype, {
    /**
     * Build heightmap and contour lines from the current STL data.
     * Runs asynchronously with a progress indicator.
     */
    _buildContours(upAxis) {
        if (!this.currentStl || !SimRocas.StlContour) {
            this.renderer.stlHeightmap = null;
            this.renderer.stlContours = [];
            return;
        }

        const bounds = this.currentStl.bounds;
        let hWidth, hHeight;
        if (upAxis === 'Y') {
            hWidth = bounds.maxX - bounds.minX;
            hHeight = bounds.maxZ - bounds.minZ;
        } else {
            hWidth = bounds.maxX - bounds.minX;
            hHeight = bounds.maxY - bounds.minY;
        }

        // Auto-detect contour interval based on terrain size
        const maxDim = Math.max(hWidth, hHeight);
        let interval;
        if (maxDim < 200) interval = 2;
        else if (maxDim < 1000) interval = 5;
        else if (maxDim < 5000) interval = 10;
        else if (maxDim < 20000) interval = 25;
        else interval = 50;

        // Grid resolution proportional to mesh density but capped
        const numTriangles = this.currentStl.triangles.length / 9;
        const gridRes = Math.min(512, Math.max(128, Math.round(Math.sqrt(numTriangles) * 0.3)));

        // Build heightmap (this is the expensive part for large meshes)
        const heightmap = SimRocas.StlContour.buildHeightmap(
            this.currentStl.triangles,
            bounds,
            upAxis,
            gridRes
        );

        // Generate contour lines
        const contours = heightmap
            ? SimRocas.StlContour.generateContours(heightmap, interval)
            : [];

        // Store on renderer
        this.renderer.stlHeightmap = heightmap;
        this.renderer.stlContours = contours;
        this.renderer.stlContourInterval = interval;
    },

    setupStlControls() {
        const importBtn = document.getElementById('btn-import-stl');
        const fileInput = document.getElementById('stl-file-input');
        const upAxisSelect = document.getElementById('stl-up-axis');
        const sliceX1Input = document.getElementById('stl-slice-x1');
        const sliceY1Input = document.getElementById('stl-slice-y1');
        const sliceX2Input = document.getElementById('stl-slice-x2');
        const sliceY2Input = document.getElementById('stl-slice-y2');
        const resolutionInput = document.getElementById('stl-resolution-points');
        const generateBtn = document.getElementById('btn-generate-slice');

        this.stlParser = (SimRocas.StlParser)
            ? new SimRocas.StlParser()
            : null;
        this.currentStl = null;

        if (!this.stlParser) {
            console.warn('StlParser no encontrado — funciones STL deshabilitadas.');
        }

        // Label natively triggers the fileInput click, no JS programmatic click needed.

        // File loading
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (!this.stlParser) {
                alert('Error: StlParser no disponible. Verifique que js/stl.js cargó correctamente.');
                return;
            }
            const reader = new FileReader();
            reader.onerror = () => {
                alert('Error al leer el archivo STL. Intente nuevamente.');
            };
            reader.onload = (event) => {
                try {
                    const arrayBuffer = event.target.result;
                    const stlData = this.stlParser.parse(arrayBuffer);

                    if (!stlData.triangles || stlData.triangles.length === 0) {
                        throw new Error('El archivo STL no contiene triángulos válidos o está vacío.');
                    }

                    this.currentStl = stlData;
                    this.renderer.currentStl = stlData;

                    // Show metadata panel
                    document.getElementById('stl-filename').textContent = file.name;
                    document.getElementById('stl-tri-count').textContent = (stlData.triangles.length / 9).toLocaleString();
                    document.getElementById('stl-bounds-x').textContent = `[${stlData.bounds.minX.toFixed(1)}, ${stlData.bounds.maxX.toFixed(1)}] m`;
                    document.getElementById('stl-bounds-y').textContent = `[${stlData.bounds.minY.toFixed(1)}, ${stlData.bounds.maxY.toFixed(1)}] m`;
                    document.getElementById('stl-bounds-z').textContent = `[${stlData.bounds.minZ.toFixed(1)}, ${stlData.bounds.maxZ.toFixed(1)}] m`;
                    
                    document.getElementById('stl-info').style.display = 'block';
                    document.querySelectorAll('.stl-controls').forEach(el => el.style.display = 'block');
                    document.getElementById('btn-new-section').style.display = 'inline-block';
                    
                    // Set default slice line covering the bounding box horizontally
                    const upAxis = upAxisSelect.value;
                    let minHX, maxHX, minHY, maxHY;
                    if (upAxis === 'Y') {
                        minHX = stlData.bounds.minX;
                        maxHX = stlData.bounds.maxX;
                        minHY = stlData.bounds.minZ;
                        maxHY = stlData.bounds.maxZ;
                    } else {
                        minHX = stlData.bounds.minX;
                        maxHX = stlData.bounds.maxX;
                        minHY = stlData.bounds.minY;
                        maxHY = stlData.bounds.maxY;
                    }
                    
                    const sliceLine = {
                        x1: minHX,
                        y1: (minHY + maxHY) / 2,
                        x2: maxHX,
                        y2: (minHY + maxHY) / 2,
                        active: true
                    };
                    
                    this.renderer.sliceLine = sliceLine;
                    this.renderer.stlUpAxis = upAxis;
                    
                    // Build heightmap + contour lines for plan view
                    this._buildContours(upAxis);
                    
                    // Sync coordinate inputs
                    sliceX1Input.value = Math.round(sliceLine.x1);
                    sliceY1Input.value = Math.round(sliceLine.y1);
                    sliceX2Input.value = Math.round(sliceLine.x2);
                    sliceY2Input.value = Math.round(sliceLine.y2);
                    
                    this.render();
                } catch (err) {
                    alert('Error al parsear el archivo STL: ' + err.message);
                }
            };
            reader.readAsArrayBuffer(file);
        });

        // Eje vertical change
        upAxisSelect.addEventListener('change', () => {
            if (!this.currentStl) return;
            const upAxis = upAxisSelect.value;
            this.renderer.stlUpAxis = upAxis;
            
            // Recalculate default slice line with new horizontal mapping
            let minHX, maxHX, minHY, maxHY;
            if (upAxis === 'Y') {
                minHX = this.currentStl.bounds.minX;
                maxHX = this.currentStl.bounds.maxX;
                minHY = this.currentStl.bounds.minZ;
                maxHY = this.currentStl.bounds.maxZ;
            } else {
                minHX = this.currentStl.bounds.minX;
                maxHX = this.currentStl.bounds.maxX;
                minHY = this.currentStl.bounds.minY;
                maxHY = this.currentStl.bounds.maxY;
            }
            
            const sliceLine = {
                x1: minHX,
                y1: (minHY + maxHY) / 2,
                x2: maxHX,
                y2: (minHY + maxHY) / 2,
                active: true
            };
            
            this.renderer.sliceLine = sliceLine;
            sliceX1Input.value = Math.round(sliceLine.x1);
            sliceY1Input.value = Math.round(sliceLine.y1);
            sliceX2Input.value = Math.round(sliceLine.x2);
            sliceY2Input.value = Math.round(sliceLine.y2);
            
            // Rebuild contours with new axis
            this._buildContours(upAxis);
            
            this.render();
        });

        // Sync inputs back to slice line
        const syncInputsToSliceLine = () => {
            if (!this.currentStl) return;
            this.renderer.sliceLine.x1 = parseFloat(sliceX1Input.value) || 0;
            this.renderer.sliceLine.y1 = parseFloat(sliceY1Input.value) || 0;
            this.renderer.sliceLine.x2 = parseFloat(sliceX2Input.value) || 0;
            this.renderer.sliceLine.y2 = parseFloat(sliceY2Input.value) || 0;
            this.render();
        };

        [sliceX1Input, sliceY1Input, sliceX2Input, sliceY2Input].forEach(inp => {
            inp.addEventListener('input', syncInputsToSliceLine);
        });

        // Generate profile
        generateBtn.addEventListener('click', () => {
            if (!this.currentStl) {
                alert('Por favor, carga un archivo STL primero.');
                return;
            }
            
            const x1 = parseFloat(sliceX1Input.value);
            const y1 = parseFloat(sliceY1Input.value);
            const x2 = parseFloat(sliceX2Input.value);
            const y2 = parseFloat(sliceY2Input.value);
            const upAxis = upAxisSelect.value;
            const resolution = parseInt(resolutionInput.value) || 50;
            
            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
                alert('Coordenadas de corte inválidas.');
                return;
            }
            
            // Show processing indicator
            generateBtn.disabled = true;
            const origText = generateBtn.textContent;
            generateBtn.textContent = '⏳ Procesando...';

            // Use setTimeout to let the UI update before heavy computation
            setTimeout(() => {
                try {
                    const points2D = SimRocas.StlSlicer.slice(
                        this.currentStl.triangles,
                        x1, y1, x2, y2,
                        upAxis,
                        resolution
                    );
                    
                    if (points2D.length === 0) {
                        alert('No se encontraron intersecciones entre la línea de sección y la malla STL. Verifica que tu línea pase por dentro de la topografía.');
                        return;
                    }
                    
                    // Set the new points to active terrain!
                    this.terrain.setPoints(points2D);
                    
                    // Clear current simulation state/rocks
                    this.resetSimulation();
                    
                    // Corrección T3.5/T4.6: colocar el punto de liberación
                    // sobre el terreno del perfil NUEVO (x0 + 2 % de la
                    // longitud; cota + 5 m en caída libre).
                    if (typeof this._syncReleaseAfterProfile === 'function') {
                        this._syncReleaseAfterProfile(points2D);
                    }
                    
                    // Redirect user back to the 2D Terrain tab
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    document.querySelector('[data-tab="terrain"]').classList.add('active');
                    document.getElementById('tab-terrain').classList.add('active');
                    
                    this.renderer.activeTab = 'terrain';
                    
                    // Scale and draw new profile
                    this.renderer.autoScale();
                    this.updateTerrainInfo();
                    this.updateSegmentsList();
                    this.render();
                    
                    alert(`Perfil 2D generado exitosamente con ${points2D.length} puntos. ¡Listo para configurar parámetros y ejecutar la simulación!`);
                } catch (err) {
                    alert('Error al generar perfil: ' + err.message);
                    console.error('STL slice error:', err);
                } finally {
                    generateBtn.disabled = false;
                    generateBtn.textContent = origText;
                }
            }, 50);
        });

        // "Nueva Sección" button — switch back to STL tab to draw a new slice line
        const btnNewSection = document.getElementById('btn-new-section');
        btnNewSection.addEventListener('click', () => {
            if (!this.currentStl) return;

            // Reset slice line to default (centered horizontal)
            const upAxis = upAxisSelect.value;
            const bounds = this.currentStl.bounds;
            let minHX, maxHX, minHY, maxHY;
            if (upAxis === 'Y') {
                minHX = bounds.minX; maxHX = bounds.maxX;
                minHY = bounds.minZ; maxHY = bounds.maxZ;
            } else {
                minHX = bounds.minX; maxHX = bounds.maxX;
                minHY = bounds.minY; maxHY = bounds.maxY;
            }
            const newSlice = {
                x1: minHX,
                y1: (minHY + maxHY) / 2,
                x2: maxHX,
                y2: (minHY + maxHY) / 2,
                active: false
            };
            this.renderer.sliceLine = newSlice;
            sliceX1Input.value = Math.round(newSlice.x1);
            sliceY1Input.value = Math.round(newSlice.y1);
            sliceX2Input.value = Math.round(newSlice.x2);
            sliceY2Input.value = Math.round(newSlice.y2);

            // Switch to STL 3D tab
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('[data-tab="stl3d"]').classList.add('active');
            document.getElementById('tab-stl3d').classList.add('active');
            this.renderer.activeTab = 'stl3d';

            this.render();
        });

        // "Limpiar Línea" button — reset the slice line to default on current STL
        const btnClearSlice = document.getElementById('btn-clear-slice');
        btnClearSlice.addEventListener('click', () => {
            if (!this.currentStl) return;

            const upAxis = upAxisSelect.value;
            const bounds = this.currentStl.bounds;
            let minHX, maxHX, minHY, maxHY;
            if (upAxis === 'Y') {
                minHX = bounds.minX; maxHX = bounds.maxX;
                minHY = bounds.minZ; maxHY = bounds.maxZ;
            } else {
                minHX = bounds.minX; maxHX = bounds.maxX;
                minHY = bounds.minY; maxHY = bounds.maxY;
            }
            const cleared = {
                x1: minHX,
                y1: (minHY + maxHY) / 2,
                x2: maxHX,
                y2: (minHY + maxHY) / 2,
                active: false
            };
            this.renderer.sliceLine = cleared;
            sliceX1Input.value = Math.round(cleared.x1);
            sliceY1Input.value = Math.round(cleared.y1);
            sliceX2Input.value = Math.round(cleared.x2);
            sliceY2Input.value = Math.round(cleared.y2);

            this.render();
        });
    }

});
