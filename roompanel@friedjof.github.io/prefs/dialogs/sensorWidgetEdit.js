import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { escapeMarkup } from '../utils.js';
import { EntitySearchPopover } from '../popovers/entitySearch.js';

// ── Widget-type helpers ───────────────────────────────────────────────────────

const WIDGET_TYPES  = ['Value', 'Trend', 'Gauge'];
const SPAN_OPTIONS  = ['Half', 'Full'];

function typeIndex(widgetType) {
    const idx = WIDGET_TYPES.map(t => t.toLowerCase()).indexOf((widgetType ?? 'value').toLowerCase());
    return idx >= 0 ? idx : 0;
}

function spanIndex(span) {
    return span === 'full' ? 1 : 0;
}

/** Build a severity array from two threshold values and min/max range. */
function buildSeverity(min, max, warnFrom, alertFrom) {
    return [
        { from: min,       to: warnFrom,  color: 'ok'    },
        { from: warnFrom,  to: alertFrom, color: 'warn'  },
        { from: alertFrom, to: max,       color: 'alert' },
    ];
}

/** Extract the warn/alert "starts-at" values from a stored severity array. */
function parseSeverityThresholds(severity, min, max) {
    if (!Array.isArray(severity) || severity.length < 2)
        return { warnFrom: min + (max - min) * 0.6, alertFrom: min + (max - min) * 0.8 };
    const warn  = severity.find(z => z.color === 'warn');
    const alert = severity.find(z => z.color === 'alert');
    return {
        warnFrom:  warn  ? Number(warn.from)  : min + (max - min) * 0.6,
        alertFrom: alert ? Number(alert.from) : min + (max - min) * 0.8,
    };
}

// ── SensorWidgetRow ───────────────────────────────────────────────────────────

export const SensorWidgetRow = GObject.registerClass(
class SensorWidgetRow extends Adw.ActionRow {
    _init(config, index, onEdit, onDelete) {
        const typeLabel = (config.widget_type ?? 'value').charAt(0).toUpperCase()
                        + (config.widget_type ?? 'value').slice(1);
        const title    = escapeMarkup(config.display_name || config.entity_id || `Widget ${index + 1}`);
        const subtitle = escapeMarkup(
            [
                config.display_name ? config.entity_id : null,
                typeLabel,
                config.span === 'full' ? 'full-width' : null,
            ]
            .filter(Boolean).join(' · ')
        );

        super._init({ title, subtitle, activatable: false });

        const editBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Edit',
        });
        const deleteBtn = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            css_classes: ['destructive-action'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Delete',
        });

        this.add_suffix(editBtn);
        this.add_suffix(deleteBtn);

        editBtn.connect('clicked', () => onEdit(index));
        deleteBtn.connect('clicked', () => onDelete(index));
    }
});

// ── SensorWidgetDialog ────────────────────────────────────────────────────────

