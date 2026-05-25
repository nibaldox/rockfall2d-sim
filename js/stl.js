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
            
            if (this.isBinary(arrayBuffer)) {
                this.parseBinary(arrayBuffer);
            } else {
                this.parseAscii(arrayBuffer);
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
        }

        /**
         * Parses an ASCII STL file.
         */
        parseAscii(arrayBuffer) {
            const text = new TextDecoder('utf-8').decode(arrayBuffer);
            
            // Extract all vertex statements: vertex X Y Z
            const regex = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;
            let match;
            const vertices = [];
            
            while ((match = regex.exec(text)) !== null) {
                const x = parseFloat(match[1]);
                const y = parseFloat(match[2]);
                const z = parseFloat(match[3]);
                
                vertices.push(x, y, z);
                this.updateBounds(x, y, z);
            }
            
            // Ensure vertices count is multiple of 9 (triangles)
            const count = Math.floor(vertices.length / 9) * 9;
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

            // Loop through all triangles
            for (let i = 0; i < numTriangles; i++) {
                const idx = i * 9;
                
                // Get 3D vertices
                const v1x = triangles[idx];
                const v1y = triangles[idx + 1];
                const v1z = triangles[idx + 2];
                
                const v2x = triangles[idx + 3];
                const v2y = triangles[idx + 4];
                const v2z = triangles[idx + 5];
                
                const v3x = triangles[idx + 6];
                const v3y = triangles[idx + 7];
                const v3z = triangles[idx + 8];
                
                // Inlined coordinate mapping to avoid object allocation GC sweeps
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
                
                // Intersect cutting segment AB with the three edges of the projected 2D triangle
                const triIntersections = [];
                
                this.intersectSegments(x1, y1, dx_ab, dy_ab, p1x, p1y, p2x, p2y, p1z, p2z, segLength, triIntersections);
                this.intersectSegments(x1, y1, dx_ab, dy_ab, p2x, p2y, p3x, p3y, p2z, p3z, segLength, triIntersections);
                this.intersectSegments(x1, y1, dx_ab, dy_ab, p3x, p3y, p1x, p1y, p3z, p1z, segLength, triIntersections);
                
                // Clean close duplicates within the same triangle (e.g. vertex intersections)
                const uniqueIntersections = [];
                for (let k = 0; k < triIntersections.length; k++) {
                    const pt = triIntersections[k];
                    if (!uniqueIntersections.some(u => Math.abs(u.d - pt.d) < 1e-3)) {
                        uniqueIntersections.push(pt);
                    }
                }
                
                // Add to overall pool
                for (let k = 0; k < uniqueIntersections.length; k++) {
                    intersectionPoints.push(uniqueIntersections[k]);
                }
            }

            if (intersectionPoints.length === 0) return [];
            
            // Compile points into a clean, uniform 2D profile
            return this.compileProfile(intersectionPoints, segLength, targetPoints);
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

    // Attach to namespace
    SimRocas.StlParser = StlParser;
    SimRocas.StlSlicer = StlSlicer;

})(window.SimRocas);
