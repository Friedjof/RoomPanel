import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { RoomPanelMenu } from './panelMenu.js';

/**
 * The 🏠 button in the GNOME top bar.
 * Clicking it opens the RoomPanelMenu dropdown.
 */
export const RoomPanelIndicator = GObject.registerClass(
    class RoomPanelIndicator extends PanelMenu.Button {
        _init(settings, haClient) {
            super._init(0.0, 'RoomPanel');

            this._settings = settings;
            this._haClient = haClient;

            // Panel icon label
            const icon = new St.Label({
                text: '🏠',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 16px; padding: 2px 4px;',
            });
            this.add_child(icon);

            // Build the dropdown content
            this._roomMenu = new RoomPanelMenu(settings, haClient);
            this.menu.addMenuItem(this._roomMenu);
        }

        destroy() {
            this._roomMenu?.destroy();
            super.destroy();
        }
    }
);
