/**
 * Semantic validator for the RoomPanel YAML config format.
 *
 * Returns { errors: string[], warnings: string[] }
 * Errors   = things that will definitely break functionality.
 * Warnings = suspicious values that might be intentional.
 */

const VALID_SYNC_MODES  = new Set(['dominant', 'average', 'vibrant', 'accent', 'backlight']);
const VALID_SYNC_SCOPES = new Set(['primary', 'stage']);
const VALID_WIDGET_TYPES = new Set(['value', 'trend', 'gauge']);
const VALID_SPAN        = new Set(['half', 'full']);
const VALID_SEV_COLORS  = new Set(['ok', 'warn', 'alert']);

// ── Small type-check helpers ──────────────────────────────────────────────────

function isString(v) { return typeof v === 'string'; }
function isBool(v)   { return typeof v === 'boolean'; }
function isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function asText(v)   { return v === undefined || v === null ? '' : String(v); }

function isEntityId(v) {
    return isString(v) && /^[a-z_]+\.[a-z0-9_]+$/.test(v);
}

function isServiceId(v) {
    return isString(v) && /^[a-z_]+\.[a-z_0-9]+$/.test(v);
}

/** Plain service name without domain prefix, e.g. "turn_on". */
function isServiceName(v) {
    return isString(v) && /^[a-z_0-9]+$/.test(v);
}

function isHexColor(v) {
    return isString(v) && /^#[0-9a-fA-F]{6}$/.test(v);
}

function isHttpUrl(v) {
    if (!isString(v)) return false;
    const lower = v.toLowerCase();
    return lower.startsWith('http://') || lower.startsWith('https://');
}

function checkRequiredEntityId(path, value, errors, warnings, { prefix = null } = {}) {
    const raw = asText(value);
    const trimmed = raw.trim();

    if (!trimmed) {
        errors.push(`${path} is empty`);
        return;
    }

    if (prefix && !trimmed.startsWith(prefix))
        warnings.push(`${path}: "${raw}" should start with ${prefix}`);

    if (!isEntityId(raw))
        warnings.push(`${path}: "${raw}" does not look like a valid entity_id`);
}

// ── Section validators ────────────────────────────────────────────────────────

function checkConnection(obj, errors, warnings) {
    const c = obj.connection;
    if (!c) { warnings.push('connection section is missing'); return; }

    if (c.url === undefined || c.url === '') {
        errors.push('connection.url is empty — the extension cannot reach Home Assistant');
    } else if (!isHttpUrl(String(c.url))) {
        warnings.push(`connection.url: "${c.url}" does not start with http:// or https://`);
    }

    if (c.verify_ssl !== undefined && !isBool(c.verify_ssl))
        warnings.push('connection.verify_ssl should be a boolean (true/false)');
}

function checkColorPanel(color, errors, warnings) {
    if (!color) return;

    const entities = color.entities ?? [];
    if (!Array.isArray(entities)) {
        errors.push('panel.color.entities must be a list');
    } else {
        if (entities.length > 4)
            warnings.push(`panel.color.entities: at most 4 entities are used, found ${entities.length}`);
        entities.forEach((e, i) =>
            checkRequiredEntityId(`panel.color.entities[${i}]`, e, errors, warnings)
        );
    }

    if (color.service !== undefined && !isServiceId(String(color.service)))
        warnings.push(`panel.color.service: "${color.service}" does not match domain.service pattern`);
}

function checkScreenSync(ss, errors, warnings) {
    if (!ss) return;

    if (ss.enabled !== undefined && !isBool(ss.enabled))
        warnings.push('panel.screen_sync.enabled should be a boolean');

    if (ss.interval !== undefined) {
        const iv = Number(ss.interval);
        if (!Number.isFinite(iv) || iv < 0.5 || iv > 10)
            warnings.push(`panel.screen_sync.interval: ${ss.interval} is outside the valid range 0.5 – 10 s`);
    }

    if (ss.mode !== undefined && !VALID_SYNC_MODES.has(String(ss.mode)))
        errors.push(`panel.screen_sync.mode: "${ss.mode}" is not valid — use one of: ${[...VALID_SYNC_MODES].join(', ')}`);

    if (ss.scope !== undefined && !VALID_SYNC_SCOPES.has(String(ss.scope)))
        errors.push(`panel.screen_sync.scope: "${ss.scope}" is not valid — use one of: ${[...VALID_SYNC_SCOPES].join(', ')}`);

    if (Array.isArray(ss.entities)) {
        ss.entities.forEach((e, i) => {
            const id = typeof e === 'string' ? e : e?.entity_id;
            checkRequiredEntityId(
                `panel.screen_sync.entities[${i}].entity_id`,
                id,
                errors,
                warnings,
                { prefix: 'light.' }
            );
            if (typeof e === 'object' && e !== null && e.enabled !== undefined && !isBool(e.enabled))
                warnings.push(`panel.screen_sync.entities[${i}].enabled should be a boolean`);
        });
    }
}

