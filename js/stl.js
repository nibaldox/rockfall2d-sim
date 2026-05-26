/**
 * SimRocas 2D — STL Import & Slicing Module (2.5D)
 * 
 * This file provides classes to parse STL files (ASCII and Binary)
 * and slice the resulting 3D mesh with a vertical cutting plane
 * to extract a clean, continuous 2D profile.
 */

window.SimRocas = window.SimRocas || {};

(function(SimRocas) {
    'use strict';

    /**
     * StlParser parses ASCII and Binary STL files into a flat Float32Array of vertices.
     */
    class StlParser {
        constructor() {
            this.triangles = null; // Flat array of [v1x, v1y, v1z, v2x, v2y, v2z, v3x, v3y, v3z]
            this.bounds = {
                minX: Infinity, maxX: -Infinity,
                minY: Infinity, maxY: -Infinity,
                minZ: Infinity, maxZ: -Infinity
            };
        }

        /**
         * Parses an STL file from an ArrayBuffer.
         * @param {ArrayBuffer} arrayBuffer 
         * @returns {Object} { triangles, bounds }
         */
        parse(arrayBuffer) {
            this.reset();

            // Guard: empty buffer
            if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                throw new Error('El archivo STL está vacío o no se pudo leer.');
            }

            // Detect format
            const binary = this.isBinary(arrayBuffer);
            if (binary) {
                this.parseBinary(arrayBuffer);
            } else {
                this.parseAscii(arrayBuffer);
            }

            // Fallback: if ASCII yielded 0 triangles but file is large enough to be binary, try binary
            if ((!this.triangles || this.triangles.length === 0) && arrayBuffer.byteLength >= 84) {
                this.reset();
                this.parseBinary(arrayBuffer);
            }

            // Guard: no triangles extracted
            if (!this.triangles || this.triangles.length === 0) {
                throw new Error('No se pudieron extraer triángulos. ¿El archivo está vacío o malformado?');
            }
            return {
                triangles: this.triangles,
                bounds: this.bounds
            };
        }

        reset() {
            this.triangles = null;
            this.bounds = {
                minX: Infinity, maxX: -Infinity,
                minY: Infinity, maxY: -Infinity,
                minZ: Infinity, maxZ: -Infinity
            };
        }

        /**
         * Determines if the ArrayBuffer contains a binary STL.
         */
        isBinary(arrayBuffer) {
            if (arrayBuffer.byteLength < 84) return false;

            // Heuristic: read first 80 bytes as ASCII.
            // ASCII STL files start with "solid" (possibly followed by whitespace or name).
            // Binary STL files have raw binary header — high chance of non-printable chars.
            const headerBytes = new Uint8Array(arrayBuffer, 0, Math.min(80, arrayBuffer.byteLength));
            let hasPrintableAscii = 0;
            let hasNonPrintable = 0;
            for (let i = 0; i < headerBytes.length; i++) {
                const b = headerBytes[i];
                if (b === 32 || b === 9 || b === 10 || b === 13) continue; // whitespace ok
                if (b >= 48 && b <= 122) hasPrintableAscii++; // printable ASCII
                else hasNonPrintable++;
            }

            // If the header has mostly printable ASCII chars, treat as ASCII.
            // This avoids false positives from binary headers that happen to have
            // byte 80-83 as a valid-looking uint32 for a small number of triangles.
            if (hasPrintableAscii >= 10 && hasNonPrintable < 8) return false;

            // Fall back to size-check heuristic
            const reader = new DataView(arrayBuffer);
            const numTriangles = reader.getUint32(80, true);

            // A binary STL file size must be exactly 84 + 50 * numTriangles
            const expectedSize = 84 + 50 * numTriangles;

            // Check if size matches, or if it's very close (some exporters add trailing bytes)
            return Math.abs(arrayBuffer.byteLength - expectedSize) < 100;
        }

        /**
         * Parses a binary STL file.
         */
        parseBinary(arrayBuffer) {
            const reader = new DataView(arrayBuffer);
            const numTriangles = reader.getUint32(80, true);
            
            // Sanity check: cap at 50 million triangles (~1.8GB of data)
            if (numTriangles > 50_000_000) {
                throw new Error(`STL binario con ${numTriangles.toLocaleString()} triángulos — archivo demasiado grande.`);
            }
            
            // 9 floats per triangle (3 vertices x 3 coordinates)
            const triangles = new Float32Array(numTriangles * 9);
            let offset = 84;
            
            for (let i = 0; i < numTriangles; i++) {
                if (offset + 50 > arrayBuffer.byteLength) break;
                
                // Skip normal (12 bytes)
                offset += 12;
                
                const tIdx = i * 9;
                
                // Vertex 1
                const v1x = reader.getFloat32(offset, true);
                const v1y = reader.getFloat32(offset + 4, true);
                const v1z = reader.getFloat32(offset + 8, true);
                offset += 12;
                
                // Vertex 2
                const v2x = reader.getFloat32(offset, true);
                const v2y = reader.getFloat32(offset + 4, true);
                const v2z = reader.getFloat32(offset + 8, true);
                offset += 12;
                
                // Vertex 3
                const v3x = reader.getFloat32(offset, true);
                const v3y = reader.getFloat32(offset + 4, true);
                const v3z = reader.getFloat32(offset + 8, true);
                offset += 12;
                
                // Skip attribute byte count (2 bytes)
                offset += 2;
                
                // Save to flat array
                triangles[tIdx] = v1x;
                triangles[tIdx + 1] = v1y;
                triangles[tIdx + 2] = v1z;
                
                triangles[tIdx + 3] = v2x;
                triangles[tIdx + 4] = v2y;
                triangles[tIdx + 5] = v2z;
                
                triangles[tIdx + 6] = v3x;
                triangles[tIdx + 7] = v3y;
                triangles[tIdx + 8] = v3z;
                
                // Update bounds
                this.updateBounds(v1x, v1y, v1z);
                this.updateBounds(v2x, v2y, v2z);
                this.updateBounds(v3x, v3y, v3z);
            }

            this.triangles = triangles;
            console.log('StlParser.parseBinary: done, triangles array length =', this.triangles.length);
        }

        /**
         * Parses an ASCII STL file.
         */
        parseAscii(arrayBuffer) {
            const text = new TextDecoder('utf-8').decode(arrayBuffer);

            // Normalize European decimal commas: "1,5" → "1.5"
            // Only match commas between digits with no dot already nearby
            // Avoids breaking thousands separators like "1,234.56"
            const normalized = text.replace(/(\d),(\d(?![\d.]))/g, '$1.$2');

            // Extract all vertex statements: vertex X Y Z
            const regex = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;
            let match;
            const vertices = [];

            while ((match = regex.exec(normalized)) !== null) {
                const x = parseFloat(match[1]);
                const y = parseFloat(match[2]);
                const z = parseFloat(match[3]);

                // Skip completely invalid vertices but warn only occasionally
                if (isNaN(x) || isNaN(y) || isNaN(z)) {
                    if (vertices.length < 30) {
                        console.warn('STL: vertex omitido (NaN):', match[0]);
                    }
                    continue;
                }

                vertices.push(x, y, z);
                this.updateBounds(x, y, z);
            }

            // Pad to multiple of 9 (complete triangles)
            if (vertices.length === 0) {
                this.triangles = new Float32Array(0);
                return;
            }

            const count = Math.floor(vertices.length / 9) * 9;
            if (count < vertices.length) {
                console.warn('STL: recortando', vertices.length - count, 'vértices sueltos (no forman triángulo completo)');
            }
            this.triangles = new Float32Array(vertices.slice(0, count));
        }

        updateBounds(x, y, z) {
            if (x < this.bounds.minX) this.bounds.minX = x;
            if (x > this.bounds.maxX) this.bounds.maxX = x;
            if (y < this.bounds.minY) this.bounds.minY = y;
            if (y > this.bounds.maxY) this.bounds.maxY = y;
            if (z < this.bounds.minZ) this.bounds.minZ = z;
            if (z > this.bounds.maxZ) this.bounds.maxZ = z;
        }
    }

    /**
     * StlSlicer calculates intersections between a vertical cutting plane and the 3D STL mesh.
     */
    class StlSlicer {
        /**
         * Intersects a 2D line segment A->B (in horizontal projection) with 3D triangles.
         * @param {Float32Array} triangles Flat array of triangles
         * @param {number} x1 Start point X
         * @param {number} y1 Start point Y
         * @param {number} x2 End point X
         * @param {number} y2 End point Y
         * @param {string} upAxis Axis representing vertical height ('Z' or 'Y')
         * @param {number} targetPoints Target number of 2D points to return for the profile (default 50)
         * @returns {Array} Array of 2D points [ {x, y}, ... ] for Terrain compatibility
         */
        static slice(triangles, x1, y1, x2, y2, upAxis = 'Z', targetPoints = 50) {
            if (!triangles || triangles.length === 0) return [];
            
            const dx_ab = x2 - x1;
            const dy_ab = y2 - y1;
            const segLength = Math.sqrt(dx_ab * dx_ab + dy_ab * dy_ab);
            
            if (segLength < 1e-4) return [];

            const intersectionPoints = [];
            const numTriangles = triangles.length / 9;

            // Pre-filter: compute a bounding band around the slice line.
            // Only test triangles whose projected 2D bounding box overlaps
            // a band of half-width 'bandWidth' around the cutting segment.
            // This reduces work from 660K triangles to typically 5-50K.
            const bandWidth = segLength * 0.05 + 10; // 5% of segment + 10m margin
            // Normal to the slice line (unnormalized is fine for comparison)
            const nx = -dy_ab;
            const ny = dx_ab;
            const invSegLen = 1 / segLength;

            for (let i = 0; i < numTriangles; i++) {
                const idx = i * 9;
                
                // Get 3D vertices and map to horizontal/vertical
                const v1x = triangles[idx];
                const v1y = triangles[idx + 1];
                const v1z = triangles[idx + 2];
                
                const v2x = triangles[idx + 3];
                const v2y = triangles[idx + 4];
                const v2z = triangles[idx + 5];
                
                const v3x = triangles[idx + 6];
                const v3y = triangles[idx + 7];
                const v3z = triangles[idx + 8];
                
                // Map coordinates based on upAxis
                let p1x, p1y, p1z;
                let p2x, p2y, p2z;
                let p3x, p3y, p3z;
                
                if (upAxis === 'Y') {
                    p1x = v1x; p1y = v1z; p1z = v1y;
                    p2x = v2x; p2y = v2z; p2z = v2y;
                    p3x = v3x; p3y = v3z; p3z = v3y;
                } else {
                    p1x = v1x; p1y = v1y; p1z = v1z;
                    p2x = v2x; p2y = v2y; p2z = v2z;
                    p3x = v3x; p3y = v3y; p3z = v3z;
                }

                // Bounding-box band test: skip triangles far from the slice line
                // Distance from point (px,py) to line through (x1,y1)-(x2,y2):
                //   d = |nx*(px-x1) + ny*(py-y1)| * invSegLen
                // We test the triangle's bounding box center for speed.
                const cx = (p1x + p2x + p3x) * 0.333;
                const cy = (p1y + p2y + p3y) * 0.333;
                const dist = Math.abs(nx * (cx - x1) + ny * (cy - y1)) * invSegLen;
                const triRadius = Math.max(
                    Math.abs(p1x - cx), Math.abs(p1y - cy),
                    Math.abs(p2x - cx), Math.abs(p2y - cy),
                    Math.abs(p3x - cx), Math.abs(p3y - cy)
                );
                if (dist - triRadius > bandWidth) continue;

                // Also skip if triangle is entirely before or after the segment endpoints
                const tCenter = ((cx - x1) * dx_ab + (cy - y1) * dy_ab) / (segLength * segLength);
                const tSpan = triRadius * invSegLen;
                if (tCenter + tSpan < -0.05 || tCenter - tSpan > 1.05) continue;
                
                // Triangle is near the slice line — compute exact intersections
                this.intersectSegments(x1, y1, dx_ab, dy_ab, p1x, p1y, p2x, p2y, p1z, p2z, segLength, intersectionPoints);
                this.intersectSegments(x1, y1, dx_ab, dy_ab, p2x, p2y, p3x, p3y, p2z, p3z, segLength, intersectionPoints);
                this.intersectSegments(x1, y1, dx_ab, dy_ab, p3x, p3y, p1x, p1y, p3z, p1z, segLength, intersectionPoints);
            }

            if (intersectionPoints.length === 0) return [];
            
            // Deduplicate close points
            intersectionPoints.sort((a, b) => a.d - b.d);
            const deduped = [intersectionPoints[0]];
            for (let k = 1; k < intersectionPoints.length; k++) {
                if (Math.abs(intersectionPoints[k].d - deduped[deduped.length - 1].d) > 1e-3) {
                    deduped.push(intersectionPoints[k]);
                }
            }
            
            // Compile points into a clean, uniform 2D profile
            return this.compileProfile(deduped, segLength, targetPoints);
        }

        /**
         * Calculates intersection between segment AB and edge CD.
         * Appends { d, z } to the list if they intersect.
         * dx_ab and dy_ab are passed directly to avoid million-fold redundant subtractions.
         */
        static intersectSegments(ax, ay, dx_ab, dy_ab, cx, cy, dx, dy, cz, dz, abLength, results) {
            const dx_cd = dx - cx;
            const dy_cd = dy - cy;
            
            const denom = dx_ab * dy_cd - dy_ab * dx_cd;
            
            // Parallel segments
            if (Math.abs(denom) < 1e-8) return;
            
            const t = ((cx - ax) * dy_cd - (cy - ay) * dx_cd) / denom;
            const u = ((cx - ax) * dy_ab - (cy - ay) * dx_ab) / denom;
            
            // Check if intersection lies inside both segments
            if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
                results.push({ 
                    d: t * abLength, // Distance along cutting line
                    z: cz + u * (dz - cz) // Interpolated height
                });
            }
        }

        /**
         * Compiles raw intersection points into a clean, ordered, simplified 2D profile
         * using an optimized O(N + M) single-pass sliding window horizontal binning sweep.
         * Completely eliminates nested .filter() loop arrays and Map/GC allocation sweeps.
         */
        static compileProfile(rawPoints, maxLength, targetPoints = 50) {
            // Sort raw points by distance d
            rawPoints.sort((a, b) => a.d - b.d);
            
            const points2D = [];
            const binWidth = maxLength / (targetPoints - 1);
            let rawIdx = 0;
            const nRaw = rawPoints.length;
            
            // Horizontal binning to compile single-valued z = f(d) profile
            for (let i = 0; i < targetPoints; i++) {
                const targetD = i * binWidth;
                const binMin = targetD - binWidth * 0.5;
                const binMax = targetD + binWidth * 0.5;
                
                let maxZ = -Infinity;
                let found = false;
                
                // Fast sorted sweep: advance pointer past points left of bin
                while (rawIdx < nRaw && rawPoints[rawIdx].d < binMin) {
                    rawIdx++;
                }
                
                // Scan points inside the current bin range
                let scanIdx = rawIdx;
                while (scanIdx < nRaw && rawPoints[scanIdx].d <= binMax) {
                    const z = rawPoints[scanIdx].z;
                    if (z > maxZ) {
                        maxZ = z;
                        found = true;
                    }
                    scanIdx++;
                }
                
                let zVal = 0;
                
                if (found) {
                    // Geotechnical safety: use the MAXIMUM height in the bin
                    zVal = maxZ;
                } else {
                    // Empty bin interpolation using closest boundaries
                    const leftPt = rawPoints[rawIdx - 1] || null;
                    const rightPt = rawPoints[rawIdx] || null;
                    
                    if (leftPt && rightPt) {
                        // Linear interpolation
                        const fraction = (targetD - leftPt.d) / (rightPt.d - leftPt.d);
                        zVal = leftPt.z + fraction * (rightPt.z - leftPt.z);
                    } else if (leftPt) {
                        zVal = leftPt.z;
                    } else if (rightPt) {
                        zVal = rightPt.z;
                    } else {
                        zVal = 0;
                    }
                }
                
                // Add to profile, using 'd' as horizontal X and 'zVal' as vertical Y
                points2D.push({ x: targetD, y: zVal });
            }
            
            // Adjust X coordinates to start at exactly 0.0
            const xOffset = points2D[0].x;
            for (let i = 0; i < points2D.length; i++) {
                points2D[i].x -= xOffset;
            }
            
            return points2D;
        }
    }

    /**
     * StlContour generates contour lines (isolines) from an STL mesh
     * using a heightmap grid approach + marching squares.
     * Designed for large meshes (500K+ triangles) — builds grid once,
     * then contour extraction is O(gridW * gridH) per level.
     */
    class StlContour {
        /**
         * Build a heightmap grid from the STL triangle mesh.
         * @param {Float32Array} triangles - Flat array of triangle vertices
         * @param {Object} bounds - { minX, maxX, minY, maxY, minZ, maxZ }
         * @param {string} upAxis - 'Z' or 'Y'
         * @param {number} gridRes - Grid resolution (default 256 cells per axis)
         * @returns {Object} { heights: Float32Array, cols, rows, cellW, cellH, minHX, minHY }
         */
        static buildHeightmap(triangles, bounds, upAxis = 'Z', gridRes = 256) {
            if (!triangles || triangles.length === 0) return null;

            let minHX, maxHX, minHY, maxHY;
            if (upAxis === 'Y') {
                minHX = bounds.minX; maxHX = bounds.maxX;
                minHY = bounds.minZ; maxHY = bounds.maxZ;
            } else {
                minHX = bounds.minX; maxHX = bounds.maxX;
                minHY = bounds.minY; maxHY = bounds.maxY;
            }

            const hWidth = maxHX - minHX;
            const hHeight = maxHY - minHY;
            const cols = gridRes;
            const rows = Math.max(1, Math.round(gridRes * (hHeight / (hWidth || 1))));
            const cellW = hWidth / cols;
            const cellH = hHeight / rows;

            // Initialize height grid with -Infinity (no data)
            const heights = new Float32Array(cols * rows);
            heights.fill(-1e30);

            // Rasterize each triangle into the height grid
            const numTriangles = triangles.length / 9;
            for (let i = 0; i < numTriangles; i++) {
                const idx = i * 9;
                // Map 3D vertices to horizontal + vertical
                let p1hx, p1hy, p1v, p2hx, p2hy, p2v, p3hx, p3hy, p3v;
                if (upAxis === 'Y') {
                    p1hx = triangles[idx];     p1hy = triangles[idx + 2]; p1v = triangles[idx + 1];
                    p2hx = triangles[idx + 3]; p2hy = triangles[idx + 5]; p2v = triangles[idx + 4];
                    p3hx = triangles[idx + 6]; p3hy = triangles[idx + 8]; p3v = triangles[idx + 7];
                } else {
                    p1hx = triangles[idx];     p1hy = triangles[idx + 1]; p1v = triangles[idx + 2];
                    p2hx = triangles[idx + 3]; p2hy = triangles[idx + 4]; p2v = triangles[idx + 5];
                    p3hx = triangles[idx + 6]; p3hy = triangles[idx + 7]; p3v = triangles[idx + 8];
                }

                // Compute bounding box of this triangle in grid cells
                const triMinC = Math.max(0, Math.floor((Math.min(p1hx, p2hx, p3hx) - minHX) / cellW) - 1);
                const triMaxC = Math.min(cols - 1, Math.ceil((Math.max(p1hx, p2hx, p3hx) - minHX) / cellW) + 1);
                const triMinR = Math.max(0, Math.floor((Math.min(p1hy, p2hy, p3hy) - minHY) / cellH) - 1);
                const triMaxR = Math.min(rows - 1, Math.ceil((Math.max(p1hy, p2hy, p3hy) - minHY) / cellH) + 1);

                // For each grid cell in the triangle's bounding box, compute max height
                for (let r = triMinR; r <= triMaxR; r++) {
                    for (let c = triMinC; c <= triMaxC; c++) {
                        const gcx = minHX + (c + 0.5) * cellW;
                        const gcy = minHY + (r + 0.5) * cellH;
                        const h = StlContour._interpolateHeight(
                            p1hx, p1hy, p1v,
                            p2hx, p2hy, p2v,
                            p3hx, p3hy, p3v,
                            gcx, gcy
                        );
                        if (h !== null) {
                            const gi = r * cols + c;
                            if (h > heights[gi]) heights[gi] = h;
                        }
                    }
                }
            }

            return { heights, cols, rows, cellW, cellH, minHX, minHY };
        }

        /**
         * Interpolate height at point (px, py) within triangle using barycentric coords.
         * Returns null if point is outside the triangle.
         */
        static _interpolateHeight(ax, ay, av, bx, by, bv, cx, cy, cv, px, py) {
            const v0x = bx - ax, v0y = by - ay;
            const v1x = cx - ax, v1y = cy - ay;
            const v2x = px - ax, v2y = py - ay;
            const d00 = v0x * v0x + v0y * v0y;
            const d01 = v0x * v1x + v0y * v1y;
            const d11 = v1x * v1x + v1y * v1y;
            const d20 = v2x * v0x + v2y * v0y;
            const d21 = v2x * v1x + v2y * v1y;
            const denom = d00 * d11 - d01 * d01;
            if (Math.abs(denom) < 1e-12) return null;
            const inv = 1 / denom;
            const u = (d11 * d20 - d01 * d21) * inv;
            const v = (d00 * d21 - d01 * d20) * inv;
            if (u >= -0.01 && v >= -0.01 && (u + v) <= 1.01) {
                return av + u * (bv - av) + v * (cv - av);
            }
            return null;
        }

        /**
         * Extract contour line segments for a given height level using marching squares.
         * @param {Object} heightmap - From buildHeightmap()
         * @param {number} level - Height value for the contour
         * @returns {Array} Array of line segments [[x1,y1,x2,y2], ...]
         */
        static extractContour(heightmap, level) {
            const { heights, cols, rows, cellW, cellH, minHX, minHY } = heightmap;
            const segments = [];

            for (let r = 0; r < rows - 1; r++) {
                for (let c = 0; c < cols - 1; c++) {
                    const i00 = r * cols + c;
                    const i10 = r * cols + c + 1;
                    const i01 = (r + 1) * cols + c;
                    const i11 = (r + 1) * cols + c + 1;

                    const h00 = heights[i00];
                    const h10 = heights[i10];
                    const h01 = heights[i01];
                    const h11 = heights[i11];

                    // Skip cells with no data
                    if (h00 < -1e20 && h10 < -1e20 && h01 < -1e20 && h11 < -1e20) continue;

                    // Marching squares: classify 4 corners as above/below
                    const b00 = h00 >= level ? 1 : 0;
                    const b10 = h10 >= level ? 1 : 0;
                    const b01 = h01 >= level ? 1 : 0;
                    const b11 = h11 >= level ? 1 : 0;
                    const code = b00 | (b10 << 1) | (b01 << 2) | (b11 << 3);

                    if (code === 0 || code === 15) continue; // All same side

                    // Interpolate edge crossings
                    const x0 = minHX + c * cellW;
                    const y0 = minHY + r * cellH;
                    const x1 = x0 + cellW;
                    const y1 = y0 + cellH;

                    const interp = (ha, hb, va, vb) => {
                        const d = hb - ha;
                        if (Math.abs(d) < 1e-12) return 0.5;
                        return (level - ha) / d;
                    };

                    // Edge midpoints (interpolated)
                    const top =    { x: x0 + interp(h00, h10) * cellW, y: y0 };      // edge 0-1
                    const bottom = { x: x0 + interp(h01, h11) * cellW, y: y1 };      // edge 2-3
                    const left =   { x: x0, y: y0 + interp(h00, h01) * cellH };      // edge 0-2
                    const right =  { x: x1, y: y0 + interp(h10, h11) * cellH };      // edge 1-3

                    // Connect edges based on marching squares case
                    const addSeg = (p1, p2) => segments.push([p1.x, p1.y, p2.x, p2.y]);

                    switch (code) {
                        case 1:  addSeg(left, top); break;
                        case 2:  addSeg(top, right); break;
                        case 3:  addSeg(left, right); break;
                        case 4:  addSeg(bottom, left); break;
                        case 5:  addSeg(top, bottom); break; // saddle
                        case 6:  addSeg(top, bottom); break; // saddle — simplified
                        case 7:  addSeg(bottom, right); break;
                        case 8:  addSeg(right, bottom); break;
                        case 9:  addSeg(left, bottom); break; // saddle
                        case 10: addSeg(right, top); break;   // saddle — simplified
                        case 11: addSeg(right, left); break;
                        case 12: addSeg(right, left); break;
                        case 13: addSeg(top, left); break;
                        case 14: addSeg(left, top); break;
                    }
                }
            }
            return segments;
        }

        /**
         * Generate multiple contour levels from a heightmap.
         * @param {Object} heightmap - From buildHeightmap()
         * @param {number} interval - Height interval between contour lines (in same units as STL)
         * @returns {Array} Array of { level, segments }
         */
        static generateContours(heightmap, interval) {
            if (!heightmap) return [];

            const { heights } = heightmap;
            // Find actual min/max from the height data
            let hMin = Infinity, hMax = -Infinity;
            for (let i = 0; i < heights.length; i++) {
                if (heights[i] > -1e20) {
                    if (heights[i] < hMin) hMin = heights[i];
                    if (heights[i] > hMax) hMax = heights[i];
                }
            }

            if (hMin === Infinity) return [];

            const contours = [];
            const firstLevel = Math.ceil(hMin / interval) * interval;
            for (let level = firstLevel; level <= hMax; level += interval) {
                const segments = StlContour.extractContour(heightmap, level);
                if (segments.length > 0) {
                    contours.push({ level, segments });
                }
            }
            return contours;
        }
    }

    // Attach to namespace
    SimRocas.StlParser = StlParser;
    SimRocas.StlSlicer = StlSlicer;
    SimRocas.StlContour = StlContour;

})(window.SimRocas);
