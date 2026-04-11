import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { ConnectionPage } from './prefs/connectionPage.js';
import { ButtonsPage } from './prefs/buttonsPage.js';
import { SensorsPage } from './prefs/sensorsPage.js';
import { BackupPage } from './prefs/backupPage.js';

export default class RoomPanelPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Follow the system dark/light theme automatically
        Adw.StyleManager.get_default().color_scheme = Adw.ColorScheme.DEFAULT;

        const settings = this.getSettings();
        window.add(new ConnectionPage(settings));
        window.add(new ButtonsPage(settings));
        window.add(new SensorsPage(settings));
        window.add(new BackupPage(settings));

        window.set_default_size(720, 640);
        window.search_enabled = true;
    }
}
