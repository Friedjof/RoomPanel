/**
 * Lightweight YAML serializer/parser for RoomPanel settings backup.
 * Supports: strings, numbers, booleans, null, plain objects, arrays.
 * Does NOT support: anchors, aliases, multi-document, complex types.
 */

// ─── Serializer ────────────────────────────────────────────────────────────

function serializeValue(value, indent) {
    if (value === null || value === undefined)
        return 'null';

    if (typeof value === 'boolean')
        return value ? 'true' : 'false';

    if (typeof value === 'number')
        return String(value);

    if (typeof value === 'string')
        return quoteString(value);

    if (Array.isArray(value))
        return serializeArray(value, indent);

    if (typeof value === 'object')
        return serializeObject(value, indent);

    return quoteString(String(value));
}

function quoteString(str) {
    // Only quote when necessary
    if (str === '' || /[\n\r\t:#\[\]{},&*!|>'"%@`]/.test(str) ||
        /^[\s-]/.test(str) || /\s$/.test(str) ||
        str === 'true' || str === 'false' || str === 'null' ||
        !isNaN(Number(str))) {
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
    }
    return str;
}

function serializeArray(arr, indent) {
    if (arr.length === 0)
        return '[]';

    const pad = ' '.repeat(indent + 2);
    const lines = arr.map(item => {
        const v = serializeValue(item, indent + 2);
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            // Block mapping inside sequence
            const entries = Object.entries(item);
            if (entries.length === 0)
                return `${pad}- {}`;
            const first = entries[0];
            const rest = entries.slice(1);
            let block = `${pad}- ${first[0]}: ${serializeValue(first[1], indent + 4)}`;
            for (const [k, val] of rest)
                block += `\n${pad}  ${k}: ${serializeValue(val, indent + 4)}`;
            return block;
        }
        return `${pad}- ${v}`;
    });
    return '\n' + lines.join('\n');
}

function serializeObject(obj, indent) {
    const entries = Object.entries(obj);
    if (entries.length === 0)
        return '{}';

    const pad = ' '.repeat(indent + 2);
    const lines = entries.map(([k, v]) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            return `${pad}${k}:\n${serializeObject(v, indent + 2)}`;
        }
        if (Array.isArray(v)) {
            const arr = serializeArray(v, indent + 2);
            return `${pad}${k}:${arr}`;
        }
        return `${pad}${k}: ${serializeValue(v, indent + 2)}`;
    });
    return lines.join('\n');
}

/**
 * Serialize a settings object to a YAML string.
 * @param {object} obj - The settings object to serialize
 * @param {string} [comment] - Optional top comment line
 * @returns {string} YAML string
 */
export function serialize(obj, comment = null) {
    const lines = [];
    if (comment)
        lines.push(`# ${comment}`);

    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            lines.push(`${key}:`);
            lines.push(serializeObject(value, 0));
        } else if (Array.isArray(value)) {
            const arr = serializeArray(value, 0);
            lines.push(`${key}:${arr}`);
        } else {
            lines.push(`${key}: ${serializeValue(value, 0)}`);
        }
    }
    return lines.join('\n') + '\n';
}

// ─── Parser ────────────────────────────────────────────────────────────────

/**
 * Parse a YAML string into a JavaScript object.
 * @param {string} text - YAML string
 * @returns {object} Parsed object
 */
export function parse(text) {
    const lines = text.split('\n');
    const root = {};
    parseBlock(lines, 0, 0, root);
    return root;
}

function parseBlock(lines, startLine, baseIndent, target) {
    let i = startLine;
    let currentKey = null;
    let currentIndent = -1;

    while (i < lines.length) {
        const raw = lines[i];
        const trimmed = raw.trimEnd();

        // Skip empty lines and comments
        if (trimmed === '' || trimmed.trimStart().startsWith('#')) {
            i++;
            continue;
        }

        const indent = raw.search(/\S/);

        // Dedent: stop processing this block
        if (indent < baseIndent && baseIndent > 0) {
            break;
        }

        const content = trimmed.trimStart();

        // Array item
        if (content.startsWith('- ')) {
            if (!Array.isArray(target)) {
                // This shouldn't happen in well-formed YAML for our use
                i++;
                continue;
            }
            const itemContent = content.slice(2).trim();
            if (itemContent.includes(': ') && !itemContent.startsWith('"')) {
                // Inline mapping as array item
                const obj = parseInlineMapping(itemContent);
                // Check if next lines continue the mapping
                i++;
                while (i < lines.length) {
                    const nextRaw = lines[i];
                    const nextTrimmed = nextRaw.trimEnd();
                    if (nextTrimmed === '' || nextTrimmed.trimStart().startsWith('#')) {
                        i++;
                        continue;
                    }
                    const nextIndent = nextRaw.search(/\S/);
                    if (nextIndent <= indent)
                        break;
                    const nextContent = nextTrimmed.trimStart();
                    const colonIdx = nextContent.indexOf(': ');
                    if (colonIdx !== -1) {
                        const k = nextContent.slice(0, colonIdx).trim();
                        const v = parseScalar(nextContent.slice(colonIdx + 2).trim());
                        obj[k] = v;
                    }
                    i++;
                }
                target.push(obj);
                continue;
            } else {
                target.push(parseScalar(itemContent));
                i++;
                continue;
            }
        }

        // Key: value pair
        const colonIdx = content.indexOf(': ');
        const colonEnd = content.endsWith(':');

        if (colonIdx !== -1 || colonEnd) {
            const key = colonEnd
                ? content.slice(0, -1).trim()
                : content.slice(0, colonIdx).trim();
            const valueStr = colonEnd ? '' : content.slice(colonIdx + 2).trim();

            if (valueStr === '' || valueStr === null) {
                // Block value follows on next lines
                currentKey = key;
                currentIndent = indent;
                i++;

                // Peek at next non-empty line
                let j = i;
                while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#')))
                    j++;

                if (j < lines.length) {
                    const nextContent = lines[j].trimStart();
                    if (nextContent.startsWith('- ')) {
                        // Array
                        const arr = [];
                        target[key] = arr;
                        i = parseBlock(lines, i, lines[j].search(/\S/), arr);
                    } else {
                        // Nested object
                        const obj = {};
                        target[key] = obj;
                        i = parseBlock(lines, i, lines[j].search(/\S/), obj);
                    }
                }
                continue;
            } else {
                target[key] = parseScalar(valueStr);
                i++;
                continue;
            }
        }

        i++;
    }

    return i;
}

function parseInlineMapping(str) {
    const obj = {};
    const colonIdx = str.indexOf(': ');
    if (colonIdx !== -1) {
        obj[str.slice(0, colonIdx).trim()] = parseScalar(str.slice(colonIdx + 2).trim());
    }
    return obj;
}

function parseScalar(str) {
    if (str === 'null' || str === '~') return null;
    if (str === 'true') return true;
    if (str === 'false') return false;

    // Quoted string
    if ((str.startsWith('"') && str.endsWith('"')) ||
        (str.startsWith("'") && str.endsWith("'"))) {
        return str
            .slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    // Number
    if (!isNaN(str) && str !== '')
        return Number(str);

    return str;
}
