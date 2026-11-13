/**
 * SimRocas — retención por banco (P1.2, paquete A).
 *
 * Módulo puro: sin acceso a la página, sin azar y sin estado. La misma
 * entrada produce siempre la misma salida y ninguna función modifica sus
 * argumentos.
 *
 * Marco de bajada: s = downhillSign (+1 o −1) y u = s·x. Los bancos van
 * numerados desde arriba (1…N) y cumplen
 *   u(cresta_1) < u(pata_1) ≤ u(cresta_2) < u(pata_2) …
 *
 * Zonas, por prioridad (intervalos semiabiertos):
 *   upstream   s·(x − releaseX) < 0, con la liberación propia de cada roca
 *   outside    x < profileMinX o x > profileMaxX
 *   platform   u < u(cresta_1)
 *   face:i     u(cresta_i) ≤ u < u(pata_i)
 *   berm:i     u(pata_i) ≤ u < u(cresta_{i+1}), solo para i < N
 *   floor      u ≥ u(pata_N)
 * La cresta pertenece a la cara que nace en ella y la pata a la berma. Con
 * berma de ancho 0 el intervalo queda vacío y la fila se publica en 0.
 *
 * Solo se clasifican las rocas con stopReason === 'rest'. Las censuradas
 * ('culled', 'maxTime', 'maxSteps') se cuentan aparte y nunca en una zona.
 */

globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    const SCHEMA_VERSION = 'bench-retention.v1';
    // Misma tolerancia relativa que el cierre de masa por linaje de Stats (P0.4 B).
    const MASS_TOLERANCE = 1e-9;
    const CENSOR_REASONS = ['culled', 'maxTime', 'maxSteps'];
    const CULL_BOUNDARIES = ['minX', 'maxX', 'minY'];
    const NO_ZONE = { zone: null, bench: null };

    function isFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function fail(reason) {
        return { ok: false, reason };
    }

    /**
     * Valida la geometría y la lleva al marco de bajada.
     * Devuelve { ok, sign, minX, maxX, benches: [{ crestU, toeU }] } o { ok:false, reason }.
     */
    function frame(geometry) {
        if (!geometry || typeof geometry !== 'object') return fail('No hay geometría de bancos.');
        const sign = geometry.downhillSign;
        if (sign !== 1 && sign !== -1) return fail('El sentido de bajada de la geometría de bancos no es válido.');
        const meta = geometry.benchMeta;
        if (!Array.isArray(meta) || meta.length === 0) return fail('La geometría no tiene bancos.');
        const minX = geometry.profileMinX;
        const maxX = geometry.profileMaxX;
        if (!isFiniteNumber(minX) || !isFiniteNumber(maxX) || !(minX < maxX)) {
            return fail('Los extremos del perfil de la geometría de bancos no son válidos.');
        }
        const benches = [];
        for (let i = 0; i < meta.length; i++) {
            const bench = meta[i];
            if (!bench || typeof bench !== 'object' || !isFiniteNumber(bench.crestX) || !isFiniteNumber(bench.toeX)) {
                return fail(`El banco ${i + 1} no tiene cresta y pata con coordenadas finitas.`);
            }
            const crestU = sign * bench.crestX;
            const toeU = sign * bench.toeX;
            if (!(crestU < toeU)) {
                return fail(`En el banco ${i + 1} la cresta no queda antes que la pata en el sentido de bajada.`);
            }
            if (i > 0 && !(benches[i - 1].toeU <= crestU)) {
                return fail(`Los bancos ${i} y ${i + 1} están desordenados o se solapan en el sentido de bajada.`);
            }
            benches.push({ crestU, toeU });
        }
        return { ok: true, sign, minX, maxX, benches };
    }

    function classifyInFrame(x, releaseX, f) {
        if (!isFiniteNumber(x) || !isFiniteNumber(releaseX)) return { ...NO_ZONE };
        if (f.sign * (x - releaseX) < 0) return { zone: 'upstream', bench: null };
        if (x < f.minX || x > f.maxX) return { zone: 'outside', bench: null };
        const u = f.sign * x;
        const benches = f.benches;
        if (u < benches[0].crestU) return { zone: 'platform', bench: null };
        for (let i = 0; i < benches.length; i++) {
            if (u < benches[i].toeU) return { zone: `face:${i + 1}`, bench: i + 1 };
            if (i + 1 < benches.length && u < benches[i + 1].crestU) return { zone: `berm:${i + 1}`, bench: i + 1 };
        }
        return { zone: 'floor', bench: null };
    }

    /**
     * Zona de una posición final en reposo.
     * Devuelve { zone, bench }; ambos son null si la posición, la liberación
     * o la geometría no permiten clasificar.
     */
    function classify(x, releaseX, geometry) {
        const f = frame(geometry);
        if (!f.ok) return { ...NO_ZONE };
        return classifyInFrame(x, releaseX, f);
    }

    function zoneRow(key, label, bench, note) {
        return { key, label, bench, primaries: 0, pieces: 0, mass: 0, note };
    }

    function buildZones(f) {
        const zones = [
            zoneRow('upstream', 'aguas arriba de la fuente', null, null),
            zoneRow('platform', 'plataforma superior', null, null)
        ];
        const count = f.benches.length;
        for (let i = 0; i < count; i++) {
            zones.push(zoneRow(`face:${i + 1}`, `cara banco ${i + 1}`, i + 1, null));
            if (i + 1 < count) {
                const empty = f.benches[i].toeU === f.benches[i + 1].crestU;
                zones.push(zoneRow(`berm:${i + 1}`, `berma banco ${i + 1}`, i + 1, empty ? 'sin berma' : null));
            }
        }
        zones.push(zoneRow('floor', 'piso', null, null));
        zones.push(zoneRow('outside', 'fuera del perfil', null, null));
        return zones;
    }

    function tally() {
        return { primaries: 0, pieces: 0, mass: 0 };
    }

    /**
     * Destino de una roca: { zone, bench } si quedó en reposo, { censored, boundary }
     * si está censurada, o { error } si no se puede contar sin perderla.
     */
    function destination(rock, kind, f) {
        if (!rock || typeof rock !== 'object') return { error: `Hay una ${kind} sin datos.` };
        const reason = rock.stopReason;
        if (reason === 'rest') {
            const where = classifyInFrame(rock.finalX, rock.releaseX, f);
            if (where.zone === null) {
                return { error: `La ${kind} ${rock.id} está en reposo pero no tiene posición final o de liberación finita.` };
            }
            return where;
        }
        if (!CENSOR_REASONS.includes(reason)) {
            return { error: `La ${kind} ${rock.id} tiene un motivo de detención no reconocido.` };
        }
        if (reason === 'culled' && !CULL_BOUNDARIES.includes(rock.cullBoundary)) {
            return { error: `La ${kind} ${rock.id} salió del dominio sin límite informado.` };
        }
        return { censored: reason, boundary: reason === 'culled' ? rock.cullBoundary : null };
    }

    /**
     * Tabla de retención por banco.
     *   primaries[i] = { id, finalX, stopReason, cullBoundary, releaseX }  representante de cada árbol
     *   leaves[i]    = { id, rootId, finalX, stopReason, cullBoundary, releaseX, mass }
     *   geometry     = benchGeometry saneado
     */
    function summarize(input) {
        const { primaries, leaves, discardedMass, releasedMass, geometry } = input || {};
        const f = frame(geometry);
        if (!f.ok) return fail(f.reason);
        if (!Array.isArray(primaries) || !Array.isArray(leaves)) {
            return fail('Faltan las listas de rocas primarias o de piezas finales.');
        }
        if (!isFiniteNumber(discardedMass) || discardedMass < 0 || !isFiniteNumber(releasedMass) || releasedMass < 0) {
            return fail('La masa liberada o la masa descartada no son válidas.');
        }

        const zones = buildZones(f);
        const byKey = new Map(zones.map(z => [z.key, z]));
        const byReason = { culled: tally(), maxTime: tally(), maxSteps: tally() };
        const cullBoundary = { minX: tally(), maxX: tally(), minY: tally() };
        const censored = { byReason, primaries: 0, pieces: 0, mass: 0, cullBoundary };
        const denominators = { released: primaries.length, known: 0, releasedPieces: leaves.length, knownPieces: 0 };

        for (const rock of primaries) {
            const where = destination(rock, 'roca primaria', f);
            if (where.error) return fail(where.error);
            if (where.censored) {
                byReason[where.censored].primaries++;
                if (where.boundary) cullBoundary[where.boundary].primaries++;
                censored.primaries++;
            } else {
                byKey.get(where.zone).primaries++;
                denominators.known++;
            }
        }

        const perLeaf = {};
        const seen = new Set();
        for (const rock of leaves) {
            const where = destination(rock, 'pieza', f);
            if (where.error) return fail(where.error);
            if (!isFiniteNumber(rock.mass) || rock.mass < 0) return fail(`La pieza ${rock.id} no tiene una masa válida.`);
            if (seen.has(rock.id)) return fail(`La pieza ${rock.id} está repetida.`);
            seen.add(rock.id);
            if (where.censored) {
                byReason[where.censored].pieces++;
                byReason[where.censored].mass += rock.mass;
                if (where.boundary) {
                    cullBoundary[where.boundary].pieces++;
                    cullBoundary[where.boundary].mass += rock.mass;
                }
                censored.pieces++;
                censored.mass += rock.mass;
                perLeaf[rock.id] = { ...NO_ZONE };
            } else {
                const row = byKey.get(where.zone);
                row.pieces++;
                row.mass += rock.mass;
                denominators.knownPieces++;
                perLeaf[rock.id] = where;
            }
        }

        // Cierre, recalculado desde la tabla publicada y no desde los contadores de paso.
        const total = key => zones.reduce((sum, z) => sum + z[key], 0);
        const massResidual = releasedMass - (total('mass') + censored.mass + discardedMass);
        const closure = {
            primariesOk: total('primaries') + censored.primaries === primaries.length,
            piecesOk: total('pieces') + censored.pieces === leaves.length,
            massOk: Math.abs(massResidual) <= MASS_TOLERANCE * releasedMass,
            massResidual
        };

        return { ok: true, schemaVersion: SCHEMA_VERSION, zones, censored, denominators, discardedMass, closure, perLeaf };
    }

    SimRocas.BenchRetention = { summarize, classify };
})(globalThis.SimRocas);
