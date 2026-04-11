import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { ActionButton } from './actionButton.js';
import { ColorWheel, rgbToHex } from './colorWheel.js';
import { DimmerSlider } from './dimmerSlider.js';
import { hexToRgb, loadColorHistory, pushColorToHistory, saveColorHistory } from '../lib/colorHistory.js';

function entityMatchesDomain(entityId, domain) {
    return Boolean(entityId) && Boolean(domain) && entityId.split('.')[0] === domain;
}

function formatEntityLabel(entityId) {
    const value = String(entityId ?? '').trim();
    if (!value)
        return 'No entity selected';

    const separatorIndex = value.indexOf('.');
    const objectId = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
    return objectId
        .split('_')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function buildColorPreviewStyle(hex) {
    return `background-color: ${hex}; width: 26px; height: 26px; min-width: 26px; min-height: 26px; border-radius: 999px; border: 2px solid rgba(255, 255, 255, 0.3);`;
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

        // Feedback-loop protection: after the user sends a command we suppress
        // incoming HA state updates for this many milliseconds so the UI does
        // not jump back to the "old" value that HA briefly echoes.
        this._suppressLiveUntil = 0;

        this._buildUI();
        this._connectSettings();
        this._initLiveSync();
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

        // Top row: "Color" + entity name (left, expands) | preview + copy (right-aligned)
        const colorTopRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-color-header',
        });
        colorBox.add_child(colorTopRow);

        const colorInfoBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-color-info',
        });
        colorTopRow.add_child(colorInfoBox);

        const colorLabel = new St.Label({
            text: 'Color',
            style_class: 'roompanel-section-label',
        });
        colorInfoBox.add_child(colorLabel);

        this._colorEntityLabel = new St.Label({
            text: '',
            style_class: 'roompanel-entity-label',
            x_expand: true,
        });
        colorInfoBox.add_child(this._colorEntityLabel);

        // Preview + hex + copy — right side of the header row
        const currentColorBox = new St.BoxLayout({
            vertical: false,
            style_class: 'roompanel-current-color',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        colorTopRow.add_child(currentColorBox);

        this._colorPreview = new St.Widget({
            style_class: 'roompanel-color-preview',
            y_align: Clutter.ActorAlign.CENTER,
            style: buildColorPreviewStyle('#ffffff'),
        });
        currentColorBox.add_child(this._colorPreview);

        this._colorValue = new St.Label({
            text: '#ffffff',
            style_class: 'roompanel-color-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        currentColorBox.add_child(this._colorValue);

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
        currentColorBox.add_child(this._copyButton);

        // Body row: color wheel (left) + right column with history (right, centered)
        const colorBody = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-color-body',
        });
        colorBox.add_child(colorBody);

        this._colorWheel = new ColorWheel();
        this._colorWheel.connect('color-changed', () => this._queueColorChanged());
        this._colorWheel.connect('color-selected', () => this._commitSelectedColor());
        colorBody.add_child(this._colorWheel);

        const colorRightCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-color-right',
        });
        colorBody.add_child(colorRightCol);

        this._historyLabel = new St.Label({
            text: 'History',
            style_class: 'roompanel-history-title',
        });
        colorRightCol.add_child(this._historyLabel);

        this._historyBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-color-history',
        });
        colorRightCol.add_child(this._historyBox);

        this._updateColorPreview(this._colorWheel.getColor());
        this._updateColorEntityLabel();
        this._rebuildColorHistory();

        // ── Slider Section (no separator above — saves vertical space) ──
        this._sliderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.addMenuItem(this._sliderItem);

        const sliderBox = new St.BoxLayout({ vertical: true, x_expand: true });
        sliderBox.add_style_class_name('roompanel-menu');
        this._sliderItem.add_child(sliderBox);

        this._sliderLabel = new St.Label({
            text: 'Value',
            style_class: 'roompanel-section-label',
        });
        sliderBox.add_child(this._sliderLabel);

        this._slider = new DimmerSlider();
        sliderBox.add_child(this._slider);

        // value-changed only fires from user interaction (not from .value setter)
        this._slider.connect('value-changed', () => {
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

            if (key === 'color-entity' || key === 'slider-entity') {
                this._syncSectionVisibility();
                // Re-hydrate initial state when entity assignment changes
                this._hydrateInitialState();
            }

            if (key === 'color-entity')
                this._updateColorEntityLabel();

            if (key === 'slider-entity')
                this._updateSliderLabel();
        });

        this._syncSectionVisibility();
        this._updateColorEntityLabel();
        this._updateSliderLabel();
    }

    // ── Live sync ────────────────────────────────────────────────────────────

    _initLiveSync() {
        this._haClient.connectLive(data => this._onLiveStateChanged(data));
        // Hydrate slider + color wheel with current HA state on startup
        this._hydrateInitialState();
    }

    /**
     * Fetch the current HA state once and push it into the UI.
     * Called on startup and whenever the watched entities change.
     */
    async _hydrateInitialState() {
        const colorEntity = this._settings.get_string('color-entity').trim();
        const sliderEntity = this._settings.get_string('slider-entity').trim();

        if (colorEntity) {
            try {
                const state = await this._haClient.getState(colorEntity);
                this._applyColorState(state);
            } catch { /* entity not found or no connection yet */ }
        }

        if (sliderEntity) {
            try {
                const state = await this._haClient.getState(sliderEntity);
                this._applySliderState(state);
            } catch { /* entity not found or no connection yet */ }
        }
    }

    /**
     * Incoming state_changed event from HA.
     * Ignored for a short window after the user interacted (echo suppression).
     */
    _onLiveStateChanged({ entity_id, new_state }) {
        if (!new_state) return;

        const colorEntity = this._settings.get_string('color-entity').trim();
        const sliderEntity = this._settings.get_string('slider-entity').trim();

        if (entity_id === sliderEntity) {
            const suppressed = Date.now() < this._suppressLiveUntil;
            console.log(`[RoomPanel] slider live event: ${entity_id}, suppressed=${suppressed}, attrs=${JSON.stringify(new_state?.attributes)}`);
        }

        if (Date.now() < this._suppressLiveUntil) return;

        // Both checks independent — same entity can drive color AND slider
        if (entity_id === colorEntity)
            this._applyColorState(new_state);
        if (entity_id === sliderEntity)
            this._applySliderState(new_state);
    }

    /** Push a fresh HA color state into the wheel + preview. */
    _applyColorState(state) {
        const rgb = state?.attributes?.rgb_color;
        // Only handle rgb_color for now; hs_color / xy_color ignored in v1
        if (!Array.isArray(rgb) || rgb.length < 3) return;
        const clamped = rgb.map(v => Math.max(0, Math.min(255, Math.round(v))));
        this._colorWheel.setColor(clamped);
        this._updateColorPreview(clamped);
    }

    /** Push a fresh HA slider state into the Slider widget. */
    _applySliderState(state) {
        const attribute = this._settings.get_string('slider-attribute').trim();
        if (!attribute || !state?.attributes) {
            console.log(`[RoomPanel] applySlider: skipped — attr='${attribute}', hasAttrs=${!!state?.attributes}`);
            return;
        }

        const raw = state.attributes[attribute];
        if (raw === undefined || raw === null) {
            console.log(`[RoomPanel] applySlider: attr '${attribute}' not in state (available: ${Object.keys(state.attributes ?? {}).join(', ')})`);
            return;
        }

        const min = this._settings.get_double('slider-min');
        const max = this._settings.get_double('slider-max');
        if (max <= min) {
            console.log(`[RoomPanel] applySlider: invalid range min=${min} max=${max}`);
            return;
        }

        const normalized = Math.max(0, Math.min(1, (Number(raw) - min) / (max - min)));
        console.log(`[RoomPanel] applySlider: attr=${attribute} raw=${raw} min=${min} max=${max} normalized=${normalized}`);
        // Setter never emits value-changed, so no feedback loop possible
        this._slider.value = normalized;
    }

    /** Call before every user-initiated HA command to suppress echo-updates. */
    _markUserCommand() {
        this._suppressLiveUntil = Date.now() + 2000;
    }

    _syncSectionVisibility() {
        const showColor = this._settings.get_string('color-entity').trim() !== '';
        const showSlider = this._settings.get_string('slider-entity').trim() !== '';

        this._colorItem.visible = showColor;
        this._sliderItem.visible = showSlider;
        this._sliderSeparator.visible = showSlider;
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
        this._colorPreview.set_style(buildColorPreviewStyle(hex));
    }

    _updateColorEntityLabel() {
        this._colorEntityLabel.text = formatEntityLabel(this._settings.get_string('color-entity'));
    }

    _updateSliderLabel() {
        const entity = this._settings.get_string('slider-entity').trim();
        const name = entity ? formatEntityLabel(entity) : 'Value';
        this._sliderLabel.text = name;
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

        for (let i = 0; i < this._colorHistory.length; i += 2) {
            const row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'roompanel-history-row',
            });

            for (let j = i; j < Math.min(i + 2, this._colorHistory.length); j++) {
                const hex = this._colorHistory[j];
                const swatch = new St.Button({
                    style_class: 'button roompanel-history-swatch',
                    x_expand: true,
                    can_focus: true,
                    reactive: true,
                });
                swatch.set_style(`background-color: ${hex};`);
                swatch.connect('clicked', () => this._applyHistoryColor(hex));
                row.add_child(swatch);
            }

            this._historyBox.add_child(row);
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

        this._markUserCommand();

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

        this._markUserCommand();

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
        this._haClient.disconnectLive();

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
