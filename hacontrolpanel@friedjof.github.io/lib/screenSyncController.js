import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SAMPLE_COLS = 6;
const SAMPLE_ROWS = 3;
const DEFAULT_COLOR_DIFF_THRESHOLD = 18;
const DEFAULT_OUTPUT_INTERVAL_MS = 500;
const DEFAULT_HISTORY_SIZE = 4;
const DEFAULT_EMA_TIME = 2.0;
const DEFAULT_SPRING_STIFFNESS = 0.15;
const DEFAULT_SPRING_DAMPING = 0.75;
const CONFIG_KEYS = new Set([
    'screen-sync-enabled',
    'screen-sync-entities',
    'screen-sync-condition',
    'screen-sync-interval',
    'screen-sync-mode',
    'screen-sync-scope',
    'screen-sync-transition',
    'screen-sync-output-interval',
    'screen-sync-threshold',
    'screen-sync-history-size',
    'screen-sync-ema-time',
    'screen-sync-spring-stiffness',
    'screen-sync-spring-damping',
    'browser-bridge-priority',
    'browser-bridge-connected',
]);
const CONNECTION_KEYS = new Set(['ha-url', 'ha-token', 'ha-verify-ssl']);

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric))
        return fallback;
    return Math.max(min, Math.min(max, numeric));
}

function getOutputIntervalMs(settings) {
    return Math.round(clampNumber(
        settings.get_int('screen-sync-output-interval'),
        100,
        2000,
        DEFAULT_OUTPUT_INTERVAL_MS
    ));
}

function getColorDiffThreshold(settings) {
    return Math.round(clampNumber(
        settings.get_int('screen-sync-threshold'),
        0,
        255,
        DEFAULT_COLOR_DIFF_THRESHOLD
    ));
}

function getTransitionHistorySize(settings) {
    return Math.round(clampNumber(
        settings.get_int('screen-sync-history-size'),
        2,
        8,
        DEFAULT_HISTORY_SIZE
    ));
}

function getEmaTransitionTimeSeconds(settings) {
    return clampNumber(
        settings.get_double('screen-sync-ema-time'),
        0.1,
        10,
        DEFAULT_EMA_TIME
    );
}

function getEmaAlpha(settings) {
    const transitionTimeMs = getEmaTransitionTimeSeconds(settings) * 1000;
    return 1 - Math.exp(-getOutputIntervalMs(settings) / transitionTimeMs);
}

function getSpringStiffness(settings) {
    return clampNumber(
        settings.get_double('screen-sync-spring-stiffness'),
        0.01,
        1,
        DEFAULT_SPRING_STIFFNESS
    );
}

function getSpringDamping(settings) {
    return clampNumber(
        settings.get_double('screen-sync-spring-damping'),
        0.05,
        0.99,
        DEFAULT_SPRING_DAMPING
    );
}

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

function getMonitorRectByIndex(index) {
    const monitors = Main.layoutManager.monitors;
    if (!monitors || index < 0 || index >= monitors.length)
        return null;

    const monitor = monitors[index];
    const verticalInset = Math.min(48, Math.max(16, Math.floor(monitor.height * 0.05)));
    const horizontalInset = Math.min(32, Math.max(12, Math.floor(monitor.width * 0.04)));

    return {
        x: monitor.x + horizontalInset,
        y: monitor.y + verticalInset,
        width: Math.max(1, monitor.width - horizontalInset * 2),
        height: Math.max(1, monitor.height - verticalInset * 2),
    };
}

// ─── Transition interpolators ─────────────────────────────────────────────────
//
// Each entry in INTERPOLATORS defines one color-transition mode.
//
// Interface:
//   historySize  {number|function} — how many sampled entries to keep in the ring buffer
//   createState? {function} — returns fresh mutable state (for stateful modes)
//   evaluate(history, now, state, settings) → [R,G,B] | null
//     history  — array of { color: [R,G,B], time: number(ms) }, newest last
//     now      — Date.now() in ms
//     state    — object returned by createState (or {} if absent)
//     settings — current GSettings instance for dynamic parameters
//
// To add a new mode: insert an entry here and add the label to
// TRANSITION_LABELS in prefs/buttonsPage.js. No other files need changing.
//

// Catmull-Rom helpers (used by the catmull-rom interpolator below)
function _crChannel(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
        (-t3 + 2 * t2 - t)      * p0 +
        (3 * t3 - 5 * t2 + 2)   * p1 +
        (-3 * t3 + 4 * t2 + t)  * p2 +
        (t3 - t2)                * p3
    );
}
function _crColor(p0, p1, p2, p3, t) {
    return [
        clampByte(_crChannel(p0[0], p1[0], p2[0], p3[0], t)),
        clampByte(_crChannel(p0[1], p1[1], p2[1], p3[1], t)),
        clampByte(_crChannel(p0[2], p1[2], p2[2], p3[2], t)),
    ];
}

