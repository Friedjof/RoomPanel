import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { HaClient } from '../lib/haClient.js';
import { getTemplate, getKnownServiceKeys } from '../lib/serviceTemplates.js';

// ─── Common emoji sets ────────────────────────────────────────────────────────

const EMOJI_CATEGORIES = {
    'Smart Home': ['🏠', '💡', '🔌', '🌡️', '🔒', '🔓', '🚪', '🪟', '🛋️', '🛏️', '🚿', '🛁'],
    'Media':      ['▶️', '⏸️', '⏹️', '⏭️', '⏮️', '🔊', '🔇', '📺', '🎵', '🎶', '📻', '🎙️'],
    'Climate':    ['❄️', '🔥', '🌬️', '☀️', '🌙', '💨', '🌡️', '♨️'],
    'Actions':    ['⬆️', '⬇️', '⬅️', '➡️', '✅', '❌', '⭐', '❤️', '🔄', '⚡', '🌐', '📲'],
    'Devices':    ['🖥️', '💻', '🖨️', '📱', '⌨️', '🖱️', '📷', '🤖', '🔭', '🔬'],
    'Scenes':     ['🌅', '🌆', '🎬', '🎉', '🌈', '🕯️', '🪔', '🔦', '💫'],
};

function getServiceEntries(apiServices) {
    const entries = [];

    if (Array.isArray(apiServices) && apiServices.length > 0) {
        for (const entry of apiServices) {
            const names = Array.isArray(entry.services)
                ? entry.services
                : Object.keys(entry.services ?? {});
            for (const service of names)
                entries.push({ domain: entry.domain, service });
        }
    } else if (apiServices && typeof apiServices === 'object') {
        for (const [domain, services] of Object.entries(apiServices)) {
            for (const service of Object.keys(services ?? {}))
                entries.push({ domain, service });
        }
    } else {
        for (const key of getKnownServiceKeys()) {
            const [domain, ...rest] = key.split('.');
            entries.push({ domain, service: rest.join('.') });
        }
    }

    entries.sort((a, b) => `${a.domain}.${a.service}`.localeCompare(`${b.domain}.${b.service}`));
    return entries;
}

function getServiceDomains(apiServices, extraDomains = []) {
    const domains = new Set(getServiceEntries(apiServices).map(entry => entry.domain));
    for (const domain of extraDomains) {
        if (domain)
            domains.add(domain);
    }
    return [...domains].sort();
}

function createStringList(values) {
    const model = new Gtk.StringList();
    for (const value of values)
        model.append(value);
    return model;
}

function getDropDownValue(dropdown) {
    const item = dropdown.get_selected_item();
    return item ? item.get_string() : '';
}

function setDropDownValue(dropdown, model, value) {
    const count = model.get_n_items();
    for (let i = 0; i < count; i++) {
        const item = model.get_item(i);
        if (item?.get_string() === value) {
            dropdown.set_selected(i);
            return true;
        }
    }

    if (count > 0)
        dropdown.set_selected(0);

    return false;
}

function escapeMarkup(text) {
    return GLib.markup_escape_text(String(text ?? ''), -1);
}

// ─── EntitySearchPopover ──────────────────────────────────────────────────────

const EntitySearchPopover = GObject.registerClass(
class EntitySearchPopover extends Gtk.Popover {
    _init(onSelect) {
        super._init({ has_arrow: false });
        this._onSelect = onSelect;

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        this.set_child(box);

        this._search = new Gtk.SearchEntry({ placeholder_text: 'Filter entities…' });
        box.append(this._search);

        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 220, max_content_height: 320,
            min_content_width: 340, hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        box.append(scroll);

        this._listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: ['boxed-list'] });
        this._listBox.set_filter_func(row => this._filter(row));
        scroll.set_child(this._listBox);

        this._search.connect('search-changed', () => this._listBox.invalidate_filter());
        this._listBox.connect('row-activated', (_lb, row) => {
            this._onSelect(row._entityId);
            this.popdown();
        });
    }

    setEntities(entities) {
        let child = this._listBox.get_first_child();
        while (child) { const n = child.get_next_sibling(); this._listBox.remove(child); child = n; }

        for (const e of entities) {
            const row = new Gtk.ListBoxRow({ css_classes: ['activatable'] });
            row._entityId = e.entity_id;
            row._entityName = e.attributes?.friendly_name || e.entity_id;
            const b = new Gtk.Box({ spacing: 8, margin_top: 6, margin_bottom: 6,
                margin_start: 10, margin_end: 10 });
            b.append(new Gtk.Label({ label: row._entityName, xalign: 0, hexpand: true }));
            row.set_child(b);
            this._listBox.append(row);
        }
    }

    _filter(row) {
        const q = this._search.text.toLowerCase();
        if (!q) return true;
        return (row._entityId?.toLowerCase() ?? '').includes(q) ||
               (row._entityName?.toLowerCase() ?? '').includes(q);
    }
});