function checkSlider(slider, errors, warnings) {
    if (!slider) return;
    const entities = slider.entities ?? [];

    if (!Array.isArray(entities)) {
        errors.push('panel.slider.entities must be a list');
        return;
    }

    if (entities.length > 4)
        warnings.push(`panel.slider.entities: at most 4 sliders are shown, found ${entities.length}`);

    entities.forEach((e, i) => {
        const tag = `panel.slider.entities[${i}]`;
        checkRequiredEntityId(`${tag}.entity_id`, e?.entity_id, errors, warnings);
        if (e?.service !== undefined && !isServiceId(String(e.service)))
            warnings.push(`${tag}.service: "${e.service}" does not match domain.service pattern`);

        const min = Number(e?.min ?? 0);
        const max = Number(e?.max ?? 255);
        if (!Number.isFinite(min) || !Number.isFinite(max))
            errors.push(`${tag}: min and max must be numbers`);
        else if (min >= max)
            errors.push(`${tag}: min (${min}) must be less than max (${max})`);
    });
}

function checkButtons(buttons, errors, warnings) {
    if (!buttons) return;
    if (!Array.isArray(buttons)) { errors.push('buttons must be a list'); return; }

    buttons.forEach((b, i) => {
        const name = b?.label || b?.icon || `#${i}`;
        const tag  = `buttons[${i}] (${name})`;

        if (!b?.domain && !b?.service)
            warnings.push(`${tag}: no domain or service specified — the button will not do anything`);

        // Buttons store domain and service as separate fields (e.g. domain:"light", service:"turn_on")
        if (b?.service !== undefined && !isServiceName(String(b.service)))
            warnings.push(`${tag}.service: "${b.service}" is not a valid service name`);

        const entityId = asText(b?.entity_id);
        if (entityId.trim() && !isEntityId(entityId))
            warnings.push(`${tag}.entity_id: "${b.entity_id}" does not look like a valid entity_id`);

        if (b?.color !== undefined && !isHexColor(String(b.color)))
            warnings.push(`${tag}.color: "${b.color}" is not a valid #rrggbb hex color`);
    });
}

function checkSensors(sensors, errors, warnings) {
    if (!sensors) return;
    if (!Array.isArray(sensors)) { errors.push('sensors must be a list'); return; }

    sensors.forEach((s, i) => {
        const entityId = asText(s?.entity_id);
        const tag = `sensors[${i}] (${entityId.trim() || 'no entity'})`;

        checkRequiredEntityId(`sensors[${i}].entity_id`, entityId, errors, warnings);

        const wt = String(s?.widget_type ?? 'value');
        if (!VALID_WIDGET_TYPES.has(wt))
            errors.push(`${tag}.widget_type: "${wt}" is not valid — use one of: ${[...VALID_WIDGET_TYPES].join(', ')}`);

        if (s?.span !== undefined && !VALID_SPAN.has(String(s.span)))
            warnings.push(`${tag}.span: "${s.span}" should be "half" or "full"`);

        if (wt === 'gauge') {
            const min = Number(s?.min ?? 0);
            const max = Number(s?.max ?? 100);
            if (!Number.isFinite(min) || !Number.isFinite(max))
                errors.push(`${tag}: gauge min and max must be numbers`);
            else if (min >= max)
                errors.push(`${tag}: gauge min (${min}) must be less than max (${max})`);

            if (Array.isArray(s?.severity)) {
                let prevTo = null;
                s.severity.forEach((z, j) => {
                    const ztag = `${tag}.severity[${j}]`;
                    if (!VALID_SEV_COLORS.has(String(z?.color ?? '')))
                        warnings.push(`${ztag}.color: "${z?.color}" should be ok, warn, or alert`);
                    const from = Number(z?.from);
                    const to   = Number(z?.to);
                    if (!Number.isFinite(from) || !Number.isFinite(to))
                        errors.push(`${ztag}: from and to must be numbers`);
                    else if (from >= to)
                        errors.push(`${ztag}: from (${from}) must be less than to (${to})`);
                    else if (prevTo !== null && Math.abs(from - prevTo) > 0.001)
                        warnings.push(`${ztag}: gap or overlap between zones (previous zone ended at ${prevTo}, this starts at ${from})`);
                    prevTo = to;
                });
            }
        }
    });
}

function checkBackup(backup, _errors, warnings) {
    if (!backup) return;
    if (backup.auto !== undefined && !isBool(backup.auto))
        warnings.push('backup.auto should be a boolean');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a parsed RoomPanel config object.
 * @param {object} obj - parsed YAML object
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateConfig(obj) {
    const errors   = [];
    const warnings = [];

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        errors.push('Root value is not a YAML object');
        return { errors, warnings };
    }

    checkConnection(obj, errors, warnings);
    checkColorPanel(obj.panel?.color, errors, warnings);
    checkScreenSync(obj.panel?.screen_sync, errors, warnings);
    checkSlider(obj.panel?.slider, errors, warnings);
    checkButtons(obj.buttons, errors, warnings);
    checkSensors(obj.sensors, errors, warnings);
    checkBackup(obj.backup, errors, warnings);

    return { errors, warnings };
}
