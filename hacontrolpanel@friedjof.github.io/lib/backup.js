import GLib from 'gi://GLib';
import { readButtonsConfig, readSliderConfigs, readSensorWidgets } from './configAdapters.js';

export function getDefaultBackupPath() {
    return GLib.build_filenamev([
        GLib.get_home_dir(),
        '.config',
        'roompanel',
        'backup.yaml',
    ]);
}

export function getResolvedBackupPath(settings) {
    const configuredPath = settings.get_string('yaml-backup-path').trim();
    return configuredPath || getDefaultBackupPath();
}

function getScreenSyncBackupSettings(settings) {
    if (settings.get_string('screen-sync-scope') === 'browser') {
        return {
            scope: 'primary',
            browser_bridge_priority: true,
        };
    }

    return {
        scope: settings.get_string('screen-sync-scope'),
        browser_bridge_priority: settings.get_boolean('browser-bridge-priority'),
    };
}

export function settingsToObject(settings) {
    const screenSyncCondition = (() => {
        try {
            const parsed = JSON.parse(settings.get_string('screen-sync-condition'));
            const enabled = parsed?.enabled !== false;
            const entityId = String(parsed?.entity_id ?? '').trim();
            if (!entityId && enabled)
                return null;

            return {
                ...(enabled ? {} : { enabled: false }),
                entity_id: entityId,
                operator: String(parsed?.operator ?? '='),
                value: parsed?.value === undefined || parsed?.value === null
                    ? ''
                    : String(parsed.value),
            };
        } catch {
            return null;
        }
    })();

    const screenSyncSettings = getScreenSyncBackupSettings(settings);

    return {
        connection: {
            url: settings.get_string('ha-url'),
            verify_ssl: settings.get_boolean('ha-verify-ssl'),
        },
        panel: {
            color: {
                entities: settings.get_strv('color-entities'),
                service: settings.get_string('color-service'),
                attribute: settings.get_string('color-attribute'),
            },
            screen_sync: {
                enabled: settings.get_boolean('screen-sync-enabled'),
                entities: (() => { try { return JSON.parse(settings.get_string('screen-sync-entities')); } catch { return []; } })(),
                ...(screenSyncCondition ? { condition: screenSyncCondition } : {}),
                interval: settings.get_double('screen-sync-interval'),
                mode: settings.get_string('screen-sync-mode'),
                ...screenSyncSettings,
                transition: settings.get_string('screen-sync-transition'),
                output_interval: settings.get_int('screen-sync-output-interval'),
                threshold: settings.get_int('screen-sync-threshold'),
                history_size: settings.get_int('screen-sync-history-size'),
                ema_time: settings.get_double('screen-sync-ema-time'),
                spring_stiffness: settings.get_double('screen-sync-spring-stiffness'),
                spring_damping: settings.get_double('screen-sync-spring-damping'),
            },
            slider: {
                entities: readSliderConfigs(settings),
            },
        },
        buttons: readButtonsConfig(settings),
        sensors: readSensorWidgets(settings),
        backup: {
            auto: settings.get_boolean('auto-yaml-backup'),
            path: getResolvedBackupPath(settings),
        },
    };
}
