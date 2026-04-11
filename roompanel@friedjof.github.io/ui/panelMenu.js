import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import { ActionButton } from './actionButton.js';
import { ColorWheel, rgbToHex } from './colorWheel.js';
import { hexToRgb, loadColorHistory, pushColorToHistory, saveColorHistory } from '../lib/colorHistory.js';

function entityMatchesDomain(entityId, domain) {
    return Boolean(entityId) && Boolean(domain) && entityId.split('.')[0] === domain;
}

/**
 * The dropdown menu content:
 *  ─ Color section (circular color wheel)
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
        this._copyResetSourceId = null;
        this._colorHistory = loadColorHistory();

        this._buildUI();
        this._connectSettings();
    }

    _buildUI() {
        // ── Color Section ──────────────────────────────────────────────
        this._colorItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.addMenuItem(this._colorItem);

        const colorBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        colorBox.add_style_class_name('roompanel-menu');
        this._colorItem.add_child(colorBox);

        const colorHeader = new St.BoxLayout({
            vertical: false,
            style_class: 'roompanel-color-header',
            x_expand: true,
        });
        colorBox.add_child(colorHeader);

        const colorLabel = new St.Label({
            text: 'Color',
            style_class: 'roompanel-section-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        colorHeader.add_child(colorLabel);

        this._colorValue = new St.Label({
            text: '#ffffff',
            style_class: 'roompanel-color-value',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        colorHeader.add_child(this._colorValue);

        this._colorPreview = new St.Widget({
            style_class: 'roompanel-color-preview',
            style: 'background-color: #ffffff;',
        });
        colorHeader.add_child(this._colorPreview);

        this._colorWheel = new ColorWheel();
        this._colorWheel.connect('color-changed', () => this._queueColorChanged());
        this._colorWheel.connect('color-selected', () => this._commitSelectedColor());

        this._copyButtonIcon = new St.Icon({
            icon_name: 'edit-copy-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._copyButton = new St.Button({
            style_class: 'button roompanel-icon-button',
            can_focus: true,
            reactive: true,
        });
        this._copyButton.set_child(this._copyButtonIcon);
        this._copyButton.connect('clicked', () => this._copyCurrentColor());
        colorHeader.add_child(this._copyButton);

        const colorBody = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-color-body',
        });
        colorBox.add_child(colorBody);

        colorBody.add_child(this._colorWheel);

        this._historyBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-color-history',
        });
        colorBody.add_child(this._historyBox);
        this._updateColorPreview(this._colorWheel.getColor());
        this._rebuildColorHistory();

        // ── Separator ─────────────────────────────────────────────────
        this._colorSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._colorSeparator.add_style_class_name('roompanel-separator');
        this.addMenuItem(this._colorSeparator);

        // ── Slider Section ────────────────────────────────────────────
        this._sliderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.addMenuItem(this._sliderItem);

        const sliderBox = new St.BoxLayout({ vertical: true, x_expand: true });
        sliderBox.add_style_class_name('roompanel-menu');
        this._sliderItem.add_child(sliderBox);

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
                void this._onSliderChanged();
                this._sliderSourceId = null;
                return GLib.SOURCE_REMOVE;
            });
        });

        // ── Separator ─────────────────────────────────────────────────
        this._sliderSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._sliderSeparator.add_style_class_name('roompanel-separator');
        this.addMenuItem(this._sliderSeparator);

        // ── Action Buttons ────────────────────────────────────────────
        this._buttonsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.addMenuItem(this._buttonsItem);

        this._buttonsBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        this._buttonsBox.add_style_class_name('roompanel-menu');
        this._buttonsBox.add_style_class_name('roompanel-buttons-box');
        this._buttonsItem.add_child(this._buttonsBox);

        this._rebuildButtons();
    }

    _connectSettings() {
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'buttons-config' || key === 'button-count')
                this._rebuildButtons();

            if (key === 'color-entity' || key === 'slider-entity')
                this._syncSectionVisibility();
        });

        this._syncSectionVisibility();
    }

    _syncSectionVisibility() {
        const showColor = this._settings.get_string('color-entity').trim() !== '';
        const showSlider = this._settings.get_string('slider-entity').trim() !== '';
        const showButtons = true;

        this._colorItem.visible = showColor;
        this._sliderItem.visible = showSlider;
        this._colorSeparator.visible = showColor && (showSlider || showButtons);
        this._sliderSeparator.visible = showSlider && showButtons;
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

        for (let i = 0; i < slice.length; i += 2) {
            const row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'roompanel-button-row',
            });

            for (const config of slice.slice(i, i + 2)) {
                const btn = new ActionButton(config, this._haClient);
                row.add_child(btn);
            }

            this._buttonsBox.add_child(row);
        }
    }

    _updateColorPreview(rgb) {
        const hex = rgbToHex(rgb);
        this._colorValue.text = hex;
        this._colorPreview.set_style(`background-color: ${hex};`);
    }

    _copyCurrentColor() {
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, this._colorValue.text);

        this._copyButtonIcon.icon_name = 'object-select-symbolic';
        if (this._copyResetSourceId) {
            GLib.source_remove(this._copyResetSourceId);
            this._copyResetSourceId = null;
        }

        this._copyResetSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._copyButtonIcon.icon_name = 'edit-copy-symbolic';
            this._copyResetSourceId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildColorHistory() {
        const children = this._historyBox.get_children();
        for (const child of children)
            this._historyBox.remove_child(child);

        if (this._colorHistory.length === 0) {
            const placeholder = new St.Label({
                text: 'Recent colors appear here',
                style_class: 'roompanel-history-placeholder',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._historyBox.add_child(placeholder);
            return;
        }

        for (const hex of this._colorHistory) {
            const swatch = new St.Button({
                style_class: 'button roompanel-history-swatch',
                can_focus: true,
                reactive: true,
            });
            swatch.set_style(`background-color: ${hex};`);
            swatch.connect('clicked', () => this._applyHistoryColor(hex));
            this._historyBox.add_child(swatch);
        }
    }

    _rememberColor(rgb) {
        const nextHistory = pushColorToHistory(this._colorHistory, rgb);
        if (JSON.stringify(nextHistory) === JSON.stringify(this._colorHistory))
            return;

        this._colorHistory = nextHistory;
        saveColorHistory(this._colorHistory);
        this._rebuildColorHistory();
    }

    _applyHistoryColor(hex) {
        const rgb = hexToRgb(hex);
        if (!rgb)
            return;

        if (this._colorSourceId) {
            GLib.source_remove(this._colorSourceId);
            this._colorSourceId = null;
        }

        this._colorWheel.setColor(rgb);
        this._updateColorPreview(rgb);
        this._rememberColor(rgb);
        void this._sendColor(rgb);
    }

    _queueColorChanged() {
        this._updateColorPreview(this._colorWheel.getColor());

        if (this._colorSourceId) {
            GLib.source_remove(this._colorSourceId);
            this._colorSourceId = null;
        }

        this._colorSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            void this._onColorChanged();
            this._colorSourceId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _commitSelectedColor() {
        const rgb = this._colorWheel.getColor();
        if (this._colorSourceId) {
            GLib.source_remove(this._colorSourceId);
            this._colorSourceId = null;
        }

        this._rememberColor(rgb);
        void this._sendColor(rgb);
    }

    async _onColorChanged() {
        await this._sendColor(this._colorWheel.getColor());
    }

    async _sendColor(rgb) {
        const entity = this._settings.get_string('color-entity');
        const service = this._settings.get_string('color-service');
        const attribute = this._settings.get_string('color-attribute');
        if (!entity || !service)
            return;

        const [domain, svc] = service.split('.');
        if (!entityMatchesDomain(entity, domain)) {
            console.error(`[RoomPanel] Color call skipped: entity "${entity}" does not match service domain "${domain}"`);
            return;
        }

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
        if (!entity || !service)
            return;

        const min = this._settings.get_double('slider-min');
        const max = this._settings.get_double('slider-max');
        const value = Math.round(min + this._slider.value * (max - min));

        const [domain, svc] = service.split('.');
        if (!entityMatchesDomain(entity, domain)) {
            console.error(`[RoomPanel] Slider call skipped: entity "${entity}" does not match service domain "${domain}"`);
            return;
        }

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
        if (this._copyResetSourceId) {
            GLib.source_remove(this._copyResetSourceId);
            this._copyResetSourceId = null;
        }
        super.destroy();
    }
}
