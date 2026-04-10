import GLib from 'gi://GLib';

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

export function readButtonsConfig(settings) {
    try {
        const parsed = JSON.parse(settings.get_string('buttons-config') || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function settingsToObject(settings) {
    return {
        connection: {
            url: settings.get_string('ha-url'),
            verify_ssl: settings.get_boolean('ha-verify-ssl'),
        },
        panel: {
            color: {
                entity: settings.get_string('color-entity'),
                service: settings.get_string('color-service'),
                attribute: settings.get_string('color-attribute'),
            },
            slider: {
                entity: settings.get_string('slider-entity'),
                service: settings.get_string('slider-service'),
                attribute: settings.get_string('slider-attribute'),
                min: settings.get_double('slider-min'),
                max: settings.get_double('slider-max'),
            },
        },
        buttons: readButtonsConfig(settings),
        backup: {
            auto: settings.get_boolean('auto-yaml-backup'),
            path: getResolvedBackupPath(settings),
        },
    };
}