// Common time-based interpolation helper: returns t ∈ [0,1] between the last
// two history entries, clamped to 1 once the newer sample's timestamp is passed.
function _timeFraction(history, now) {
    const n = history.length;
    if (n < 2) return 1;
    const prev = history[n - 2];
    const curr = history[n - 1];
    const span = curr.time - prev.time;
    return span > 0 ? Math.min(1, Math.max(0, (now - prev.time) / span)) : 1;
}

function getInterpolatorHistorySize(interpolator, settings) {
    const configured = typeof interpolator?.historySize === 'function'
        ? interpolator.historySize(settings)
        : interpolator?.historySize;
    return Math.max(1, Math.round(Number(configured) || 1));
}

export const INTERPOLATORS = new Map([

    // ── off ─────────────────────────────────────────────────────────────────
    // No interpolation — returns the latest sampled color immediately.
    ['off', {
        historySize: 1,
        evaluate(history) {
            return history.length ? history[history.length - 1].color : null;
        },
    }],

    // ── linear ──────────────────────────────────────────────────────────────
    // Straight-line interpolation between the previous and current sample.
    // Clean and predictable; can feel mechanical on sharp cuts.
    ['linear', {
        historySize: 2,
        evaluate(history, now) {
            const n = history.length;
            if (n === 0) return null;
            if (n === 1) return history[0].color;
            const t = _timeFraction(history, now);
            const a = history[n - 2].color;
            const b = history[n - 1].color;
            return [
                clampByte(a[0] + t * (b[0] - a[0])),
                clampByte(a[1] + t * (b[1] - a[1])),
                clampByte(a[2] + t * (b[2] - a[2])),
            ];
        },
    }],

    // ── ema ─────────────────────────────────────────────────────────────────
    // Exponential Moving Average — each output tick moves the rendered color
    // ALPHA percent toward the target. α = 1 − e^(−dt/τ), where dt is the
    // configured output interval and τ is the configured transition time.
    // Great for very slow, organic ambient scenes.
    ['ema', {
        historySize: 1,
        createState: () => ({ rendered: null }),
        evaluate(history, _now, state, settings) {
            const target = history.length ? history[history.length - 1].color : null;
            if (!target) return null;
            if (!state.rendered) {
                state.rendered = [...target];
                return state.rendered;
            }
            const alpha = getEmaAlpha(settings);
            state.rendered = state.rendered.map((c, i) =>
                clampByte(c + alpha * (target[i] - c))
            );
            return state.rendered;
        },
    }],

    // ── moving-average ───────────────────────────────────────────────────────
    // Simple arithmetic mean over the last N samples.  Dampens rapid flicker
    // at the cost of a fixed lag of N × sampleInterval / 2.
    ['moving-average', {
        historySize: settings => getTransitionHistorySize(settings),
        evaluate(history) {
            return averageColors(history.map(e => e.color));
        },
    }],

    // ── catmull-rom ──────────────────────────────────────────────────────────
    // Cubic Catmull-Rom spline over the most recent samples. The oldest
    // retained sample shapes the incoming tangent, so a larger history keeps
    // more motion memory and feels smoother but less reactive.
    ['catmull-rom', {
        historySize: settings => getTransitionHistorySize(settings),
        evaluate(history, now) {
            const n = history.length;
            if (n === 0) return null;
            if (n === 1) return history[0].color;
            const t  = _timeFraction(history, now);
            const p1 = history[n - 2].color;
            const p2 = history[n - 1].color;
            const p0 = n >= 3 ? history[0].color : p1;
            const p3 = p2; // phantom: arrive smoothly in the p1→p2 direction
            return _crColor(p0, p1, p2, p3, t);
        },
    }],

    // ── spring ───────────────────────────────────────────────────────────────
    // Spring physics: each channel has momentum that accelerates toward the
    // target and is damped each tick.  Produces a natural elastic feel; a
    // slight overshoot is possible and intentional.
    ['spring', {
        historySize: 1,
        createState: () => ({ rendered: null, velocity: [0, 0, 0] }),
        evaluate(history, _now, state, settings) {
            const target = history.length ? history[history.length - 1].color : null;
            if (!target) return null;
            if (!state.rendered) {
                state.rendered = [...target];
                return state.rendered;
            }
            const stiffness = getSpringStiffness(settings);
            const damping = getSpringDamping(settings);
            state.rendered = state.rendered.map((c, i) => {
                const force  = (target[i] - c) * stiffness;
                state.velocity[i] = state.velocity[i] * damping + force;
                const next   = c + state.velocity[i];
                // Absorb velocity at boundaries to prevent sticking
                if (next < 0 || next > 255) state.velocity[i] = 0;
                return clampByte(next);
            });
            return state.rendered;
        },
    }],
]);

