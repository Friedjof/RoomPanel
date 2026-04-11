import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { getTemplate } from '../../lib/serviceTemplates.js';
import { getServiceDomains, createStringList, getDropDownValue, setDropDownValue, escapeMarkup } from '../utils.js';
import { EntitySearchPopover } from '../popovers/entitySearch.js';
import { ServiceSearchPopover } from '../popovers/serviceSearch.js';
import { EmojiPickerPopover } from '../popovers/emojiPicker.js';

// ─── ButtonListRow ────────────────────────────────────────────────────────────

export const ButtonListRow = GObject.registerClass(
class ButtonListRow extends Adw.ActionRow {
    _init(config, index, onEdit, onDelete) {
        const rowTitle = escapeMarkup(
            `${config.icon ?? ''} ${config.label ?? ''}`.trim() || `Button ${index + 1}`
        );
        const rowSubtitle = config.entity_id
            ? escapeMarkup(`${config.domain}.${config.service} → ${config.entity_id}`)
            : 'Not configured';

        super._init({
            title: rowTitle,
            subtitle: rowSubtitle,
            activatable: false,
        });

        this._config = config;

        // Color dot
        if (config.color) {
            this.add_prefix(new Gtk.Label({
                use_markup: true,
                label: `<span foreground="${escapeMarkup(config.color)}">●</span>`,
                valign: Gtk.Align.CENTER,
            }));
        }

        const editBtn = new Gtk.Button({ icon_name: 'document-edit-symbolic',
            css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Edit' });
        const deleteBtn = new Gtk.Button({ icon_name: 'edit-delete-symbolic',
            css_classes: ['destructive-action'], valign: Gtk.Align.CENTER,
            tooltip_text: 'Delete' });

        this.add_suffix(editBtn);
        this.add_suffix(deleteBtn);

        editBtn.connect('clicked', () => onEdit(index));
        deleteBtn.connect('clicked', () => onDelete(index));
    }
});

// ─── ButtonEditDialog ─────────────────────────────────────────────────────────

export const ButtonEditDialog = GObject.registerClass(
class ButtonEditDialog extends Adw.Dialog {
    _init(config, entities, services, onSave) {
        const dialogTitle = config.label
            ? `Edit "${escapeMarkup(config.label)}"`
            : 'New Button';
        super._init({ title: dialogTitle, content_width: 480 });

        this._config = { label: '', icon: '', color: '',
            entity_id: '', domain: '', service: '', service_data: {}, ...config };
        this._onSave = onSave;

        const page = new Adw.PreferencesPage();
        this.set_child(page);

        // ── Appearance Group ──────────────────────────────────────────
        const appearGroup = new Adw.PreferencesGroup({ title: 'Appearance' });
        page.add(appearGroup);

        const labelRow = new Adw.EntryRow({ title: 'Label', text: this._config.label });
        appearGroup.add(labelRow);

        this._emojiBtn = new Gtk.Button({
            label: this._config.icon || '🏠',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Pick emoji',
        });
        labelRow.add_prefix(this._emojiBtn);

        this._emojiPicker = new EmojiPickerPopover(emoji => {
            this._config.icon = emoji;
            this._emojiBtn.label = emoji;
        });
        this._emojiPicker.set_parent(this._emojiBtn);
        this._emojiBtn.connect('clicked', () => this._emojiPicker.popup());

        labelRow.connect('changed', () => { this._config.label = labelRow.text; });

        // Color row
        const colorRow = new Adw.ActionRow({ title: 'Button Color',
            subtitle: 'Leave unset for default theme color' });
        appearGroup.add(colorRow);

        this._colorBtn = new Gtk.ColorDialogButton({
            valign: Gtk.Align.CENTER,
            dialog: new Gtk.ColorDialog({ title: 'Button Color', with_alpha: false }),
        });
        if (this._config.color) {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(this._config.color))
                this._colorBtn.rgba = rgba;
        }
        colorRow.add_suffix(this._colorBtn);

        const clearColorBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Reset to default',
        });
        colorRow.add_suffix(clearColorBtn);
        clearColorBtn.connect('clicked', () => {
            this._config.color = '';
            const rgba = new Gdk.RGBA();
            rgba.parse('rgba(0,0,0,0)');
            this._colorBtn.rgba = rgba;
        });
        this._colorBtn.connect('notify::rgba', () => {
            const c = this._colorBtn.rgba;
            if (c.alpha < 0.01) {
                this._config.color = '';
            } else {
                this._config.color = `#${Math.round(c.red * 255).toString(16).padStart(2, '0')}${Math.round(c.green * 255).toString(16).padStart(2, '0')}${Math.round(c.blue * 255).toString(16).padStart(2, '0')}`;
            }
        });

        // ── Action Group ──────────────────────────────────────────────
        const actionGroup = new Adw.PreferencesGroup({ title: 'Action' });
        page.add(actionGroup);

        // Entity ID
        this._entityRow = new Adw.EntryRow({ title: 'Entity ID',
            text: this._config.entity_id });
        actionGroup.add(this._entityRow);

        const entitySearchBtn = new Gtk.Button({ icon_name: 'system-search-symbolic',
            valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse entities' });
        this._entityRow.add_suffix(entitySearchBtn);

        this._entityPopover = new EntitySearchPopover(entityId => {
            this._entityRow.text = entityId;
            this._config.entity_id = entityId;
            const domain = entityId.split('.')[0];
            this._setSelectedDomain(domain);
        });
        this._entityPopover.set_parent(entitySearchBtn);
        if (entities?.length) this._entityPopover.setEntities(entities);
        entitySearchBtn.connect('clicked', () => {
            this._entityPopover.setDomainFilter(this._config.domain);
            this._entityPopover.popup();
        });
        this._entityRow.connect('changed', () => {
            this._config.entity_id = this._entityRow.text;
            const domain = this._entityRow.text.split('.')[0];
            if (domain)
                this._setSelectedDomain(domain);
        });

        // Domain dropdown
        const domainRow = new Adw.ActionRow({ title: 'Service Domain' });
        this._domainModel = createStringList(getServiceDomains(services, [this._config.domain]));
        this._domainDropdown = new Gtk.DropDown({
            model: this._domainModel,
            valign: Gtk.Align.CENTER,
        });
        domainRow.add_suffix(this._domainDropdown);
        domainRow.activatable_widget = this._domainDropdown;
        actionGroup.add(domainRow);

        const initialDomain = this._config.domain || this._config.entity_id.split('.')[0];
        this._setSelectedDomain(initialDomain);
        this._domainDropdown.connect('notify::selected-item', () => {
            this._config.domain = getDropDownValue(this._domainDropdown);
            this._servicePopover?.setDomainFilter(this._config.domain);
            this._entityPopover?.setDomainFilter(this._config.domain);
        });

        // Service
        this._serviceRow = new Adw.EntryRow({
            title: 'Service',
            text: this._config.service,
        });
        actionGroup.add(this._serviceRow);

        const serviceSearchBtn = new Gtk.Button({ icon_name: 'system-search-symbolic',
            valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse services' });
        this._serviceRow.add_suffix(serviceSearchBtn);

        this._servicePopover = new ServiceSearchPopover((domain, service) => {
            this._setSelectedDomain(domain);
            this._serviceRow.text = service;
            this._config.service = service;
            // Auto-fill service_data from template
            const tpl = getTemplate(domain, service);
            if (Object.keys(tpl).length > 0) {
                this._config.service_data = tpl;
                this._serviceDataRow.text = JSON.stringify(tpl, null, 2);
            }
        });
        this._servicePopover.set_parent(serviceSearchBtn);
        if (services?.length)
            this._servicePopover.setServices(services);
        else
            this._servicePopover.setFallbackServices();

        serviceSearchBtn.connect('clicked', () => {
            this._servicePopover.setDomainFilter(this._config.domain);
            this._servicePopover.popup();
        });
        this._serviceRow.connect('changed', () => { this._config.service = this._serviceRow.text; });

        // ── Advanced toggle ───────────────────────────────────────────
        const advancedRow = new Adw.ExpanderRow({ title: 'Advanced' });
        actionGroup.add(advancedRow);

        this._serviceDataRow = new Adw.EntryRow({
            title: 'Service Data (JSON)',
            text: JSON.stringify(this._config.service_data ?? {}),
        });
        advancedRow.add_row(this._serviceDataRow);
        this._serviceDataRow.connect('changed', () => {
            try {
                this._config.service_data = JSON.parse(this._serviceDataRow.text || '{}');
            } catch { /* keep old value */ }
        });

        // ── Footer buttons ────────────────────────────────────────────
        const cancelBtn = new Gtk.Button({ label: 'Cancel', hexpand: true });
        const saveBtn = new Gtk.Button({ label: 'Save',
            css_classes: ['suggested-action'], hexpand: true });

        const btnBox = new Gtk.Box({ spacing: 8, margin_top: 12,
            margin_start: 16, margin_end: 16, margin_bottom: 16 });
        btnBox.append(cancelBtn);
        btnBox.append(saveBtn);

        page.add(new Adw.PreferencesGroup({ header_suffix: btnBox }));

        cancelBtn.connect('clicked', () => this.close());
        saveBtn.connect('clicked', () => {
            this._onSave({ ...this._config });
            this.close();
        });
    }

    _setSelectedDomain(domain) {
        setDropDownValue(this._domainDropdown, this._domainModel, domain);
        this._config.domain = getDropDownValue(this._domainDropdown);
        this._servicePopover?.setDomainFilter(this._config.domain);
        this._entityPopover?.setDomainFilter(this._config.domain);
    }
});
