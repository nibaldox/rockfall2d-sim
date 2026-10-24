globalThis.SimRocas = globalThis.SimRocas || {};
(function (SimRocas) {
    'use strict';

    SimRocas.importers = SimRocas.importers || {};

    var DECIMAL_COMMA_RE = /\d,\d/;
    var HEAD_NUM_RE = /^[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?$/;
    var EXTENSIONS = ['.xyz', '.csv', '.txt', '.pts'];
    var INITIAL_CAPACITY = 3 * 8192;

    function lowerName(name) {
        return String(name == null ? '' : name).toLowerCase();
    }

    function hasExtension(name) {
        var lower = lowerName(name);
        for (var i = 0; i < EXTENSIONS.length; i += 1) {
            if (lower.length >= EXTENSIONS[i].length &&
                lower.indexOf(EXTENSIONS[i], lower.length - EXTENSIONS[i].length) !== -1) {
                return true;
            }
        }
        return false;
    }

    function countNumericFields(tokens) {
        var n = 0;
        for (var i = 0; i < tokens.length; i += 1) {
            if (HEAD_NUM_RE.test(tokens[i])) {
                n += 1;
            }
        }
        return n;
    }

    function splitTokens(line, separator) {
        if (separator === ' ') {
            var trimmed = line.trim();
            if (trimmed.length === 0) {
                return [];
            }
            return trimmed.split(/\s+/);
        }
        var parts = line.split(separator);
        for (var i = 0; i < parts.length; i += 1) {
            parts[i] = parts[i].trim();
        }
        return parts;
    }

    function detectSeparator(line) {
        if (line.indexOf(';') !== -1) {
            return ';';
        }
        if (line.indexOf('\t') !== -1) {
            return '\t';
        }
        if (line.indexOf(',') !== -1) {
            return ',';
        }
        if (/\s/.test(line)) {
            return ' ';
        }
        return null;
    }

    function normalizeToIterable(input) {
        if (ArrayBuffer.isView(input)) {
            return singleChunkIterable(input);
        }
        // instanceof no funciona entre realms; byteLength + slice identifica
        // un ArrayBuffer cross-realm de forma fiable.
        if (typeof input === 'object' && input !== null &&
            typeof input.byteLength === 'number' && typeof input.slice === 'function') {
            // Un ArrayBuffer cross-realm sirve igual como opción del
            // constructor de vistas (spec-based, seguro entre realms).
            return singleChunkIterable(new Uint8Array(input, 0, input.byteLength));
        }
        return input;
    }

    async function* singleChunkIterable(view) {
        yield view;
    }

    function isCommentOrEmpty(line) {
        var trimmed = line.trim();
        return trimmed.length === 0 || trimmed.charAt(0) === '#';
    }

    SimRocas.importers.xyz = {
        id: 'xyz',
        extensions: EXTENSIONS,

        detect(name, headBytes) {
            if (hasExtension(name)) {
                return true;
            }
            if (!headBytes || headBytes.length === 0) {
                return false;
            }
            var text = new TextDecoder().decode(headBytes);
            var lines = text.split('\n');
            var checked = 0;
            for (var i = 0; i < lines.length && checked < 5; i += 1) {
                var line = lines[i].trim();
                if (line.length === 0 || line.charAt(0) === '#') {
                    continue;
                }
                checked += 1;
                if (countNumericFields(splitTokens(line, detectSeparator(line) || ' ')) >= 3) {
                    return true;
                }
            }
            return false;
        },

        async parse(input, options = {}, onProgress = null) {
            var columns = options.columns || [0, 1, 2];
            var totalBytes = typeof options.totalBytes === 'number' ? options.totalBytes : 0;
            var decoder = new TextDecoder('utf-8');

            var stats = {
                points: 0,
                skippedLines: 0,
                separator: null,
                decimalComma: false,
                headerSkipped: 0
            };
            var originSet = false;
            var ox = 0;
            var oy = 0;
            var oz = 0;
            var capacity = INITIAL_CAPACITY;
            var positions = new Float32Array(capacity);
            var consumed = 0;

            function ensureCapacity(needed) {
                if (needed <= capacity) {
                    return;
                }
                while (capacity < needed) {
                    capacity *= 2;
                }
                var grown = new Float32Array(capacity);
                grown.set(positions);
                positions = grown;
            }

            function toNumber(token) {
                if (typeof token !== 'string' || token.length === 0) {
                    return NaN;
                }
                var normalized = stats.decimalComma ? token.replace(/,/g, '.') : token;
                return Number(normalized);
            }

            function pushLocalPoint(wx, wy, wz) {
                ensureCapacity(stats.points * 3 + 3);
                var base = stats.points * 3;
                positions[base] = wx - ox;
                positions[base + 1] = wy - oy;
                positions[base + 2] = wz - oz;
                stats.points += 1;
            }

            function setOrigin(wx, wy, wz) {
                ox = Math.floor(wx);
                oy = Math.floor(wy);
                oz = Math.floor(wz);
                originSet = true;
            }

            function processLine(line) {
                if (isCommentOrEmpty(line)) {
                    return;
                }
                if (stats.separator === null) {
                    var detected = detectSeparator(line);
                    if (detected === null) {
                        // Sin separador reconocible: imposible extraer 3 columnas.
                        stats.headerSkipped += 1;
                        return;
                    }
                    stats.separator = detected;
                    if ((detected === ';' || detected === '\t') && DECIMAL_COMMA_RE.test(line)) {
                        stats.decimalComma = true;
                    }
                }
                var tokens = splitTokens(line, stats.separator);
                if (!stats.decimalComma && stats.separator !== ',' &&
                    DECIMAL_COMMA_RE.test(tokens[columns[0]] || '')) {
                    stats.decimalComma = true;
                }
                var wx = toNumber(tokens[columns[0]]);
                if (!isFinite(wx)) {
                    if (originSet) {
                        stats.skippedLines += 1;
                    } else {
                        stats.headerSkipped += 1;
                    }
                    return;
                }
                var wy = toNumber(tokens[columns[1]]);
                var wz = toNumber(tokens[columns[2]]);
                if (!isFinite(wy) || !isFinite(wz)) {
                    stats.skippedLines += 1;
                    return;
                }
                if (!originSet) {
                    setOrigin(wx, wy, wz);
                }
                pushLocalPoint(wx, wy, wz);
            }

            function processTextChunk(text, keepLastPartial) {
                var start = 0;
                while (true) {
                    var nl = text.indexOf('\n', start);
                    if (nl === -1) {
                        if (!keepLastPartial && start < text.length) {
                            processLine(text.substr ? text.substring(start) : text.slice(start));
                        }
                        return keepLastPartial ? text.slice(start) : '';
                    }
                    if (nl > start) {
                        processLine(text.slice(start, nl));
                    } else {
                        processLine('');
                    }
                    start = nl + 1;
                }
            }

            var pending = '';
            try {
                var iterable = normalizeToIterable(input);
                for await (var chunk of iterable) {
                    consumed += chunk.byteLength;
                    var text = decoder.decode(chunk, { stream: true });
                    if (text.length > 0) {
                        pending += text;
                        if (pending.length > 0) {
                            pending = processTextChunk(pending, true);
                        }
                    }
                    if (onProgress && totalBytes > 0) {
                        onProgress(Math.min(consumed / totalBytes, 1));
                    }
                }
            } catch (err) {
                throw new Error('No se pudo leer la entrada XYZ: ' + err.message);
            }

            var tail = decoder.decode();
            if (tail.length > 0) {
                pending += tail;
            }
            if (pending.length > 0) {
                // Última línea sin '\n' final.
                var lastNl = pending.lastIndexOf('\n');
                if (lastNl !== -1) {
                    if (lastNl + 1 < pending.length) {
                        processLine(pending.slice(lastNl + 1));
                    }
                    pending = pending.slice(0, lastNl + 1);
                } else {
                    processLine(pending);
                    pending = '';
                }
            }
            if (onProgress && totalBytes > 0) {
                onProgress(1);
            }

            if (stats.points === 0) {
                throw new Error('El archivo no contiene puntos XYZ válidos.');
            }

            ensureCapacity(stats.points * 3);
            if (positions.length > stats.points * 3) {
                positions = positions.slice(0, stats.points * 3);
            }

            return {
                kind: 'points',
                positions: positions,
                origin: { x: ox, y: oy, z: oz },
                stats: stats
            };
        }
    };
})(globalThis.SimRocas);