export class ScreenSyncController {
    constructor(settings, haClient) {
        this._settings = settings;
        this._haClient = haClient;
        this._screenshot = new Shell.Screenshot();
        this._sourceId = null;
        this._outputSourceId = null;
        this._settingsChangedId = null;
        this._running = false;
        this._outputRunning = false;
        this._colorHistory = [];
        this._interpolator = this._loadInterpolator();
        this._interpolatorState = this._interpolator.createState?.() ?? {};
        this._lastSentColor = null;
        this._lastError = '';
        this._ytActive = false;
        this._condition = normalizeScreenSyncCondition({});
        this._conditionSatisfied = true;
        this._conditionStateKnown = true;
        this._lastConditionError = '';
        this._liveStateHandler = data => this._handleLiveStateChanged(data);

        this._haClient.connectLive(this._liveStateHandler);

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'screen-sync-identify-request') {
                this._handleIdentifyRequest();
                return;
            }

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
        this._clearIdentifyOverlays();

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

        if (this._outputSourceId) {
            GLib.source_remove(this._outputSourceId);
            this._outputSourceId = null;
        }
    }

    // -------------------------------------------------------------------------
    // Browser Bridge API
    // -------------------------------------------------------------------------

    /**
     * Called by the BrowserBridgeServer when a new video frame color arrives.
     * Pushes the color into the rolling history so the existing output pipeline
     * (interpolation, threshold, throttle) can pick it up.
     *
     * @param {number} r
     * @param {number} g
     * @param {number} b
     */
    pushExternalColor(r, g, b) {
        if (!this._shouldUseBrowserBridge())
            return;

        this._ytActive = true;
        this._colorHistory.push({ color: [r, g, b], time: Date.now() });
        const maxHistory = getInterpolatorHistorySize(this._interpolator, this._settings);
        if (this._colorHistory.length > maxHistory)
            this._colorHistory.splice(0, this._colorHistory.length - maxHistory);
    }

    /**
     * Called by the BrowserBridgeServer when no YouTube tab is active.
     * While the bridge stays connected, monitor sampling remains paused.
     * Fallback to the configured screen source only happens after disconnect.
     */
    setYTInactive() {
        this._ytActive = false;
    }

    // -------------------------------------------------------------------------

    _shouldUseBrowserBridge() {
        return this._settings.get_boolean('browser-bridge-priority') &&
            this._settings.get_boolean('browser-bridge-connected');
    }

    _handleIdentifyRequest() {
        const requestId = this._settings.get_int('screen-sync-identify-request');
        if (requestId <= 0)
            return;

        this._clearIdentifyOverlays();

        const monitors = Main.layoutManager.monitors;
        this._identifyOverlays = [];

        for (let i = 0; i < monitors.length; i++) {
            const overlay = this._createIdentifyOverlay(monitors[i], i + 1);
            Main.uiGroup.add_child(overlay);
            this._identifyOverlays.push(overlay);
            overlay.opacity = 0;
            overlay.ease({
                opacity: 255,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._identifySourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._identifySourceId = null;
            this._fadeOutIdentifyOverlays();
            return GLib.SOURCE_REMOVE;
        });
    }

    _createIdentifyOverlay(monitor, number) {
        const SIZE = 200;
        const container = new St.Widget({
            x: monitor.x + Math.round((monitor.width - SIZE) / 2),
            y: monitor.y + Math.round((monitor.height - SIZE) / 2),
            width: SIZE,
            height: SIZE,
            reactive: false,
        });

        const bin = new St.Bin({
            style_class: 'osd-window',
            x_expand: true,
            y_expand: true,
        });
        container.add_child(bin);

        const label = new St.Label({
            text: String(number),
            style: 'font-size: 96px; font-weight: bold; text-align: center;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bin.set_child(label);

        return container;
    }

    _clearIdentifyOverlays() {
        if (this._identifySourceId) {
            GLib.source_remove(this._identifySourceId);
            this._identifySourceId = null;
        }
        if (this._identifyOverlays) {
            for (const overlay of this._identifyOverlays)
                Main.uiGroup.remove_child(overlay);
            this._identifyOverlays = null;
        }
    }

    _fadeOutIdentifyOverlays() {
        if (!this._identifyOverlays)
            return;
        const overlays = this._identifyOverlays;
        this._identifyOverlays = null;
        for (const overlay of overlays) {
            overlay.ease({
                opacity: 0,
                duration: 400,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => Main.uiGroup.remove_child(overlay),
            });
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

    _loadInterpolator() {
        const key = this._settings.get_string('screen-sync-transition') || 'catmull-rom';
        return INTERPOLATORS.get(key) ?? INTERPOLATORS.get('catmull-rom');
    }

    _restart() {
        if (this._sourceId) {
            GLib.source_remove(this._sourceId);
            this._sourceId = null;
        }

        if (this._outputSourceId) {
            GLib.source_remove(this._outputSourceId);
            this._outputSourceId = null;
        }

        this._interpolator = this._loadInterpolator();
        this._interpolatorState = this._interpolator.createState?.() ?? {};
        this._lastSentColor = null;
        this._colorHistory = [];

        if (!this._shouldRun())
            return;

        const intervalMs = Math.max(500, Math.round(this._settings.get_double('screen-sync-interval') * 1000));
        const outputIntervalMs = getOutputIntervalMs(this._settings);

        // Sampling loop: reads the screen every N seconds and appends to history
        this._sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            void this._tick();
            return GLib.SOURCE_CONTINUE;
        });

        // Output loop: evaluates the active interpolator at the configured cadence and sends to HA
        this._outputSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, outputIntervalMs, () => {
            void this._outputTick();
            return GLib.SOURCE_CONTINUE;
        });

        void this._tick();
    }

    // Sampling tick — runs every N seconds.
    // Reads the screen, computes the color for the configured mode, and appends it
    // to the rolling history used by the transition output loop.
    async _tick() {
        if (this._running || !this._shouldRun())
            return;

        // While the Browser Bridge is prioritised and connected, suppress
        // monitor sampling entirely. Only a real disconnect re-enables the
        // configured screen source.
        if (this._shouldUseBrowserBridge())
            return;

        this._running = true;

        try {
            const colors = await this._sampleColors();
            if (!colors.length || !this._shouldRun())
                return;

            const mode = this._settings.get_string('screen-sync-mode');
            const nextColor = colorForMode(mode, colors);
            if (!nextColor)
                return;

            this._colorHistory.push({ color: nextColor, time: Date.now() });
            const maxHistory = getInterpolatorHistorySize(this._interpolator, this._settings);
            if (this._colorHistory.length > maxHistory)
                this._colorHistory.splice(0, this._colorHistory.length - maxHistory);

        } catch (e) {
            const message = e?.message ?? String(e);
            if (message !== this._lastError) {
                this._lastError = message;
                console.error(`[HAControlPanel] Screen sync sampling failed: ${message}`);
            }
        } finally {
            this._running = false;
        }
    }

    // Output tick — runs every configured output interval.
    // Evaluates the active transition over the color history and sends the
    // interpolated color to Home Assistant when it has changed enough.
    async _outputTick() {
        if (this._outputRunning || !this._shouldRun() || !this._colorHistory.length)
            return;

        this._outputRunning = true;

        try {
            const color = this._interpolator.evaluate(
                this._colorHistory, Date.now(), this._interpolatorState, this._settings
            );
            if (!color || !this._shouldRun())
                return;

            const distance = colorDistance(this._lastSentColor, color);
            if (distance === 0 || distance < getColorDiffThreshold(this._settings))
                return;

            const entities = this._getActiveEntities();
            if (!entities.length)
                return;

            await this._haClient.callService('light', 'turn_on', {
                entity_id: entities,
                rgb_color: color,
            });

            this._lastSentColor = [...color];
            this._lastError = '';
        } catch (e) {
            const message = e?.message ?? String(e);
            if (message !== this._lastError) {
                this._lastError = message;
                console.error(`[HAControlPanel] Screen sync output failed: ${message}`);
            }
        } finally {
            this._outputRunning = false;
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
        const scope = this._settings.get_string('screen-sync-scope');
        let rect;

        if (scope === 'stage') {
            rect = getStageRect();
        } else if (scope.startsWith('monitor-')) {
            const idx = parseInt(scope.slice('monitor-'.length), 10);
            rect = Number.isFinite(idx)
                ? (getMonitorRectByIndex(idx) ?? getPrimaryMonitorRect())
                : getPrimaryMonitorRect();
        } else {
            rect = getPrimaryMonitorRect();
        }

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
