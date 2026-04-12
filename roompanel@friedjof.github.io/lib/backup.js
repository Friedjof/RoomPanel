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

export function settingsToObject(settings) {
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
                entity: settings.get_string('screen-sync-entity'),
                interval: settings.get_double('screen-sync-interval'),
                mode: settings.get_string('screen-sync-mode'),
                scope: settings.get_string('screen-sync-scope'),
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
