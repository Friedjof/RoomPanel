import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { serialize, parse } from '../lib/yaml.js';
import { getDefaultBackupPath, getResolvedBackupPath, settingsToObject } from '../lib/backup.js';
import { validateConfig } from '../lib/configValidator.js';

function getDownloadsDir() {
    const xdg = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    return Gio.File.new_for_path(xdg || GLib.get_home_dir());
}

/**
 * Apply an imported YAML object back to GSettings.
 * Token is intentionally excluded from backup for security.
 */
function applyObjectToSettings(obj, settings) {
    const c = obj.connection ?? {};
    if (c.url !== undefined) settings.set_string('ha-url', String(c.url));
    if (c.verify_ssl !== undefined) settings.set_boolean('ha-verify-ssl', !!c.verify_ssl);

    const color = obj.panel?.color ?? {};
    if (Array.isArray(color.entities))
        settings.set_strv('color-entities', color.entities.map(String));
    else if (color.entity !== undefined)
        settings.set_strv('color-entities', [String(color.entity)].filter(Boolean));
    if (color.service !== undefined) settings.set_string('color-service', String(color.service));
    if (color.attribute !== undefined) settings.set_string('color-attribute', String(color.attribute));

    const screenSync = obj.panel?.screen_sync ?? {};
    if (screenSync.enabled !== undefined) settings.set_boolean('screen-sync-enabled', !!screenSync.enabled);
    if (Array.isArray(screenSync.entities)) {
        // New format: [{entity_id, enabled}] — or legacy string array
        const normalized = screenSync.entities.map(e =>
            typeof e === 'string'
                ? { entity_id: e, enabled: true }
                : { entity_id: String(e.entity_id ?? ''), enabled: e.enabled !== false }
        ).filter(e => e.entity_id);
        settings.set_string('screen-sync-entities', JSON.stringify(normalized));
    } else if (screenSync.entity !== undefined) {
        const entityId = String(screenSync.entity);
        settings.set_string('screen-sync-entities', entityId ? JSON.stringify([{ entity_id: entityId, enabled: true }]) : '[]');
    }
    if (screenSync.interval !== undefined) settings.set_double('screen-sync-interval', Number(screenSync.interval) || 2.0);
    if (screenSync.mode !== undefined) settings.set_string('screen-sync-mode', String(screenSync.mode));
    if (screenSync.scope !== undefined) settings.set_string('screen-sync-scope', String(screenSync.scope));

    const slider = obj.panel?.slider ?? {};
    if (Array.isArray(slider.entities))
        settings.set_string('slider-entities-config', JSON.stringify(slider.entities));
    else if (slider.entity !== undefined)
        settings.set_string('slider-entities-config', JSON.stringify([{
            entity_id: String(slider.entity),
            service:   String(slider.service   ?? 'light.turn_on'),
            attribute: String(slider.attribute ?? 'brightness'),
            min: Number(slider.min ?? 0),
            max: Number(slider.max ?? 255),
        }].filter(c => c.entity_id)));

    if (Array.isArray(obj.buttons))
        settings.set_string('buttons-config', JSON.stringify(obj.buttons));

    if (Array.isArray(obj.sensors))
        settings.set_string('sensor-widgets-config', JSON.stringify(obj.sensors));

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

            // Validate button
            const validateRow = new Adw.ActionRow({
                title: 'Validate Config',
                subtitle: 'Check the current settings for errors and suspicious values',
            });
            const validateBtn = new Gtk.Button({
                label: 'Validate',
                valign: Gtk.Align.CENTER,
            });
            validateRow.add_suffix(validateBtn);
            manualGroup.add(validateRow);

            // Open in editor button
            const editorRow = new Adw.ActionRow({
                title: 'Open Backup in Editor',
                subtitle: 'Open the YAML file in your default text editor',
            });
            const editorBtn = new Gtk.Button({
                label: 'Open…',
                valign: Gtk.Align.CENTER,
            });
            editorRow.add_suffix(editorBtn);
            manualGroup.add(editorRow);

            // Sync from file button
            const syncRow = new Adw.ActionRow({
                title: 'Sync from Backup File',
                subtitle: 'Apply the saved YAML file back into settings — useful after manual edits in the editor',
            });
            const syncBtn = new Gtk.Button({
                label: 'Sync',
                valign: Gtk.Align.CENTER,
            });
            syncRow.add_suffix(syncBtn);
            manualGroup.add(syncRow);

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
            validateBtn.connect('clicked', () => this._validateYaml());
            editorBtn.connect('clicked', () => this._openInEditor());
            syncBtn.connect('clicked', () => this._syncFromFile());

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
                initial_folder: getDownloadsDir(),
            });

            let file;
            try {
                file = await new Promise((resolve, reject) => {
                    dialog.save(this.get_root(), null, (_dlg, result) => {
                        try { resolve(dialog.save_finish(result)); }
                        catch (e) { reject(e); }
                    });
                });
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                    !e.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                    this._showError(`Could not open file chooser: ${e.message}`);
                return;
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
            const filter = new Gtk.FileFilter();
            filter.add_pattern('*.yaml');
            filter.add_pattern('*.yml');
            filter.set_name('YAML files');

            const dialog = new Gtk.FileDialog({
                title: 'Import Settings',
                initial_folder: getDownloadsDir(),
                default_filter: filter,
            });

            let file;
            try {
                file = await new Promise((resolve, reject) => {
                    dialog.open(this.get_root(), null, (_dlg, result) => {
                        try { resolve(dialog.open_finish(result)); }
                        catch (e) { reject(e); }
                    });
                });
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                    !e.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                    this._showError(`Could not open file chooser: ${e.message}`);
                return;
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

        _readBackupSource({ allowPreviewFallback = false } = {}) {
            const path = getResolvedBackupPath(this._settings);
            const file = Gio.File.new_for_path(path);

            if (file.query_exists(null)) {
                const [ok, contents] = file.load_contents(null);
                if (!ok)
                    throw new Error('Could not read file');

                return {
                    path,
                    source: path,
                    text: new TextDecoder('utf-8').decode(contents),
                };
            }

            if (allowPreviewFallback) {
                const start = this._previewBuffer.get_start_iter();
                const end   = this._previewBuffer.get_end_iter();
                return {
                    path,
                    source: 'current settings (no file found)',
                    text: this._previewBuffer.get_text(start, end, false),
                };
            }

            throw new Error(`Backup file not found:\n${path}\n\nUse "Open in Editor" to create it first.`);
        }

        _parseAndValidateYaml(text) {
            const obj = parse(text);
            return { obj, validation: validateConfig(obj) };
        }

        _validateYaml() {
            // Prefer the actual file on disk — this reflects manual edits made in the editor.
            // Fall back to the preview buffer only if no file exists yet.
            let text;
            let source;
            try {
                ({ text, source } = this._readBackupSource({ allowPreviewFallback: true }));
            } catch (e) {
                this._showError(`Could not read backup file: ${e.message}`);
                return;
            }

            try {
                const { validation } = this._parseAndValidateYaml(text);
                this._showValidationDialog(validation, source);
            } catch (e) {
                this._showValidationDialog(
                    { errors: [`YAML parse error: ${e.message}`], warnings: [] },
                    source
                );
            }
        }

        _showValidationDialog({ errors, warnings }, source = null) {
            const dialog = new Adw.Dialog({
                title: 'Config Validation',
                content_width: 520,
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 16,
                margin_bottom: 16,
                margin_start: 16,
                margin_end: 16,
            });
            dialog.set_child(box);

            // ── Status banner ─────────────────────────────────────────
            const statusBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 10,
                margin_bottom: 4,
            });
            statusBox.add_css_class('card');

            const bannerInner = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 2,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 14,
                margin_end: 14,
                hexpand: true,
            });
            statusBox.append(bannerInner);

            const statusIcon = new Gtk.Image({
                pixel_size: 32,
                halign: Gtk.Align.START,
            });
            const statusTitle = new Gtk.Label({ xalign: 0 });
            statusTitle.add_css_class('title-4');
            const statusSub = new Gtk.Label({ xalign: 0 });
            statusSub.add_css_class('dim-label');

            if (errors.length === 0 && warnings.length === 0) {
                statusIcon.set_from_icon_name('emblem-ok-symbolic');
                statusIcon.add_css_class('success');
                statusTitle.label = 'Config looks good';
                statusSub.label = 'No errors or warnings found.';
            } else if (errors.length > 0) {
                statusIcon.set_from_icon_name('dialog-error-symbolic');
                statusIcon.add_css_class('error');
                statusTitle.label = `${errors.length} error${errors.length > 1 ? 's' : ''} found`;
                statusSub.label = warnings.length > 0
                    ? `and ${warnings.length} warning${warnings.length > 1 ? 's' : ''}`
                    : 'Please fix these before using this config.';
            } else {
                statusIcon.set_from_icon_name('dialog-warning-symbolic');
                statusIcon.add_css_class('warning');
                statusTitle.label = `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`;
                statusSub.label = 'These might be intentional, but are worth checking.';
            }

            bannerInner.append(statusIcon);
            bannerInner.append(statusTitle);
            bannerInner.append(statusSub);
            box.append(statusBox);

            if (source) {
                const srcLabel = new Gtk.Label({
                    label: `Validating: ${source}`,
                    xalign: 0,
                    ellipsize: 3, // PANGO_ELLIPSIZE_END
                    css_classes: ['dim-label', 'caption'],
                });
                box.append(srcLabel);
            }

            // ── Issue lists ───────────────────────────────────────────
            const makeIssueList = (items, iconName, cssClass) => {
                const scroll = new Gtk.ScrolledWindow({
                    min_content_height: Math.min(items.length * 56, 220),
                    max_content_height: 220,
                    hscrollbar_policy: Gtk.PolicyType.NEVER,
                    vexpand: false,
                });
                const listBox = new Gtk.ListBox({
                    selection_mode: Gtk.SelectionMode.NONE,
                    css_classes: ['boxed-list'],
                });
                scroll.set_child(listBox);

                for (const msg of items) {
                    const row = new Adw.ActionRow({ subtitle: msg, subtitle_selectable: true });
                    const icon = new Gtk.Image({ icon_name: iconName, pixel_size: 16 });
                    icon.add_css_class(cssClass);
                    row.add_prefix(icon);
                    listBox.append(row);
                }
                return scroll;
            };

            if (errors.length > 0) {
                const label = new Gtk.Label({ label: 'Errors', xalign: 0 });
                label.add_css_class('heading');
                box.append(label);
                box.append(makeIssueList(errors, 'dialog-error-symbolic', 'error'));
            }

            if (warnings.length > 0) {
                const label = new Gtk.Label({ label: 'Warnings', xalign: 0 });
                label.add_css_class('heading');
                box.append(label);
                box.append(makeIssueList(warnings, 'dialog-warning-symbolic', 'warning'));
            }

            // ── Close button ──────────────────────────────────────────
            const closeBtn = new Gtk.Button({
                label: 'Close',
                css_classes: ['suggested-action'],
                halign: Gtk.Align.CENTER,
                margin_top: 4,
            });
            closeBtn.connect('clicked', () => dialog.close());
            box.append(closeBtn);

            dialog.present(this.get_root());
        }

        async _openInEditor() {
            const path = getResolvedBackupPath(this._settings);
            const file = Gio.File.new_for_path(path);

            // If the file doesn't exist yet, export it first.
            if (!file.query_exists(null)) {
                const confirm = new Adw.MessageDialog({
                    transient_for: this.get_root(),
                    heading: 'Backup File Not Found',
                    body: `The backup file does not exist yet:\n${path}\n\nExport the current settings now to create it?`,
                });
                confirm.add_response('cancel', 'Cancel');
                confirm.add_response('export', 'Export & Open');
                confirm.set_response_appearance('export', Adw.ResponseAppearance.SUGGESTED);
                const response = await confirm.choose(null);
                if (response !== 'export')
                    return;

                // Write the file
                const date = new Date().toISOString().split('T')[0];
                const yaml = serialize(settingsToObject(this._settings), `RoomPanel Backup – ${date}`);
                try {
                    const parent = file.get_parent();
                    parent?.make_directory_with_parents(null);
                    file.replace_contents(new TextEncoder().encode(yaml), null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                } catch (e) {
                    this._showError(`Could not write backup file: ${e.message}`);
                    return;
                }
            }

            try {
                Gtk.show_uri(this.get_root(), file.get_uri(), 0 /* GDK_CURRENT_TIME */);
            } catch (e) {
                this._showError(`Could not open editor: ${e.message}`);
            }
        }

        async _syncFromFile() {
            let path;
            let source;
            let text;
            try {
                ({ path, source, text } = this._readBackupSource());
            } catch (e) {
                this._showError(e.message);
                return;
            }

            let obj;
            let validation;
            try {
                ({ obj, validation } = this._parseAndValidateYaml(text));
            } catch (e) {
                this._showValidationDialog(
                    { errors: [`YAML parse error: ${e.message}`], warnings: [] },
                    source
                );
                return;
            }

            if (validation.errors.length > 0) {
                this._showValidationDialog(validation, source);
                return;
            }

            const warningCount = validation.warnings.length;
            const confirm = new Adw.MessageDialog({
                transient_for: this.get_root(),
                heading: warningCount > 0 ? 'Backup File Has No Blocking Errors' : 'Backup File Looks Valid',
                body: warningCount > 0
                    ? `No blocking errors were found in:\n${path}\n\n${warningCount} warning${warningCount > 1 ? 's' : ''} remain. The file is usable, but should be checked before syncing. Apply it anyway?`
                    : `The backup file passed validation without errors or warnings:\n${path}\n\nApply it to the current settings now?`,
            });
            confirm.add_response('cancel', 'Cancel');
            confirm.add_response('sync', 'Sync');
            confirm.set_response_appearance('sync', Adw.ResponseAppearance.SUGGESTED);
            const response = await confirm.choose(null);
            if (response !== 'sync')
                return;

            try {
                applyObjectToSettings(obj, this._settings);
                this._refreshPreview();
            } catch (e) {
                this._showError(`Sync failed: ${e.message}`);
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