// ─── ServiceSearchPopover ─────────────────────────────────────────────────────

const ServiceSearchPopover = GObject.registerClass(
class ServiceSearchPopover extends Gtk.Popover {
    _init(onSelect) {
        super._init({ has_arrow: false });
        this._onSelect = onSelect;
        this._allServices = []; // [{domain, service}]
        this._domainFilter = null;

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        this.set_child(box);

        this._search = new Gtk.SearchEntry({ placeholder_text: 'Filter services…' });
        box.append(this._search);

        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 220, max_content_height: 320,
            min_content_width: 300, hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        box.append(scroll);

        this._listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: ['boxed-list'] });
        this._listBox.set_filter_func(row => this._filter(row));
        scroll.set_child(this._listBox);

        this._search.connect('search-changed', () => this._listBox.invalidate_filter());
        this._listBox.connect('row-activated', (_lb, row) => {
            this._onSelect(row._domain, row._service);
            this.popdown();
        });
    }

    /** Load live services from HA API response.
     *  Handles both formats:
     *   – Array: [{domain, services: {svcName: {...}}}, …]  (HA REST API)
     *   – Object: {domain: {svcName: {...}}, …}             (legacy/alt format)
     */
    setServices(apiServices) {
        this._allServices = [];
        if (Array.isArray(apiServices)) {
            for (const entry of apiServices) {
                const names = Array.isArray(entry.services)
                    ? entry.services
                    : Object.keys(entry.services ?? {});
                for (const svc of names)
                    this._allServices.push({ domain: entry.domain, service: svc });
            }
        } else if (apiServices && typeof apiServices === 'object') {
            for (const [domain, svcs] of Object.entries(apiServices))
                for (const svc of Object.keys(svcs ?? {}))
                    this._allServices.push({ domain, service: svc });
        }
        this._rebuild();
    }

    /** Fallback: use known template keys */
    setFallbackServices() {
        this._allServices = getKnownServiceKeys().map(key => {
            const [domain, ...rest] = key.split('.');
            return { domain, service: rest.join('.') };
        });
        this._rebuild();
    }

    setDomainFilter(domain) {
        this._domainFilter = domain || null;
        this._listBox.invalidate_filter();
    }

    _rebuild() {
        let child = this._listBox.get_first_child();
        while (child) { const n = child.get_next_sibling(); this._listBox.remove(child); child = n; }

        for (const { domain, service } of this._allServices) {
            const row = new Gtk.ListBoxRow({ css_classes: ['activatable'] });
            row._domain = domain;
            row._service = service;
            row._key = `${domain}.${service}`;

            const b = new Gtk.Box({ spacing: 8, margin_top: 6, margin_bottom: 6,
                margin_start: 10, margin_end: 10 });
            b.append(new Gtk.Label({ label: domain, xalign: 0,
                css_classes: ['dim-label', 'monospace'] }));
            b.append(new Gtk.Label({ label: service, xalign: 0, hexpand: true,
                css_classes: ['monospace'] }));
            row.set_child(b);
            this._listBox.append(row);
        }
    }

    _filter(row) {
        if (this._domainFilter && row._domain !== this._domainFilter) return false;
        const q = this._search.text.toLowerCase();
        if (!q) return true;
        return row._key?.includes(q) ?? false;
    }
});

// ─── EmojiPickerPopover ───────────────────────────────────────────────────────

