/**
 * Shared utilities for sensor tile rendering.
 */

/** Map HA device_class → GNOME symbolic icon name */
export const DEVICE_CLASS_ICONS = {
    temperature:                 'weather-clear-symbolic',
    humidity:                    'weather-showers-symbolic',
    battery:                     'battery-full-symbolic',
    illuminance:                 'weather-clear-symbolic',
    co2:                         'weather-fog-symbolic',
    carbon_dioxide:              'weather-fog-symbolic',
    volatile_organic_compounds:  'weather-fog-symbolic',
    nitrogen_dioxide:            'weather-fog-symbolic',
    sulphur_dioxide:             'weather-fog-symbolic',
    ozone:                       'weather-fog-symbolic',
    pm25:                        'weather-fog-symbolic',
    pm10:                        'weather-fog-symbolic',
    aqi:                         'weather-fog-symbolic',
    gas:                         'weather-fog-symbolic',
    voltage:                     'battery-caution-symbolic',
    current:                     'battery-caution-symbolic',
    power:                       'power-profile-balanced-symbolic',
    energy:                      'power-profile-balanced-symbolic',
    signal_strength:             'network-wireless-signal-good-symbolic',
    pressure:                    'weather-overcast-symbolic',
    speed:                       'weather-windy-symbolic',
    moisture:                    'weather-showers-symbolic',
    timestamp:                   'appointment-soon-symbolic',
    duration:                    'hourglass-symbolic',
    distance:                    'find-location-symbolic',
};

export const FALLBACK_ICON = 'utilities-system-monitor-symbolic';

/**
 * Extract the raw display value from a HA state object according to widget config.
 * Returns null if state is absent.
 */
export function getStateValue(config, state) {
    if (!state) return null;
    if (config.attribute) {
        const v = state.attributes?.[config.attribute];
        if (v !== undefined && v !== null)
            return v;
    }
    return state.state !== undefined ? state.state : null;
}

/** Extract the value as a finite Number, or null if not numeric. */
export function getNumericValue(config, state) {
    const v = getStateValue(config, state);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function stripTrailingZeros(text) {
    return text
        .replace(/(\.\d*?[1-9])0+$/, '$1')
        .replace(/\.0+$/, '');
}

function getDefaultDecimals(value) {
    const abs = Math.abs(value);

    if (abs >= 100)
        return 0;
    if (abs >= 10)
        return 1;
    if (abs >= 1)
        return 1;
    return 2;
}

/** Format the displayed sensor value without excessive fractional digits. */
export function formatDisplayValue(config, state) {
    const raw = getStateValue(config, state);
    if (raw === null || raw === undefined || raw === '')
        return '—';

    const numeric = Number(raw);
    if (!Number.isFinite(numeric))
        return String(raw);

    const configuredDecimals = Number(config?.decimals);
    const decimals = Number.isInteger(configuredDecimals)
        ? Math.max(0, Math.min(4, configuredDecimals))
        : getDefaultDecimals(numeric);

    return stripTrailingZeros(numeric.toFixed(decimals));
}

/** Unit to display: config override → HA attribute → empty string. */
export function getUnit(config, state) {
    if (config.unit_override != null && config.unit_override !== '')
        return config.unit_override;
    return state?.attributes?.unit_of_measurement ?? '';
}

/** Icon name: config override → device_class map → fallback. */
export function getIcon(config, state) {
    if (config.icon)
        return config.icon;
    const dc = state?.attributes?.device_class;
    return (dc && DEVICE_CLASS_ICONS[dc]) || FALLBACK_ICON;
}

/** Display name: config override → HA friendly_name → formatted entity_id. */
export function getName(config, state) {
    if (config.display_name)
        return config.display_name;
    return state?.attributes?.friendly_name ?? formatEntityId(config.entity_id ?? '');
}

/** "sensor.living_room_temp" → "living room temp" */
export function formatEntityId(entityId) {
    const dot = entityId.indexOf('.');
    return (dot >= 0 ? entityId.slice(dot + 1) : entityId).replace(/_/g, ' ');
}

/**
 * Determine which severity color key applies to a value.
 * @param {Array|null}  severity  [{from, to, color}]
 * @param {number}      value
 * @returns {'ok'|'warn'|'alert'}
 */
export function getSeverityColor(severity, value) {
    if (!Array.isArray(severity) || severity.length === 0)
        return 'ok';
    for (const zone of severity) {
        if (value >= Number(zone.from) && value <= Number(zone.to))
            return zone.color ?? 'ok';
    }
    return 'ok';
}
