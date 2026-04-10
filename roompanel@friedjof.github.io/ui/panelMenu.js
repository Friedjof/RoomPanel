import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import { ActionButton } from './actionButton.js';

/**
 * The dropdown menu content:
 *  ─ Color section (hex input + color preview box)
 *  ─ Slider section
 *  ─ Action buttons
 */
export class RoomPanelMenu extends PopupMenu.PopupMenuSection {
    constructor(settings, haClient) {
        super();

        this._settings = settings;
        this._haClient = haClient;
        this._sliderSourceId = null;
        this._colorSourceId = null;

        this._buildUI();
        this._connectSettings();
    }

    _buildUI() {
        // ── Color Section ──────────────────────────────────────────────
        const colorItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.addMenuItem(colorItem);

        const colorBox = new St.BoxLayout({
            vertical: false,
            style_class: 'roompanel-menu',
            x_expand: true,
        });
        colorItem.add_child(colorBox);

        const colorLabel = new St.Label({
            text: 'Color',
            style_class: 'roompanel-section-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        colorBox.add_child(colorLabel);

        this._hexEntry = new St.Entry({
            style_class: 'roompanel-hex-entry',
            hint_text: '#rrggbb',
            can_focus: true,
            x_expand: true,
        });
        colorBox.add_child(this._hexEntry);

        this._colorPreview = new St.Widget({
            style_class: 'roompanel-color-preview',
            style: 'background-color: #ffffff;',
        });
        colorBox.add_child(this._colorPreview);

        this._hexEntry.clutter_text.connect('text-changed', () => {
            if (this._colorSourceId) {
                GLib.source_remove(this._colorSourceId);
                this._colorSourceId = null;
            }
            this._colorSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._onColorChanged();
                this._colorSourceId = null;
                return GLib.SOURCE_REMOVE;
            });
        });

        // ── Separator ─────────────────────────────────────────────────
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Slider Section ────────────────────────────────────────────
        const sliderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.addMenuItem(sliderItem);

        const sliderBox = new St.BoxLayout({ vertical: true, x_expand: true });
        sliderItem.add_child(sliderBox);

        const sliderLabel = new St.Label({
            text: 'Value',
            style_class: 'roompanel-section-label',
        });
        sliderBox.add_child(sliderLabel);

        this._slider = new Slider.Slider(0.5);
        sliderBox.add_child(this._slider);

        this._slider.connect('notify::value', () => {
            if (this._sliderSourceId) {
                GLib.source_remove(this._sliderSourceId);
                this._sliderSourceId = null;
            }
            this._sliderSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._onSliderChanged();
                this._sliderSourceId = null;
                return GLib.SOURCE_REMOVE;
            });
        });

        // ── Separator ─────────────────────────────────────────────────
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Action Buttons ────────────────────────────────────────────
        this._buttonsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.addMenuItem(this._buttonsItem);

        this._buttonsBox = new St.BoxLayout({
            vertical: false,
            style_class: 'roompanel-buttons-box',
            x_expand: true,
        });
        this._buttonsItem.add_child(this._buttonsBox);

        this._rebuildButtons();
    }

    _connectSettings() {
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'buttons-config' || key === 'button-count')
                this._rebuildButtons();
        });
    }

    _rebuildButtons() {
        const children = this._buttonsBox.get_children();
        for (const child of children)
            this._buttonsBox.remove_child(child);

        let configs = [];
        try {
            configs = JSON.parse(this._settings.get_string('buttons-config'));
        } catch {
            configs = [];
        }

        const count = this._settings.get_int('button-count');
        const slice = configs.slice(0, count);

        if (slice.length === 0) {
            const placeholder = new St.Label({
                text: 'No buttons configured',
                style: 'color: rgba(255,255,255,0.4); padding: 4px;',
            });
            this._buttonsBox.add_child(placeholder);
            return;
        }

        for (const config of slice) {
            const btn = new ActionButton(config, this._haClient);
            this._buttonsBox.add_child(btn);
        }
    }

    _hexToRgb(hex) {
        const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    async _onColorChanged() {
        const hex = this._hexEntry.get_text().trim();
        const rgb = this._hexToRgb(hex);
        if (!rgb) return;

        this._colorPreview.set_style(
            `background-color: ${hex.startsWith('#') ? hex : '#' + hex};`
        );

        const entity = this._settings.get_string('color-entity');
        const service = this._settings.get_string('color-service');
        const attribute = this._settings.get_string('color-attribute');
        if (!entity || !service) return;

        const [domain, svc] = service.split('.');
        try {
            await this._haClient.callService(domain, svc,
                { entity_id: entity, [attribute]: rgb });
        } catch (e) {
            console.error('[RoomPanel] Color call failed:', e.message);
        }
    }

    async _onSliderChanged() {
        const entity = this._settings.get_string('slider-entity');
        const service = this._settings.get_string('slider-service');
        const attribute = this._settings.get_string('slider-attribute');
        if (!entity || !service) return;

        const min = this._settings.get_double('slider-min');
        const max = this._settings.get_double('slider-max');
        const value = Math.round(min + this._slider.value * (max - min));

        const [domain, svc] = service.split('.');
        try {
            await this._haClient.callService(domain, svc,
                { entity_id: entity, [attribute]: value });
        } catch (e) {
            console.error('[RoomPanel] Slider call failed:', e.message);
        }
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._sliderSourceId) {
            GLib.source_remove(this._sliderSourceId);
            this._sliderSourceId = null;
        }
        if (this._colorSourceId) {
            GLib.source_remove(this._colorSourceId);
            this._colorSourceId = null;
        }
        super.destroy();
    }
}