const EmojiPickerPopover = GObject.registerClass(
class EmojiPickerPopover extends Gtk.Popover {
    _init(onSelect) {
        super._init({ has_arrow: false });
        this._onSelect = onSelect;

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8 });
        this.set_child(box);

        const search = new Gtk.SearchEntry({ placeholder_text: 'Search emoji…' });
        box.append(search);

        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 260, max_content_height: 320,
            min_content_width: 300, hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        box.append(scroll);

        const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        scroll.set_child(inner);

        this._allButtons = [];

        for (const [cat, emojis] of Object.entries(EMOJI_CATEGORIES)) {
            const catLabel = new Gtk.Label({ label: cat, xalign: 0,
                css_classes: ['heading'], margin_top: 4, margin_start: 4 });
            inner.append(catLabel);

            const flow = new Gtk.FlowBox({
                max_children_per_line: 10, min_children_per_line: 6,
                selection_mode: Gtk.SelectionMode.NONE,
                row_spacing: 2, column_spacing: 2,
            });
            inner.append(flow);

            for (const emoji of emojis) {
                const btn = new Gtk.Button({ label: emoji,
                    css_classes: ['flat'], tooltip_text: emoji });
                btn._emoji = emoji;
                btn.connect('clicked', () => { this._onSelect(emoji); this.popdown(); });
                flow.append(btn);
                this._allButtons.push(btn);
            }
        }

        search.connect('search-changed', () => {
            const q = search.text.toLowerCase();
            // Simple show/hide based on emoji unicode name lookup isn't possible here,
            // so just filter by emoji character match
            for (const btn of this._allButtons)
                btn.visible = !q || btn._emoji.includes(q);
        });
    }
});

// ─── ButtonEditDialog ─────────────────────────────────────────────────────────

const ButtonEditDialog = GObject.registerClass(
class ButtonEditDialog extends Adw.Dialog {
    _init(config, entities, services, onSave) {
        const dialogTitle = config.label
            ? `Edit "${escapeMarkup(config.label)}"`
            : 'New Button';
        super._init({ title: dialogTitle,
            content_width: 480 });

        this._config = { label: '', icon: '', color: '',
            entity_id: '', domain: '', service: '', service_data: {}, ...config };
        this._onSave = onSave;

        const page = new Adw.PreferencesPage();
        this.set_child(page);

        // ── Appearance Group ──────────────────────────────────────────
        const appearGroup = new Adw.PreferencesGroup({ title: 'Appearance' });
        page.add(appearGroup);

        // Emoji + Label row
        const labelRow = new Adw.EntryRow({ title: 'Label', text: this._config.label });
        appearGroup.add(labelRow);

        // Emoji picker button as suffix
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
        // Set initial color if configured
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
        entitySearchBtn.connect('clicked', () => this._entityPopover.popup());
        this._entityRow.connect('changed', () => {
            this._config.entity_id = this._entityRow.text;
            const domain = this._entityRow.text.split('.')[0];
            if (domain)
                this._setSelectedDomain(domain);
        });

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
        });

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

        // Service data JSON
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
    }
});

// ─── ButtonListRow ────────────────────────────────────────────────────────────

const ButtonListRow = GObject.registerClass(
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
            const dot = new Gtk.Image({ icon_name: 'circle-filled-symbolic',
                valign: Gtk.Align.CENTER });
            dot.set_style(`color: ${config.color};`);
            this.add_prefix(dot);
        }

        const editBtn = new Gtk.Button({ icon_name: 'document-edit-symbolic',
            css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Edit' });
        const deleteBtn = new Gtk.Button({ icon_name: 'user-trash-symbolic',
            css_classes: ['flat', 'destructive-action'], valign: Gtk.Align.CENTER,
            tooltip_text: 'Delete' });

        this.add_suffix(editBtn);
        this.add_suffix(deleteBtn);

        editBtn.connect('clicked', () => onEdit(index));
        deleteBtn.connect('clicked', () => onDelete(index));
    }
});

// ─── ButtonsPage ─────────────────────────────────────────────────────────────

