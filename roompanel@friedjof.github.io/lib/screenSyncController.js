import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SAMPLE_COLS = 6;
const SAMPLE_ROWS = 3;
const COLOR_DIFF_THRESHOLD = 18;
const CONFIG_KEYS = new Set([
    'screen-sync-enabled',
    'screen-sync-entities',
    'screen-sync-condition',
    'screen-sync-interval',
    'screen-sync-mode',
    'screen-sync-scope',
]);
const CONNECTION_KEYS = new Set(['ha-url', 'ha-token', 'ha-verify-ssl']);

function normalizeScreenSyncCondition(condition) {
    const operator = ['=', '!=', 'regex'].includes(String(condition?.operator ?? '='))
        ? String(condition?.operator ?? '=')
        : '=';

    return {
        enabled: condition?.enabled !== false,
        entity_id: String(condition?.entity_id ?? '').trim(),
        operator,
        value: condition?.value === undefined || condition?.value === null
            ? ''
            : String(condition.value),
    };
}

function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function normalizeChannel(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric))
        return 0;
    if (numeric <= 1)
        return clampByte(numeric * 255);
    if (numeric > 255)
        return clampByte(numeric / 257);
    return clampByte(numeric);
}

function clampCoord(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function normalizePickedColor(result) {
    const color = Array.isArray(result) ? result[result.length - 1] : result;
    return [
        normalizeChannel(color?.red),
        normalizeChannel(color?.green),
        normalizeChannel(color?.blue),
    ];
}

function colorDistance(a, b) {
    if (!a || !b)
        return Infinity;
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function quantizeKey([red, green, blue]) {
    return `${Math.floor(red / 32)}:${Math.floor(green / 32)}:${Math.floor(blue / 32)}`;
}

function rgbToHsv([red, green, blue]) {
    const r = clampByte(red) / 255;
    const g = clampByte(green) / 255;
    const b = clampByte(blue) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta > 0) {
        if (max === r)
            hue = ((g - b) / delta) % 6;
        else if (max === g)
            hue = (b - r) / delta + 2;
        else
            hue = (r - g) / delta + 4;
        hue *= 60;
        if (hue < 0)
            hue += 360;
    }

    const saturation = max === 0 ? 0 : delta / max;
    const value = max;
    return { hue, saturation, value };
}

function hsvToRgb({ hue, saturation, value }) {
    const c = value * saturation;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = value - c;

    let r1 = 0;
    let g1 = 0;
    let b1 = 0;

    if (hue < 60) {
        r1 = c; g1 = x;
    } else if (hue < 120) {
        r1 = x; g1 = c;
    } else if (hue < 180) {
        g1 = c; b1 = x;
    } else if (hue < 240) {
        g1 = x; b1 = c;
    } else if (hue < 300) {
        r1 = x; b1 = c;
    } else {
        r1 = c; b1 = x;
    }

    return [
        clampByte((r1 + m) * 255),
        clampByte((g1 + m) * 255),
        clampByte((b1 + m) * 255),
    ];
}

function getSaturation(color) {
    return rgbToHsv(color).saturation;
}

function getValue(color) {
    return rgbToHsv(color).value;
}

function boostColor(color, minSaturation, saturationBoost, minValue = 0.28) {
    const hsv = rgbToHsv(color);
    hsv.saturation = Math.max(minSaturation, Math.min(1, hsv.saturation * saturationBoost));
    hsv.value = Math.max(minValue, hsv.value);
    return hsvToRgb(hsv);
}

function averageColors(colors) {
    if (!colors.length)
        return null;

    const sums = colors.reduce((acc, [red, green, blue]) => {
        acc[0] += red;
        acc[1] += green;
        acc[2] += blue;
        return acc;
    }, [0, 0, 0]);

    return sums.map(sum => clampByte(sum / colors.length));
}

function rgbToHex([red, green, blue]) {
    return `#${[red, green, blue]
        .map(channel => clampByte(channel).toString(16).padStart(2, '0'))
        .join('')}`;
}

function dominantColor(colors) {
    if (!colors.length)
        return null;

    const buckets = new Map();
    for (const color of colors) {
        const key = quantizeKey(color);
        const bucket = buckets.get(key) ?? { count: 0, colors: [] };
        bucket.count++;
        bucket.colors.push(color);
        buckets.set(key, bucket);
    }

    const [winner] = [...buckets.values()].sort((a, b) => b.count - a.count);
    return averageColors(winner?.colors ?? colors);
}

function vibrantColor(colors) {
    if (!colors.length)
        return null;

    const buckets = new Map();
    for (const color of colors) {
        const key = quantizeKey(color);
        const saturation = getSaturation(color);
        const value = getValue(color);
        const bucket = buckets.get(key) ?? { score: 0, colors: [] };
        bucket.score += 0.25 + saturation * 2.4 + value * 0.45;
        bucket.colors.push(color);
        buckets.set(key, bucket);
    }

    const [winner] = [...buckets.values()].sort((a, b) => b.score - a.score);
    const base = averageColors(winner?.colors ?? colors);
    return base ? boostColor(base, 0.58, 1.18, 0.34) : null;
}

function accentColor(colors) {
    if (!colors.length)
        return null;

    const ranked = colors
        .map(color => {
            const saturation = getSaturation(color);
            const value = getValue(color);
            const score = saturation * saturation * 3.2 + value * 0.4 - (saturation < 0.16 ? 0.8 : 0);
            return { color, score };
        })
        .sort((a, b) => b.score - a.score);

    if (!ranked.length || ranked[0].score <= 0)
        return vibrantColor(colors);

    const topColors = ranked.slice(0, Math.min(4, ranked.length)).map(entry => entry.color);
    const base = averageColors(topColors);
    return base ? boostColor(base, 0.72, 1.28, 0.40) : null;
}

function backlightColor(colors) {
    if (!colors.length)
        return null;

    const base = dominantColor(colors);
    return base ? boostColor(base, 0.80, 1.60, 0.44) : null;
}

function colorForMode(mode, colors) {
    switch (mode) {
    case 'average':
        return averageColors(colors);
    case 'vibrant':
        return vibrantColor(colors);
    case 'accent':
        return accentColor(colors);
    case 'backlight':
        return backlightColor(colors);
    case 'dominant':
    default:
        return dominantColor(colors);
    }
}

function getStageRect() {
    return {
        x: 0,
        y: 0,
        width: global.stage.width,
        height: global.stage.height,
    };
}

function getPrimaryMonitorRect() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor)
        return getStageRect();

    const verticalInset = Math.min(48, Math.max(16, Math.floor(monitor.height * 0.05)));
    const horizontalInset = Math.min(32, Math.max(12, Math.floor(monitor.width * 0.04)));

    return {
        x: monitor.x + horizontalInset,
        y: monitor.y + verticalInset,
        width: Math.max(1, monitor.width - horizontalInset * 2),
        height: Math.max(1, monitor.height - verticalInset * 2),
    };
}

