import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { HaClient } from '../lib/haClient.js';
import { haDataStore } from './haDataStore.js';

export const ConnectionPage = GObject.registerClass(
    class ConnectionPage extends Adw.PreferencesPage {
        _init(settings) {
            super._init({
                title: 'Connection',
                icon_name: 'network-server-symbolic',
                name: 'connection',
            });

            this._settings = settings;
            this._haDataChangedId = haDataStore.connect('changed', () => this._updateLoadUI());

            // ── Group: Home Assistant ───────────────────────────────────
            const group = new Adw.PreferencesGroup({
                title: 'Home Assistant',
                description: 'Configure your Home Assistant instance',
            });
            this.add(group);

            this._urlRow = new Adw.EntryRow({
                title: 'URL',
                text: settings.get_string('ha-url'),
            });
            group.add(this._urlRow);

            this._tokenRow = new Adw.PasswordEntryRow({
                title: 'Long-Lived Access Token',
                text: settings.get_string('ha-token'),
            });
            group.add(this._tokenRow);

            this._sslRow = new Adw.SwitchRow({
                title: 'Verify SSL Certificate',
                subtitle: 'Disable for self-signed certificates',
                active: settings.get_boolean('ha-verify-ssl'),
            });
            group.add(this._sslRow);

            // ── Test connection ─────────────────────────────────────────
            const testGroup = new Adw.PreferencesGroup();
            this.add(testGroup);

            const testRow = new Adw.ActionRow();
            testGroup.add(testRow);

            const testBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                hexpand: true,
                valign: Gtk.Align.CENTER,
            });
            testRow.add_suffix(testBox);

            this._testButton = new Gtk.Button({
                label: 'Test Connection',
                css_classes: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            testBox.append(this._testButton);

            this._statusLabel = new Gtk.Label({
                label: '',
                hexpand: true,
                xalign: 0,
                wrap: true,
                max_width_chars: 48,
            });
            testBox.append(this._statusLabel);

            // Copy-button — only visible when there's an error message
            this._copyButton = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                tooltip_text: 'Copy error message',
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
                visible: false,
            });
            testBox.append(this._copyButton);

            // ── Entity / service loading ───────────────────────────────
            const dataGroup = new Adw.PreferencesGroup({
                title: 'Home Assistant Data',
                description: 'Refreshes automatically whenever you open this tab. Actions and Sensors use this cached data for entity search.',
            });
            this.add(dataGroup);

            this._loadStatusRow = new Adw.ActionRow({
                title: 'Loaded Data',
                subtitle: haDataStore.getStatus(),
                activatable: false,
            });
            dataGroup.add(this._loadStatusRow);

            const loadRow = new Adw.ActionRow({
                title: 'Refresh Home Assistant Data',
                subtitle: 'Reload entities and services from your Home Assistant instance',
            });
            dataGroup.add(loadRow);

            this._loadButton = new Gtk.Button({
                label: 'Refresh',
                css_classes: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            loadRow.add_suffix(this._loadButton);

            // ── Save on change ─────────────────────────────────────────
            this._urlRow.connect('changed', () =>
                settings.set_string('ha-url', this._urlRow.text));
            this._tokenRow.connect('changed', () =>
                settings.set_string('ha-token', this._tokenRow.text));
            this._sslRow.connect('notify::active', () =>
                settings.set_boolean('ha-verify-ssl', this._sslRow.active));

            this._testButton.connect('clicked', () => this._testConnection());
            this._copyButton.connect('clicked', () => this._copyError());
            this._loadButton.connect('clicked', () => void this.refreshHAData());
            this.connect('map', () => void this.refreshHAData());
            this.connect('notify::child-visible', () => {
                if (this.get_child_visible())
                    void this.refreshHAData();
            });

            this._updateLoadUI();
        }

        async _testConnection() {
            this._testButton.sensitive = false;
            this._copyButton.visible = false;
            this._statusLabel.label = 'Connecting…';
            this._statusLabel.remove_css_class('success');
            this._statusLabel.remove_css_class('error');

            const client = new HaClient();
            client.setCredentials(
                this._urlRow.text,
                this._tokenRow.text,
                this._sslRow.active
            );

            try {
                await client.testConnection();
                this._statusLabel.label = 'Connected successfully';
                this._statusLabel.add_css_class('success');
            } catch (e) {
                this._statusLabel.label = `Error: ${e.message}`;
                this._statusLabel.add_css_class('error');
                this._copyButton.visible = true;
            } finally {
                this._testButton.sensitive = true;
                client.destroy();
            }
        }

        _copyError() {
            const text = this._statusLabel.label;
            if (!text) return;
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set(text);

            // Brief visual confirmation
            this._copyButton.icon_name = 'object-select-symbolic';
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._copyButton.icon_name = 'edit-copy-symbolic';
                return GLib.SOURCE_REMOVE;
            });
        }

        refreshHAData() {
            return haDataStore.refresh(this._settings);
        }

        _updateLoadUI() {
            this._loadStatusRow.subtitle = haDataStore.getStatus();
            this._loadButton.sensitive = !haDataStore.isLoading();
            this._loadButton.label = haDataStore.isLoading() ? 'Refreshing…' : 'Refresh';
        }

        vfunc_unroot() {
            if (this._haDataChangedId) {
                haDataStore.disconnect(this._haDataChangedId);
                this._haDataChangedId = null;
            }

            super.vfunc_unroot();
        }
    }
);