export const SensorWidgetDialog = GObject.registerClass(
class SensorWidgetDialog extends Adw.Dialog {
    _init(config, entities, onSave) {
        const isNew = !config.entity_id;
        super._init({
            title: isNew ? 'New Sensor Widget' : `Edit "${escapeMarkup(config.entity_id)}"`,
            content_width: 460,
        });

        this._onSave = onSave;

        // Work on a mutable copy with defaults
        this._cfg = {
            entity_id:     '',
            display_name:  '',
            widget_type:   'value',
            attribute:     '',
            unit_override: '',
            icon:          '',
            span:          'half',
            min:           0,
            max:           100,
            severity:      null,
            ...config,
        };

        const page = new Adw.PreferencesPage();
        this.set_child(page);

        // ── Entity group ──────────────────────────────────────────────
        const entityGroup = new Adw.PreferencesGroup({ title: 'Entity' });
        page.add(entityGroup);

        this._entityRow = new Adw.EntryRow({
            title: 'Entity ID',
            text: this._cfg.entity_id,
        });
        entityGroup.add(this._entityRow);

        this._displayNameRow = new Adw.EntryRow({
            title: 'Display name',
            text: this._cfg.display_name ?? '',
        });
        this._displayNameRow.set_tooltip_text('Optional label shown on the tile (overrides friendly name from HA)');
        entityGroup.add(this._displayNameRow);
        this._displayNameRow.connect('changed', () => {
            this._cfg.display_name = this._displayNameRow.text.trim() || null;
        });

        const searchBtn = new Gtk.Button({
            icon_name: 'system-search-symbolic',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Browse entities',
        });
        this._entityRow.add_suffix(searchBtn);

        this._entityPopover = new EntitySearchPopover(entityId => {
            this._entityRow.text = entityId;
            this._cfg.entity_id  = entityId;
        });
        this._entityPopover.set_parent(searchBtn);
        if (entities?.length)
            this._entityPopover.setEntities(entities);
        searchBtn.connect('clicked', () => this._entityPopover.popup());
        this._entityRow.connect('changed', () => {
            this._cfg.entity_id = this._entityRow.text;
        });

        // ── Widget group ──────────────────────────────────────────────
        const widgetGroup = new Adw.PreferencesGroup({ title: 'Widget' });
        page.add(widgetGroup);

        // Widget type
        const typeRow = new Adw.ActionRow({ title: 'Widget Type' });
        widgetGroup.add(typeRow);

        this._typeDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(WIDGET_TYPES),
            selected: typeIndex(this._cfg.widget_type),
            valign: Gtk.Align.CENTER,
        });
        typeRow.add_suffix(this._typeDropdown);
        typeRow.activatable_widget = this._typeDropdown;

        // Span
        const spanRow = new Adw.ActionRow({ title: 'Width' });
        widgetGroup.add(spanRow);

        this._spanDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(SPAN_OPTIONS),
            selected: spanIndex(this._cfg.span),
            valign: Gtk.Align.CENTER,
        });
        spanRow.add_suffix(this._spanDropdown);
        spanRow.activatable_widget = this._spanDropdown;

        // ── Display group ─────────────────────────────────────────────
        const displayGroup = new Adw.PreferencesGroup({ title: 'Display' });
        page.add(displayGroup);

        this._attributeRow = new Adw.EntryRow({
            title: 'Attribute',
            text: this._cfg.attribute ?? '',
            show_apply_button: false,
        });
        this._attributeRow.set_tooltip_text('Leave empty to use entity state value');
        displayGroup.add(this._attributeRow);
        this._attributeRow.connect('changed', () => {
            this._cfg.attribute = this._attributeRow.text.trim() || null;
        });

        this._unitRow = new Adw.EntryRow({
            title: 'Unit override',
            text: this._cfg.unit_override ?? '',
        });
        this._unitRow.set_tooltip_text('Leave empty to use unit from HA (e.g. °C, %, W)');
        displayGroup.add(this._unitRow);
        this._unitRow.connect('changed', () => {
            this._cfg.unit_override = this._unitRow.text.trim() || null;
        });

        this._iconRow = new Adw.EntryRow({
            title: 'Icon override',
            text: this._cfg.icon ?? '',
        });
        this._iconRow.set_tooltip_text('GNOME symbolic icon name, e.g. thermometer-symbolic');
        displayGroup.add(this._iconRow);
        this._iconRow.connect('changed', () => {
            this._cfg.icon = this._iconRow.text.trim() || null;
        });

        // ── Gauge group (shown only for gauge type) ───────────────────
        this._gaugeGroup = new Adw.PreferencesGroup({ title: 'Gauge' });
        page.add(this._gaugeGroup);

        this._minRow = new Adw.EntryRow({
            title: 'Minimum',
            text: String(this._cfg.min ?? 0),
        });
        this._gaugeGroup.add(this._minRow);

        this._maxRow = new Adw.EntryRow({
            title: 'Maximum',
            text: String(this._cfg.max ?? 100),
        });
        this._gaugeGroup.add(this._maxRow);

        // Severity thresholds
        const { warnFrom, alertFrom } = parseSeverityThresholds(
            this._cfg.severity,
            Number(this._cfg.min ?? 0),
            Number(this._cfg.max ?? 100)
        );

        this._warnRow = new Adw.EntryRow({
            title: 'Warn starts at',
            text: String(warnFrom),
        });
        this._gaugeGroup.add(this._warnRow);

        this._alertRow = new Adw.EntryRow({
            title: 'Alert starts at',
            text: String(alertFrom),
        });
        this._gaugeGroup.add(this._alertRow);

        // Show/hide gauge group based on type
        this._updateGaugeVisibility(typeIndex(this._cfg.widget_type));
        this._typeDropdown.connect('notify::selected', () => {
            this._updateGaugeVisibility(this._typeDropdown.selected);
        });

        // ── Footer ────────────────────────────────────────────────────
        const cancelBtn = new Gtk.Button({ label: 'Cancel', hexpand: true });
        const saveBtn   = new Gtk.Button({
            label: 'Save',
            css_classes: ['suggested-action'],
            hexpand: true,
        });
        const btnBox = new Gtk.Box({
            spacing: 8,
            margin_top: 12,
            margin_start: 16,
            margin_end: 16,
            margin_bottom: 16,
        });
        btnBox.append(cancelBtn);
        btnBox.append(saveBtn);
        page.add(new Adw.PreferencesGroup({ header_suffix: btnBox }));

        cancelBtn.connect('clicked', () => this.close());
        saveBtn.connect('clicked', () => {
            this._collectAndSave();
            this.close();
        });
    }

    _updateGaugeVisibility(typeIdx) {
        this._gaugeGroup.visible = typeIdx === 2; // 'Gauge'
    }

    _collectAndSave() {
        const typeIdx = this._typeDropdown.selected;
        this._cfg.widget_type = WIDGET_TYPES[typeIdx].toLowerCase();
        this._cfg.span        = SPAN_OPTIONS[this._spanDropdown.selected].toLowerCase();

        if (typeIdx === 2) { // gauge
            const min      = Number(this._minRow.text)   || 0;
            const max      = Number(this._maxRow.text)   || 100;
            const warnFrom = Number(this._warnRow.text);
            const alertFrom = Number(this._alertRow.text);
            this._cfg.min      = min;
            this._cfg.max      = max;
            this._cfg.severity = buildSeverity(min, max, warnFrom, alertFrom);
        } else {
            this._cfg.min      = null;
            this._cfg.max      = null;
            this._cfg.severity = null;
        }

        this._onSave({ ...this._cfg });
    }
});
