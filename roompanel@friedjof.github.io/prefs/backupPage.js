import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import { serialize, parse } from '../lib/yaml.js';
import { getDefaultBackupPath, settingsToObject } from '../lib/backup.js';

/**
 * Apply an imported YAML object back to GSettings.
 * Token is intentionally excluded from backup for security.
 */
function applyObjectToSettings(obj, settings) {
    const c = obj.connection ?? {};
    if (c.url !== undefined) settings.set_string('ha-url', String(c.url));
    if (c.verify_ssl !== undefined) settings.set_boolean('ha-verify-ssl', !!c.verify_ssl);

    const color = obj.panel?.color ?? {};
    if (color.entity !== undefined) settings.set_string('color-entity', String(color.entity));
    if (color.service !== undefined) settings.set_string('color-service', String(color.service));
    if (color.attribute !== undefined) settings.set_string('color-attribute', String(color.attribute));

    const slider = obj.panel?.slider ?? {};
    if (slider.entity !== undefined) settings.set_string('slider-entity', String(slider.entity));
    if (slider.service !== undefined) settings.set_string('slider-service', String(slider.service));
    if (slider.attribute !== undefined) settings.set_string('slider-attribute', String(slider.attribute));
    if (slider.min !== undefined) settings.set_double('slider-min', Number(slider.min));
    if (slider.max !== undefined) settings.set_double('slider-max', Number(slider.max));

    if (Array.isArray(obj.buttons))
        settings.set_string('buttons-config', JSON.stringify(obj.buttons));

    const backup = obj.backup ?? {};
    if (backup.auto !== undefined) settings.set_boolean('auto-yaml-backup', !!backup.auto);
    if (backup.path !== undefined) settings.set_string('yaml-backup-path', String(backup.path));
}

export const BackupPage = GObject.registerClass(
    class BackupPage extends Adw.PreferencesPage {
        _init(settings) {
            super._init({
                title: 'Backup',
                icon_name: 'document-save-symbolic',
                name: 'backup',
            });

            this._settings = settings;

            // ── Auto Backup Group ──────────────────────────────────────
            const autoGroup = new Adw.PreferencesGroup({
                title: 'Automatic YAML Backup',
                description: 'Sync settings to a YAML file whenever they change',
            });
            this.add(autoGroup);

            this._autoSwitch = new Adw.SwitchRow({
                title: 'Enable Auto-Backup',
                active: settings.get_boolean('auto-yaml-backup'),
            });
            autoGroup.add(this._autoSwitch);

            this._pathRow = new Adw.EntryRow({
                title: 'Backup File Path',
                text: settings.get_string('yaml-backup-path') || getDefaultBackupPath(),
                sensitive: settings.get_boolean('auto-yaml-backup'),
            });
            autoGroup.add(this._pathRow);

            this._autoSwitch.connect('notify::active', () => {
                settings.set_boolean('auto-yaml-backup', this._autoSwitch.active);
                this._pathRow.sensitive = this._autoSwitch.active;

                if (this._autoSwitch.active && !settings.get_string('yaml-backup-path').trim()) {
                    const defaultPath = getDefaultBackupPath();
                    this._pathRow.text = defaultPath;
                    settings.set_string('yaml-backup-path', defaultPath);
                }
            });
            this._pathRow.connect('changed', () =>
                settings.set_string('yaml-backup-path', this._pathRow.text));

            // ── Manual Backup Group ────────────────────────────────────
            const manualGroup = new Adw.PreferencesGroup({
                title: 'Manual Export / Import',
            });
            this.add(manualGroup);

            // Export button
            const exportRow = new Adw.ActionRow({
                title: 'Export Settings',
                subtitle: 'Save current settings as a YAML file',
            });
            const exportBtn = new Gtk.Button({
                label: 'Export…',
                valign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            exportRow.add_suffix(exportBtn);
            manualGroup.add(exportRow);

            // Import button
            const importRow = new Adw.ActionRow({
                title: 'Import Settings',
                subtitle: 'Load settings from a YAML file (token is not imported)',
            });
            const importBtn = new Gtk.Button({
                label: 'Import…',
                valign: Gtk.Align.CENTER,
            });
            importRow.add_suffix(importBtn);
            manualGroup.add(importRow);

            // ── Preview ────────────────────────────────────────────────
            const previewGroup = new Adw.PreferencesGroup({ title: 'YAML Preview' });
            this.add(previewGroup);

            const scroll = new Gtk.ScrolledWindow({
                min_content_height: 200,
                vexpand: true,
                hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            });
            this._previewBuffer = new Gtk.TextBuffer();
            const textView = new Gtk.TextView({
                buffer: this._previewBuffer,
                editable: false,
                monospace: true,
                wrap_mode: Gtk.WrapMode.NONE,
            });
            scroll.set_child(textView);

            const previewRow = new Adw.ActionRow();
            previewRow.set_child(scroll);
            previewGroup.add(previewRow);

            this._refreshPreview();

            // Connect buttons
            exportBtn.connect('clicked', () => this._exportYaml());
            importBtn.connect('clicked', () => this._importYaml());

            // Refresh preview on settings change
            this._changedId = settings.connect('changed', () => this._refreshPreview());
        }

        _refreshPreview() {
            const date = new Date().toISOString().split('T')[0];
            const obj = settingsToObject(this._settings);
            const yaml = serialize(obj, `RoomPanel Backup – ${date}`);
            this._previewBuffer.set_text(yaml, -1);
        }

        async _exportYaml() {
            const dialog = new Gtk.FileDialog({
                title: 'Export Settings',
                initial_name: 'roompanel-backup.yaml',
            });

            let file;
            try {
                file = await dialog.save(this.get_root(), null);
            } catch {
                return; // cancelled
            }

            const date = new Date().toISOString().split('T')[0];
            const obj = settingsToObject(this._settings);
            const yaml = serialize(obj, `RoomPanel Backup – ${date}`);
            const bytes = new TextEncoder().encode(yaml);

            try {
                file.replace_contents(bytes, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } catch (e) {
                this._showError(`Export failed: ${e.message}`);
            }
        }

        async _importYaml() {
            const dialog = new Gtk.FileDialog({ title: 'Import Settings' });
            const filter = new Gtk.FileFilter();
            filter.add_pattern('*.yaml');
            filter.add_pattern('*.yml');
            filter.set_name('YAML files');
            dialog.set_default_filter(filter);

            let file;
            try {
                file = await dialog.open(this.get_root(), null);
            } catch {
                return; // cancelled
            }

            try {
                const [ok, contents] = file.load_contents(null);
                if (!ok) throw new Error('Could not read file');
                const text = new TextDecoder('utf-8').decode(contents);
                const obj = parse(text);
                applyObjectToSettings(obj, this._settings);
                this._refreshPreview();
            } catch (e) {
                this._showError(`Import failed: ${e.message}`);
            }
        }

        _showError(msg) {
            const dialog = new Adw.MessageDialog({
                transient_for: this.get_root(),
                heading: 'Error',
                body: msg,
            });
            dialog.add_response('ok', 'OK');
            dialog.present();
        }

        destroy() {
            if (this._changedId) {
                this._settings.disconnect(this._changedId);
                this._changedId = null;
            }
            super.destroy();
        }
    }
);
