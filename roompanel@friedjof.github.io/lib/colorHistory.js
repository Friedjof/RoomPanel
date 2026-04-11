import GLib from 'gi://GLib';

const HISTORY_LIMIT = 8;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getHistoryPath() {
    return GLib.build_filenamev([
        GLib.get_user_state_dir(),
        'roompanel',
        'color-history.json',
    ]);
}

function normalizeHex(color) {
    if (Array.isArray(color) && color.length >= 3) {
        const [red, green, blue] = color;
        return rgbToHex([red, green, blue]);
    }

    const value = String(color ?? '').trim().toLowerCase();
    const match = value.match(/^#?([0-9a-f]{6})$/);
    return match ? `#${match[1]}` : '';
}

function ensureHistoryDirectory() {
    const path = getHistoryPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    return path;
}

export function rgbToHex([red, green, blue]) {
    return `#${clamp(Math.round(red), 0, 255).toString(16).padStart(2, '0')}${clamp(Math.round(green), 0, 255).toString(16).padStart(2, '0')}${clamp(Math.round(blue), 0, 255).toString(16).padStart(2, '0')}`;
}

export function hexToRgb(color) {
    const hex = normalizeHex(color);
    if (!hex)
        return null;

    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
    ];
}

export function loadColorHistory() {
    try {
        const [ok, bytes] = GLib.file_get_contents(getHistoryPath());
        if (!ok)
            return [];

        const text = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
            return [];

        return parsed
            .map(normalizeHex)
            .filter(Boolean)
            .slice(0, HISTORY_LIMIT);
    } catch {
        return [];
    }
}

export function pushColorToHistory(history, color) {
    const hex = normalizeHex(color);
    if (!hex)
        return [...history];

    const remaining = history
        .map(normalizeHex)
        .filter(Boolean)
        .filter(entry => entry !== hex);

    return [hex, ...remaining].slice(0, HISTORY_LIMIT);
}

export function saveColorHistory(history) {
    const nextHistory = history
        .map(normalizeHex)
        .filter(Boolean)
        .slice(0, HISTORY_LIMIT);

    const path = ensureHistoryDirectory();
    const bytes = new TextEncoder().encode(JSON.stringify(nextHistory));
    GLib.file_set_contents(path, bytes);
}
