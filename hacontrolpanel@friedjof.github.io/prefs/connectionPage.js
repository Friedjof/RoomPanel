import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { HaClient } from '../lib/haClient.js';
import { haDataStore } from './haDataStore.js';

/** Convert a hex color string to a Gdk.RGBA */
function hexToRgba(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const color = new Gdk.RGBA();
    color.red = r;
    color.green = g;
    color.blue = b;
    color.alpha = 1;
    return color;
}

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

            // Token is never pre-filled — the real value stays in GSettings only.
            // The field is always empty on open; the dot count cannot reveal length.
            // Adw.EntryRow + manual visibility=false avoids the reveal-eye of PasswordEntryRow.
            this._storedToken = settings.get_string('ha-token');
            this._tokenRow = new Adw.EntryRow({
                title: 'Long-Lived Access Token',
                text: '',
                show_apply_button: true,
            });
            // Mask input without the built-in reveal button
            const tokenText = this._tokenRow.get_delegate();
            if (tokenText) {
                tokenText.set_visibility(false);
                tokenText.set_input_purpose(Gtk.InputPurpose.PASSWORD);
            }
            this._tokenRow.placeholder_text = this._storedToken
                ? 'Token saved — enter new token to replace'
                : 'Paste token here';
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
            this._tokenRow.connect('apply', () => {
                const val = this._tokenRow.text.trim();
                if (val) {
                    this._storedToken = val;
                    settings.set_string('ha-token', val);
                    this._tokenRow.text = '';
                    this._tokenRow.placeholder_text = 'Token saved — enter new token to replace';
                }
                // Empty apply → ignore, keep existing token
            });
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

            // ── Group: Firefox Extension ────────────────────────────────
            this._buildBrowserBridgeGroup(settings);
        }

        _buildBrowserBridgeGroup(settings) {
            const bridgeGroup = new Adw.PreferencesGroup({
                title: 'Firefox Extension',
                description: 'Browser Bridge for real-time YouTube color sync',
            });
            this.add(bridgeGroup);

            // Enable / disable switch
            this._bridgeEnabledRow = new Adw.SwitchRow({
                title: 'Enable Browser Bridge',
                subtitle: 'Start a local WebSocket server for the Firefox extension',
                active: settings.get_boolean('browser-bridge-enabled'),
            });
            bridgeGroup.add(this._bridgeEnabledRow);

            // Port spin row
            this._bridgePortRow = new Adw.SpinRow({
                title: 'Port',
                subtitle: 'Local port the WebSocket server listens on',
                adjustment: new Gtk.Adjustment({
                    lower: 1024,
                    upper: 65535,
                    step_increment: 1,
                    value: settings.get_int('browser-bridge-port'),
                }),
                digits: 0,
            });
            bridgeGroup.add(this._bridgePortRow);

            // ── Diagnostic expander (only when connected) ──────────────
            this._bridgeDiagGroup = new Adw.PreferencesGroup({
                title: 'Diagnostics',
            });
            this.add(this._bridgeDiagGroup);

            // Connection status row
            this._bridgeStatusRow = new Adw.ActionRow({
                title: 'Connection',
                activatable: false,
            });
            this._bridgeDiagGroup.add(this._bridgeStatusRow);

            // YouTube tab status row
            this._bridgeYtRow = new Adw.ActionRow({
                title: 'YouTube Tab',
                activatable: false,
            });
            this._bridgeDiagGroup.add(this._bridgeYtRow);

            // Color preview row
            const colorRow = new Adw.ActionRow({
                title: 'Last Color',
                activatable: false,
            });
            this._bridgeDiagGroup.add(colorRow);

            this._bridgeColorSwatch = new Gtk.Box({
                width_request: 28,
                height_request: 28,
                valign: Gtk.Align.CENTER,
                css_classes: ['color-swatch'],
            });
            this._bridgeColorProvider = new Gtk.CssProvider();
            this._bridgeColorSwatch.get_style_context().add_provider(
                this._bridgeColorProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
            colorRow.add_suffix(this._bridgeColorSwatch);

            this._bridgeColorLabel = new Gtk.Label({
                label: '—',
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            });
            colorRow.add_suffix(this._bridgeColorLabel);

            // ── Wire up signals ────────────────────────────────────────
            this._bridgeEnabledRow.connect('notify::active', () =>
                settings.set_boolean('browser-bridge-enabled', this._bridgeEnabledRow.active));

            this._bridgePortRow.connect('notify::value', () =>
                settings.set_int('browser-bridge-port', this._bridgePortRow.value));

            // React to live status changes written by the GNOME extension
            this._bridgeSettingsChangedId = settings.connect('changed', (_s, key) => {
                if (['browser-bridge-connected', 'browser-bridge-tab-list',
                    'browser-bridge-preview-color'].includes(key))
                    this._updateBridgeDiag(settings);
            });

            this._updateBridgeDiag(settings);
        }

        _updateBridgeDiag(settings) {
            const connected = settings.get_boolean('browser-bridge-connected');

            this._bridgeDiagGroup.visible = true;

            // Status
            if (connected) {
                this._bridgeStatusRow.subtitle = 'Connected';
                this._bridgeStatusRow.remove_css_class('dim-label');
            } else {
                this._bridgeStatusRow.subtitle = 'Not connected — install and enable the Firefox extension';
                this._bridgeStatusRow.add_css_class('dim-label');
            }

            // YouTube tabs
            let tabs = [];
            try { tabs = JSON.parse(settings.get_string('browser-bridge-tab-list')); } catch {}
            const activeTab = tabs.find(t => t.active);
            if (!connected) {
                this._bridgeYtRow.subtitle = '—';
            } else if (activeTab) {
                this._bridgeYtRow.subtitle = `Active: ${activeTab.title}`;
            } else if (tabs.length > 0) {
                this._bridgeYtRow.subtitle = `${tabs.length} tab(s) open, none in foreground`;
            } else {
                this._bridgeYtRow.subtitle = 'No YouTube tab detected';
            }

            // Color preview
            const hex = settings.get_string('browser-bridge-preview-color');
            if (hex && hex.startsWith('#') && hex.length === 7) {
                this._bridgeColorLabel.label = hex.toUpperCase();
                this._bridgeColorProvider.load_from_string(
                    `.color-swatch { background-color: ${hex}; border-radius: 4px; }`
                );
                this._bridgeColorSwatch.visible = true;
            } else {
                this._bridgeColorLabel.label = connected ? 'Waiting for video…' : '—';
                this._bridgeColorSwatch.visible = false;
            }
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
                this._tokenRow.text.trim() || this._storedToken,
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

            if (this._bridgeSettingsChangedId) {
                this._settings.disconnect(this._bridgeSettingsChangedId);
                this._bridgeSettingsChangedId = null;
            }

            super.vfunc_unroot();
        }
    }
);