export class ScreenSyncController {
    constructor(settings, haClient) {
        this._settings = settings;
        this._haClient = haClient;
        this._screenshot = new Shell.Screenshot();
        this._sourceId = null;
        this._settingsChangedId = null;
        this._running = false;
        this._lastSentColor = null;
        this._lastError = '';
        this._condition = normalizeScreenSyncCondition({});
        this._conditionSatisfied = true;
        this._conditionStateKnown = true;
        this._lastConditionError = '';
        this._liveStateHandler = data => this._handleLiveStateChanged(data);

        this._haClient.connectLive(this._liveStateHandler);

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'screen-sync-preview-request') {
                void this._handlePreviewRequest();
                return;
            }

            if (key === 'screen-sync-condition' || CONNECTION_KEYS.has(key)) {
                void this._refreshConditionState();
                return;
            }

            if (CONFIG_KEYS.has(key))
                this._restart();
        });

        void this._refreshConditionState();
    }

    destroy() {
        if (this._liveStateHandler) {
            this._haClient.disconnectLive(this._liveStateHandler);
            this._liveStateHandler = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._sourceId) {
            GLib.source_remove(this._sourceId);
            this._sourceId = null;
        }
    }

    _loadCondition() {
        try {
            return normalizeScreenSyncCondition(
                JSON.parse(this._settings.get_string('screen-sync-condition'))
            );
        } catch {
            return normalizeScreenSyncCondition({});
        }
    }

    _setConditionState(satisfied, known = true) {
        const nextSatisfied = !!satisfied;
        const nextKnown = !!known;
        const changed = this._conditionSatisfied !== nextSatisfied ||
            this._conditionStateKnown !== nextKnown;

        this._conditionSatisfied = nextSatisfied;
        this._conditionStateKnown = nextKnown;
        if (changed)
            this._restart();
    }

    _evaluateConditionValue(actualValue) {
        const actual = String(actualValue ?? '');
        const { operator, value } = this._condition;

        try {
            switch (operator) {
            case '!=':
                this._lastConditionError = '';
                return actual !== value;
            case 'regex':
                this._lastConditionError = '';
                return new RegExp(value).test(actual);
            case '=':
            default:
                this._lastConditionError = '';
                return actual === value;
            }
        } catch (e) {
            const message = e?.message ?? String(e);
            if (message !== this._lastConditionError) {
                this._lastConditionError = message;
                console.error(`[HAControlPanel] Screen sync condition failed: ${message}`);
            }
            return false;
        }
    }

    async _refreshConditionState() {
        this._condition = this._loadCondition();
        this._lastConditionError = '';

        if (!this._condition.enabled || !this._condition.entity_id) {
            this._setConditionState(true, true);
            return;
        }

        this._setConditionState(false, false);
        const expectedEntityId = this._condition.entity_id;

        try {
            const state = await this._haClient.getState(expectedEntityId);
            if (this._condition.entity_id !== expectedEntityId)
                return;

            this._setConditionState(
                this._evaluateConditionValue(state?.state ?? ''),
                true
            );
        } catch (e) {
            if (this._condition.entity_id !== expectedEntityId)
                return;

            const message = e?.message ?? String(e);
            if (message !== this._lastConditionError) {
                this._lastConditionError = message;
                console.error(`[HAControlPanel] Screen sync condition refresh failed: ${message}`);
            }
            this._setConditionState(false, true);
        }
    }

    _handleLiveStateChanged({ entity_id, new_state }) {
        if (!this._condition.enabled || !this._condition.entity_id || entity_id !== this._condition.entity_id)
            return;

        this._setConditionState(
            this._evaluateConditionValue(new_state?.state ?? ''),
            true
        );
    }

    _getActiveEntities() {
        try {
            const configs = JSON.parse(this._settings.get_string('screen-sync-entities'));
            return configs
                .filter(c => c.enabled !== false && c.entity_id?.trim().startsWith('light.'))
                .map(c => c.entity_id.trim());
        } catch {
            return [];
        }
    }

    _shouldRun() {
        return this._settings.get_boolean('screen-sync-enabled') &&
            this._getActiveEntities().length > 0 &&
            (!this._condition.enabled || !this._condition.entity_id || (this._conditionStateKnown && this._conditionSatisfied));
    }

    _restart() {
        if (this._sourceId) {
            GLib.source_remove(this._sourceId);
            this._sourceId = null;
        }

        this._lastSentColor = null;

        if (!this._shouldRun())
            return;

        const intervalMs = Math.max(500, Math.round(this._settings.get_double('screen-sync-interval') * 1000));
        this._sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            void this._tick();
            return GLib.SOURCE_CONTINUE;
        });

        void this._tick();
    }

    async _tick() {
        if (this._running || !this._shouldRun())
            return;

        this._running = true;

        try {
            const colors = await this._sampleColors();
            if (!colors.length)
                return;

            const mode = this._settings.get_string('screen-sync-mode');
            const nextColor = colorForMode(mode, colors);

            if (!nextColor)
                return;

            if (!this._shouldRun())
                return;

            if (colorDistance(this._lastSentColor, nextColor) < COLOR_DIFF_THRESHOLD)
                return;

            const entities = this._getActiveEntities();
            if (!entities.length)
                return;

            await this._haClient.callService('light', 'turn_on', {
                entity_id: entities,
                rgb_color: nextColor,
            });

            this._lastSentColor = nextColor;
            this._lastError = '';
        } catch (e) {
            const message = e?.message ?? String(e);
            if (message !== this._lastError) {
                this._lastError = message;
                console.error(`[HAControlPanel] Screen sync failed: ${message}`);
            }
        } finally {
            this._running = false;
        }
    }

    async _handlePreviewRequest() {
        const requestId = this._settings.get_int('screen-sync-preview-request');
        if (requestId <= 0)
            return;

        try {
            const colors = await this._sampleColors();
            const dominant = colorForMode('dominant', colors);
            const average = colorForMode('average', colors);
            const vibrant = colorForMode('vibrant', colors);
            const accent = colorForMode('accent', colors);
            const backlight = colorForMode('backlight', colors);

            this._settings.set_string('screen-sync-preview-dominant', dominant ? rgbToHex(dominant) : '');
            this._settings.set_string('screen-sync-preview-average', average ? rgbToHex(average) : '');
            this._settings.set_string('screen-sync-preview-vibrant', vibrant ? rgbToHex(vibrant) : '');
            this._settings.set_string('screen-sync-preview-accent', accent ? rgbToHex(accent) : '');
            this._settings.set_string('screen-sync-preview-backlight', backlight ? rgbToHex(backlight) : '');
            this._settings.set_string(
                'screen-sync-preview-error',
                colors.length ? '' : 'No screen samples could be collected.'
            );
        } catch (e) {
            this._settings.set_string('screen-sync-preview-dominant', '');
            this._settings.set_string('screen-sync-preview-average', '');
            this._settings.set_string('screen-sync-preview-vibrant', '');
            this._settings.set_string('screen-sync-preview-accent', '');
            this._settings.set_string('screen-sync-preview-backlight', '');
            this._settings.set_string('screen-sync-preview-error', e?.message ?? String(e));
        } finally {
            this._settings.set_int('screen-sync-preview-response', requestId);
        }
    }

    async _sampleColors() {
        const rect = this._settings.get_string('screen-sync-scope') === 'stage'
            ? getStageRect()
            : getPrimaryMonitorRect();

        if (rect.width <= 0 || rect.height <= 0)
            return [];

        const points = [];
        for (let row = 0; row < SAMPLE_ROWS; row++) {
            for (let col = 0; col < SAMPLE_COLS; col++) {
                points.push({
                    x: clampCoord(
                        rect.x + ((col + 0.5) * rect.width / SAMPLE_COLS),
                        rect.x,
                        rect.x + rect.width - 1
                    ),
                    y: clampCoord(
                        rect.y + ((row + 0.5) * rect.height / SAMPLE_ROWS),
                        rect.y,
                        rect.y + rect.height - 1
                    ),
                });
            }
        }

        const colors = [];
        for (const { x, y } of points) {
            try {
                colors.push(await this._pickColor(x, y));
            } catch {
                // Ignore individual sample failures and continue with the rest.
            }
        }
        return colors;
    }

    _pickColor(x, y) {
        return new Promise((resolve, reject) => {
            try {
                this._screenshot.pick_color(x, y, (_screenshot, result) => {
                    try {
                        resolve(normalizePickedColor(this._screenshot.pick_color_finish(result)));
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }
}
