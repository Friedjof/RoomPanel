import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { HaClient } from './lib/haClient.js';
import { ScreenSyncController } from './lib/screenSyncController.js';
import { BrowserBridgeServer } from './lib/browserBridgeServer.js';
import { RoomPanelIndicator } from './ui/panelIndicator.js';
import { serialize } from './lib/yaml.js';
import { getResolvedBackupPath, settingsToObject } from './lib/backup.js';

export default class RoomPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._haClient = new HaClient();
        this._indicator = null;
        this._screenSyncController = null;
        this._browserBridge = null;
        this._settingsChangedId = null;

        this._applyCredentials();
        this._createIndicator();
        this._createScreenSyncController();
        this._createBrowserBridge();
        this._setupAutoBackup();

        if (this._settings.get_boolean('auto-yaml-backup'))
            this._writeYamlBackup();
    }

    _applyCredentials() {
        this._haClient.setCredentials(
            this._settings.get_string('ha-url'),
            this._settings.get_string('ha-token'),
            this._settings.get_boolean('ha-verify-ssl')
        );
    }

    _createIndicator() {
        this._indicator = new RoomPanelIndicator(
            this._settings, this._haClient, () => void this._openPreferencesSafely()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _createScreenSyncController() {
        this._screenSyncController = new ScreenSyncController(this._settings, this._haClient);
    }

    _createBrowserBridge() {
        this._bridgeColorPreviewTs = 0;
        const port = this._settings.get_int('browser-bridge-port');
        this._browserBridge = new BrowserBridgeServer(port, {
            onColor: (r, g, b) => {
                this._screenSyncController?.pushExternalColor(r, g, b);
                // Update preview color in settings at ~1fps so the prefs dialog can show it
                const now = Date.now();
                if (now - this._bridgeColorPreviewTs >= 1000) {
                    this._bridgeColorPreviewTs = now;
                    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
                    this._settings.set_string('browser-bridge-preview-color', hex);
                }
            },
            onYTInactive: () => this._screenSyncController?.setYTInactive(),
            onTabsChanged: tabs => {
                this._settings.set_string('browser-bridge-tab-list', JSON.stringify(tabs));
            },
            onConnected: connected => {
                this._settings.set_boolean('browser-bridge-connected', connected);
            },
        });

        if (this._settings.get_boolean('browser-bridge-enabled'))
            this._browserBridge.start();
    }

    async _openPreferencesSafely() {
        try {
            await this.openPreferences();
        } catch (e) {
            console.error('[HAControlPanel] Failed to open preferences:', e);
        }
    }

    _setupAutoBackup() {
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            // Re-apply credentials when connection settings change
            if (['ha-url', 'ha-token', 'ha-verify-ssl'].includes(key))
                this._applyCredentials();

            // Browser bridge lifecycle
            if (key === 'browser-bridge-enabled') {
                if (settings.get_boolean('browser-bridge-enabled'))
                    this._browserBridge?.start();
                else
                    this._browserBridge?.stop();
            }

            // Propagate tab selection change to the bridge immediately
            if (key === 'browser-bridge-tab')
                this._browserBridge?.setSelectedTab(settings.get_string('browser-bridge-tab'));

            // Auto-backup
            if (settings.get_boolean('auto-yaml-backup'))
                this._writeYamlBackup();
        });
    }

    _writeYamlBackup() {
        const path = getResolvedBackupPath(this._settings);

        // Ensure parent directory exists
        const dir = GLib.path_get_dirname(path);
        try {
            GLib.mkdir_with_parents(dir, 0o755);
        } catch {
            // Ignore if already exists
        }

        const date = new Date().toISOString().split('T')[0];
        const obj = settingsToObject(this._settings);
        obj.backup.auto = true;
        obj.backup.path = path;

        const yaml = serialize(obj, `HAControlPanel Backup – ${date}`);
        const bytes = new TextEncoder().encode(yaml);

        try {
            GLib.file_set_contents(path, bytes);
        } catch (e) {
            console.error('[HAControlPanel] Auto-backup failed:', e.message);
        }
    }

    disable() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._screenSyncController) {
            this._screenSyncController.destroy();
            this._screenSyncController = null;
        }

        if (this._browserBridge) {
            this._browserBridge.destroy();
            this._browserBridge = null;
        }

        if (this._haClient) {
            this._haClient.destroy();
            this._haClient = null;
        }

        this._settings = null;
    }
}