export const ButtonsPage = GObject.registerClass(
class ButtonsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Panel Controls',
            icon_name: 'preferences-other-symbolic',
            name: 'buttons',
        });

        this._settings = settings;
        this._entities = [];
        this._services = [];
        this._configs = this._loadConfigs();

        // ── Home Assistant Sync ───────────────────────────────────────
        const haGroup = new Adw.PreferencesGroup({
            title: 'Home Assistant',
            description: 'Load entities and services to enable search in all fields below',
        });
        this.add(haGroup);

        const loadRow = new Adw.ActionRow({
            title: 'Sync Entities and Services',
            subtitle: 'Fetches live data from your Home Assistant instance',
        });
        haGroup.add(loadRow);

        this._loadBtn = new Gtk.Button({
            label: 'Load from Home Assistant',
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        loadRow.add_suffix(this._loadBtn);
        this._loadBtn.connect('clicked', () => this._loadFromHA());

        // ── Color Picker Group ────────────────────────────────────────
        const colorGroup = new Adw.PreferencesGroup({
            title: 'Color Picker',
            description: 'Entity and service called when the color is changed',
        });
        this.add(colorGroup);

        this._colorEntityRow = this._makeEntityRow(
            'Entity ID', 'color-entity', settings);
        colorGroup.add(this._colorEntityRow);

        this._colorServiceRow = this._makeServiceRow(
            'Service (domain.service)', 'color-service', settings,
            () => this._colorEntityRow.text.split('.')[0]);
        colorGroup.add(this._colorServiceRow);

        this._colorAttributeRow = new Adw.EntryRow({
            title: 'Service Data Attribute',
            text: settings.get_string('color-attribute'),
        });
        colorGroup.add(this._colorAttributeRow);
        this._colorAttributeRow.connect('changed', () =>
            settings.set_string('color-attribute', this._colorAttributeRow.text));

        // ── Slider Group ──────────────────────────────────────────────
        const sliderGroup = new Adw.PreferencesGroup({
            title: 'Slider',
            description: 'Entity and service called when the slider is moved',
        });
        this.add(sliderGroup);

        this._sliderEntityRow = this._makeEntityRow(
            'Entity ID', 'slider-entity', settings);
        sliderGroup.add(this._sliderEntityRow);

        this._sliderServiceRow = this._makeServiceRow(
            'Service (domain.service)', 'slider-service', settings,
            () => this._sliderEntityRow.text.split('.')[0]);
        sliderGroup.add(this._sliderServiceRow);

        this._sliderAttributeRow = new Adw.EntryRow({
            title: 'Service Data Attribute',
            text: settings.get_string('slider-attribute'),
        });
        sliderGroup.add(this._sliderAttributeRow);
        this._sliderAttributeRow.connect('changed', () =>
            settings.set_string('slider-attribute', this._sliderAttributeRow.text));

        const sliderRangeRow = new Adw.ActionRow({ title: 'Range (min / max)' });
        const sliderMinSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: -10000, upper: 10000, step_increment: 1,
                value: settings.get_double('slider-min'),
            }),
            digits: 0, valign: Gtk.Align.CENTER,
        });
        const sliderMaxSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: -10000, upper: 10000, step_increment: 1,
                value: settings.get_double('slider-max'),
            }),
            digits: 0, valign: Gtk.Align.CENTER,
        });
        sliderRangeRow.add_suffix(sliderMinSpin);
        sliderRangeRow.add_suffix(new Gtk.Label({ label: '–', valign: Gtk.Align.CENTER }));
        sliderRangeRow.add_suffix(sliderMaxSpin);
        sliderGroup.add(sliderRangeRow);

        sliderMinSpin.connect('value-changed', () =>
            settings.set_double('slider-min', sliderMinSpin.value));
        sliderMaxSpin.connect('value-changed', () =>
            settings.set_double('slider-max', sliderMaxSpin.value));

        // ── Action Buttons Group ──────────────────────────────────────
        this._buttonsGroup = new Adw.PreferencesGroup({ title: 'Action Buttons' });
        this.add(this._buttonsGroup);

        // Header: Add button
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['suggested-action', 'circular'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add button',
        });
        this._buttonsGroup.set_header_suffix(addBtn);
        addBtn.connect('clicked', () => this._openEditDialog(null, null));

        this._rebuildList();
    }

    // ── Helper: entity row with search lupe ──────────────────────────

    _makeEntityRow(title, settingKey, settings) {
        const row = new Adw.EntryRow({ title, text: settings.get_string(settingKey) });

        const btn = new Gtk.Button({ icon_name: 'system-search-symbolic',
            valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse entities' });
        row.add_suffix(btn);

        const popover = new EntitySearchPopover(entityId => {
            row.text = entityId;
            settings.set_string(settingKey, entityId);
        });
        popover.set_parent(btn);
        row._entityPopover = popover;

        btn.connect('clicked', () => popover.popup());
        row.connect('changed', () => settings.set_string(settingKey, row.text));

        return row;
    }

    // ── Helper: service row with search lupe ─────────────────────────

    _makeServiceRow(title, settingKey, settings, getDomain) {
        const row = new Adw.EntryRow({ title, text: settings.get_string(settingKey) });

        const btn = new Gtk.Button({ icon_name: 'system-search-symbolic',
            valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse services' });
        row.add_suffix(btn);

        const popover = new ServiceSearchPopover((domain, service) => {
            row.text = `${domain}.${service}`;
            settings.set_string(settingKey, `${domain}.${service}`);
        });
        popover.setFallbackServices();
        popover.set_parent(btn);
        row._servicePopover = popover;

        btn.connect('clicked', () => {
            popover.setDomainFilter(getDomain());
            popover.popup();
        });
        row.connect('changed', () => settings.set_string(settingKey, row.text));

        return row;
    }

    // ── Update popovers with fresh HA data ───────────────────────────

    _distributeEntities() {
        this._colorEntityRow._entityPopover?.setEntities(this._entities);
        this._sliderEntityRow._entityPopover?.setEntities(this._entities);
    }

    _distributeServices() {
        const hasSvc = this._services.length > 0;
        if (hasSvc) {
            this._colorServiceRow._servicePopover?.setServices(this._services);
            this._sliderServiceRow._servicePopover?.setServices(this._services);
        }
    }

    // ── Button list ──────────────────────────────────────────────────

    _rebuildList() {
        // Remove old button rows (skip header)
        if (this._buttonListRows) {
            for (const r of this._buttonListRows)
                this._buttonsGroup.remove(r);
        }
        this._buttonListRows = [];

        for (let i = 0; i < this._configs.length; i++) {
            const row = new ButtonListRow(
                this._configs[i], i,
                idx => this._openEditDialog(idx, this._configs[idx]),
                idx => this._deleteButton(idx)
            );
            this._buttonsGroup.add(row);
            this._buttonListRows.push(row);
        }
    }

    _openEditDialog(index, config) {
        const isNew = index === null;
        const dialog = new ButtonEditDialog(
            config ?? {},
            this._entities,
            this._services,
            saved => {
                if (isNew)
                    this._configs.push(saved);
                else
                    this._configs[index] = saved;
                this._saveConfigs();
                this._rebuildList();
            }
        );
        dialog.present(this.get_root());
    }

    _deleteButton(index) {
        this._configs.splice(index, 1);
        this._saveConfigs();
        this._rebuildList();
    }

    _loadConfigs() {
        try { return JSON.parse(this._settings.get_string('buttons-config')); }
        catch { return []; }
    }

    _saveConfigs() {
        this._settings.set_int('button-count', this._configs.length);
        this._settings.set_string('buttons-config', JSON.stringify(this._configs));
    }

    async _loadFromHA() {
        this._loadBtn.sensitive = false;
        this._loadBtn.label = 'Loading…';

        const client = new HaClient();
        client.setCredentials(
            this._settings.get_string('ha-url'),
            this._settings.get_string('ha-token'),
            this._settings.get_boolean('ha-verify-ssl')
        );

        try {
            [this._entities, this._services] = await Promise.all([
                client.fetchEntities(),
                client.fetchServices(),
            ]);
            this._distributeEntities();
            this._distributeServices();
            this._loadBtn.label = `✓ ${this._entities.length} entities, ${this._services.length} domains`;
        } catch (e) {
            this._loadBtn.label = `Error: ${e.message}`;
            console.error('[RoomPanel] Load from HA failed:', e.message);
        } finally {
            this._loadBtn.sensitive = true;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                this._loadBtn.label = 'Load from Home Assistant';
                return GLib.SOURCE_REMOVE;
            });
            client.destroy();
        }
    }
});
