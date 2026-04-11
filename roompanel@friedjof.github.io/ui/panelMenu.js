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

function formatSliderValue(value) {
    if (!Number.isFinite(value))
        return '—';

    const rounded = Math.round(value * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 0.001)
        return String(Math.round(rounded));

    return String(rounded);
}

/**
 * The dropdown menu content:
 *  ─ Color section (circular color wheel)
 *  ─ Slider section
 *  ─ Action buttons
 */
export class RoomPanelMenu extends PopupMenu.PopupMenuSection {
    constructor(settings, haClient, openPrefs) {
        super();

        this._settings = settings;
        this._haClient = haClient;
        this._openPrefs = openPrefs ?? null;
        this._sliderSourceId = null;
        this._colorSourceId = null;
        this._copyResetSourceId = null;
        this._colorHistory = loadColorHistory();

        // Feedback-loop protection: after the user sends a command we suppress
        // incoming HA state updates for this many milliseconds so the UI does
        // not jump back to the "old" value that HA briefly echoes.
        this._suppressLiveUntil = 0;
        this._entityNames = {}; // entityId → friendly_name cache
        this._sliderValues = {}; // entityId → current numeric slider attribute value

        this._buildUI();
        this._connectSettings();
        this._initLiveSync();
    }

    _buildUI() {
        // ── Settings row ──────────────────────────────────────────────
        this._settingsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._settingsItem.add_style_class_name('roompanel-settings-item');
        this.addMenuItem(this._settingsItem);

        const settingsBtn = new St.Button({
            style_class: 'roompanel-settings-btn',
            can_focus: true,
            reactive: true,
        });
        settingsBtn.connect('clicked', () => this._openPrefs?.());

        const settingsBtnInner = new St.BoxLayout({
            vertical: false,
            style_class: 'roompanel-settings-btn-inner',
        });
        settingsBtn.set_child(settingsBtnInner);

        settingsBtnInner.add_child(new St.Icon({
            icon_name: 'preferences-system-symbolic',
            style_class: 'roompanel-settings-icon',
        }));

        this._domainLabel = new St.Label({
            style_class: 'roompanel-settings-domain',
            y_align: Clutter.ActorAlign.CENTER,
        });
        settingsBtnInner.add_child(this._domainLabel);

        this._settingsItem.add_child(settingsBtn);
        this._updateDomainLabel();

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
            reactive: true,
            can_focus: true,
        });
        this._colorValue.connect('button-press-event', () => this._startColorEdit());
        currentColorBox.add_child(this._colorValue);

        this._colorEntry = new St.Entry({
            style_class: 'roompanel-color-entry',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            can_focus: true,
        });
        this._colorEntry.get_clutter_text().connect('activate', () => this._commitColorEdit());
        this._colorEntry.get_clutter_text().connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._cancelColorEdit();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._colorEntry.get_clutter_text().connect('text-changed', () => {
            const valid = !!this._parseHex(this._colorEntry.get_text());
            if (valid)
                this._colorEntry.remove_style_class_name('roompanel-color-entry-invalid');
            else
                this._colorEntry.add_style_class_name('roompanel-color-entry-invalid');
        });
        this._colorEntry.get_clutter_text().connect('key-focus-out', () => {
            if (this._colorEntry.visible)
                this._cancelColorEdit();
        });
        currentColorBox.add_child(this._colorEntry);

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

        // ── Chip selector (shown only when > 1 entity) ───────────────
        this._chipRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-chip-row',
        });
        colorBox.add_child(this._chipRow);

        this._updateColorPreview(this._colorWheel.getColor());
        this._updateColorEntityLabel();
        this._rebuildChips();
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

        this._sliderChipRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-chip-row',
        });
        sliderBox.add_child(this._sliderChipRow);

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

            if (key === 'color-entities' || key === 'slider-entities-config') {
                this._syncSectionVisibility();
                this._hydrateInitialState();
            }

            if (key === 'color-entities' || key === 'color-selected') {
                this._updateColorEntityLabel();
                this._rebuildChips();
            }

            if (key === 'slider-entities-config' || key === 'slider-selected') {
                this._updateSliderLabel();
                this._rebuildSliderChips();
                this._syncSliderFromSelectedTargets();
            }

            if (key === 'ha-url')
                this._updateDomainLabel();
        });

        this._syncSectionVisibility();
        this._updateColorEntityLabel();
        this._updateSliderLabel();
        this._rebuildSliderChips();
        this._syncSliderFromSelectedTargets();
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
        let colorChipsNeedRebuild = false;
        let sliderChipsNeedRebuild = false;

        const colorLive = this._getLiveSyncEntity();
        for (const entityId of this._settings.get_strv('color-entities').filter(Boolean)) {
            try {
                const state = await this._haClient.getState(entityId);
                const name = state?.attributes?.friendly_name;
                if (name && this._entityNames[entityId] !== name) {
                    this._entityNames[entityId] = name;
                    colorChipsNeedRebuild = true;
                }
                if (entityId === colorLive)
                    this._applyColorState(state);
            } catch { /* no connection yet */ }
        }

        for (const cfg of this._getSliderConfigs().filter(c => c.entity_id)) {
            try {
                const state = await this._haClient.getState(cfg.entity_id);
                const name = state?.attributes?.friendly_name;
                if (name && this._entityNames[cfg.entity_id] !== name) {
                    this._entityNames[cfg.entity_id] = name;
                    sliderChipsNeedRebuild = true;
                }
                if (this._updateSliderValue(cfg, state))
                    sliderChipsNeedRebuild = true;
            } catch { /* no connection yet */ }
        }

        if (colorChipsNeedRebuild) { this._rebuildChips(); this._updateColorEntityLabel(); }
        if (sliderChipsNeedRebuild) { this._rebuildSliderChips(); this._updateSliderLabel(); }
        this._syncSliderFromSelectedTargets();
    }

    /**
     * Incoming state_changed event from HA.
     * Chip values keep updating immediately; only the shared slider/wheel UI
     * is gated by the short echo-suppression window after local interaction.
     */
    _onLiveStateChanged({ entity_id, new_state }) {
        if (!new_state) return;

        // Cache friendly name; update chips/labels if it changed
        const friendlyName = new_state?.attributes?.friendly_name;
        if (friendlyName && this._entityNames[entity_id] !== friendlyName) {
            this._entityNames[entity_id] = friendlyName;
            const colorAll = this._settings.get_strv('color-entities').filter(Boolean);
            if (colorAll.includes(entity_id)) {
                this._rebuildChips();
                this._updateColorEntityLabel();
            }
            const sliderIds = this._getSliderConfigs().map(c => c.entity_id);
            if (sliderIds.includes(entity_id)) {
                this._rebuildSliderChips();
                this._updateSliderLabel();
            }
        }

        const sliderCfg = this._getSliderConfigs().find(c => c.entity_id === entity_id);
        if (sliderCfg && this._updateSliderValue(sliderCfg, new_state))
            this._rebuildSliderChips();

        if (Date.now() < this._suppressLiveUntil) return;

        // Color: only sync when exactly 1 entity is targeted
        const colorLive = this._getLiveSyncEntity();
        if (colorLive && entity_id === colorLive)
            this._applyColorState(new_state);

        if (sliderCfg)
            this._syncSliderFromSelectedTargets();
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

    /** Call before every user-initiated HA command to suppress echo-updates. */
    _markUserCommand() {
        this._suppressLiveUntil = Date.now() + 2000;
    }

    /**
     * Returns the single entity to use for live-sync updates, or null when
     * multiple entities are targeted (ambiguous which color to show in wheel).
     */
    _getLiveSyncEntity() {
        const all = this._settings.get_strv('color-entities').filter(Boolean);
        const selected = this._settings.get_strv('color-selected').filter(e => all.includes(e));
        const targets = selected.length > 0 ? selected : all;
        return targets.length === 1 ? targets[0] : null;
    }

    /** Rebuild the chip selector row from current color-entities / color-selected. */
    _rebuildChips() {
        const children = this._chipRow.get_children();
        for (const child of children)
            this._chipRow.remove_child(child);

        const all = this._settings.get_strv('color-entities').filter(Boolean);
        const selected = this._settings.get_strv('color-selected').filter(e => all.includes(e));

        this._chipRow.visible = all.length > 1;
        if (all.length <= 1) return;

        for (const entityId of all) {
            const isActive = selected.length === 0 || selected.includes(entityId);
            const chip = new St.Button({
                style_class: 'roompanel-chip' + (isActive ? ' roompanel-chip-active' : ''),
                can_focus: true,
                reactive: true,
                x_expand: true,
            });
            const chipLabel = new St.Label({
                text: this._entityNames[entityId] ?? formatEntityLabel(entityId),
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });
            chip.set_child(chipLabel);
            chip.connect('clicked', () => this._toggleChip(entityId));
            this._chipRow.add_child(chip);
        }
    }

    /** Toggle an entity in/out of color-selected. */
    _toggleChip(entityId) {
        const all = this._settings.get_strv('color-entities').filter(Boolean);
        let selected = this._settings.get_strv('color-selected').filter(e => all.includes(e));

        // Empty means all selected — materialise it before toggling
        if (selected.length === 0) selected = [...all];

        const wasSelected = selected.includes(entityId);
        let next;
        if (wasSelected) {
            next = selected.filter(e => e !== entityId);
            if (next.length === 0) next = [...all]; // can't deselect last → reset to all
        } else {
            next = [...selected, entityId];
        }

        // If all are selected, store as empty (canonical "all" representation)
        if (next.length === all.length) next = [];

        this._settings.set_strv('color-selected', next);
    }

    // ── Slider chip helpers ──────────────────────────────────────────────────

    _getSliderConfigs() {
        try {
            const parsed = JSON.parse(this._settings.get_string('slider-entities-config') || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }

    _getTargetSliderConfigs() {
        const all = this._getSliderConfigs().filter(c => c.entity_id);
        const selected = this._settings.get_strv('slider-selected')
            .filter(id => all.some(c => c.entity_id === id));
        return selected.length > 0 ? all.filter(c => selected.includes(c.entity_id)) : all;
    }

    _getSliderNumericValue(cfg, state) {
        if (!cfg?.attribute || !state?.attributes)
            return null;

        const raw = state.attributes[cfg.attribute];
        if (raw === undefined || raw === null)
            return null;

        const numeric = Number(raw);
        return Number.isFinite(numeric) ? numeric : null;
    }

    _updateSliderValue(cfg, state) {
        if (!cfg?.entity_id)
            return false;

        const nextValue = this._getSliderNumericValue(cfg, state);
        const prevValue = this._sliderValues[cfg.entity_id];

        if (nextValue === null) {
            if (prevValue === undefined)
                return false;
            delete this._sliderValues[cfg.entity_id];
            return true;
        }

        if (prevValue === nextValue)
            return false;

        this._sliderValues[cfg.entity_id] = nextValue;
        return true;
    }

    _getSliderChipValueText(entityId) {
        return formatSliderValue(this._sliderValues[entityId]);
    }

    _syncSliderFromSelectedTargets() {
        const targets = this._getTargetSliderConfigs();
        if (targets.length === 0)
            return;

        const states = [];
        for (const cfg of targets) {
            const raw = this._sliderValues[cfg.entity_id];
            const min = Number(cfg.min ?? 0);
            const max = Number(cfg.max ?? 255);
            if (!Number.isFinite(raw) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min)
                return;
            states.push({ raw, min, max });
        }

        const first = states[0];
        const sameRange = states.every(entry => entry.min === first.min && entry.max === first.max);
        const sameValue = states.every(entry => entry.raw === first.raw);
        if (!sameRange || !sameValue)
            return;

        this._slider.value = Math.max(0, Math.min(1, (first.raw - first.min) / (first.max - first.min)));
    }

    _rebuildSliderChips() {
        const children = this._sliderChipRow.get_children();
        for (const child of children)
            this._sliderChipRow.remove_child(child);

        const all = this._getSliderConfigs().filter(c => c.entity_id);
        const selected = this._settings.get_strv('slider-selected')
            .filter(id => all.some(c => c.entity_id === id));

        this._sliderChipRow.visible = all.length > 1;
        if (all.length <= 1) return;

        for (const cfg of all) {
            const entityId = cfg.entity_id;
            const isActive = selected.length === 0 || selected.includes(entityId);
            const chip = new St.Button({
                style_class: 'roompanel-chip' + (isActive ? ' roompanel-chip-active' : ''),
                can_focus: true,
                reactive: true,
                x_expand: true,
            });
            const chipContent = new St.BoxLayout({
                vertical: false,
                style_class: 'roompanel-chip-content',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            chipContent.add_child(new St.Label({
                text: this._entityNames[entityId] ?? formatEntityLabel(entityId),
                style_class: 'roompanel-chip-name',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            chipContent.add_child(new St.Label({
                text: this._getSliderChipValueText(entityId),
                style_class: 'roompanel-chip-value',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            chip.set_child(chipContent);
            chip.connect('clicked', () => this._toggleSliderChip(entityId));
            this._sliderChipRow.add_child(chip);
        }
    }

    _toggleSliderChip(entityId) {
        const all = this._getSliderConfigs().filter(c => c.entity_id).map(c => c.entity_id);
        let selected = this._settings.get_strv('slider-selected').filter(id => all.includes(id));

        if (selected.length === 0) selected = [...all];
        const wasSelected = selected.includes(entityId);
        let next = wasSelected
            ? selected.filter(e => e !== entityId)
            : [...selected, entityId];
        if (next.length === 0) next = [...all];
        if (next.length === all.length) next = [];
        this._settings.set_strv('slider-selected', next);
    }

    _syncSectionVisibility() {
        const showColor = this._settings.get_strv('color-entities').some(Boolean);
        const showSlider = this._getSliderConfigs().some(c => c.entity_id);

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

    _updateDomainLabel() {
        const url = this._settings.get_string('ha-url').trim();
        const m = url.match(/^https?:\/\/([^/:?#\s]+)/i);
        this._domainLabel.text = m ? m[1] : '—';
    }

    _updateColorEntityLabel() {
        const all = this._settings.get_strv('color-entities').filter(Boolean);
        const selected = this._settings.get_strv('color-selected').filter(e => all.includes(e));
        const targets = selected.length > 0 ? selected : all;

        if (targets.length === 0)
            this._colorEntityLabel.text = 'No entity selected';
        else if (targets.length === 1)
            this._colorEntityLabel.text = this._entityNames[targets[0]] ?? formatEntityLabel(targets[0]);
        else
            this._colorEntityLabel.text = `${targets.length} entities`;
    }

    _updateSliderLabel() {
        const targets = this._getTargetSliderConfigs();
        if (targets.length === 0)
            this._sliderLabel.text = 'Value';
        else if (targets.length === 1)
            this._sliderLabel.text = this._entityNames[targets[0].entity_id] ?? formatEntityLabel(targets[0].entity_id);
        else
            this._sliderLabel.text = `${targets.length} entities`;
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

    // ── Hex editor ──────────────────────────────────────────────────────────

    /** Parse a user-typed hex string (with or without #, 3 or 6 digits). */
    _parseHex(input) {
        const raw = String(input ?? '').trim().replace(/^#/, '');
        let hex6;
        if (/^[0-9a-fA-F]{3}$/.test(raw))
            hex6 = raw.split('').map(c => c + c).join('');
        else if (/^[0-9a-fA-F]{6}$/.test(raw))
            hex6 = raw;
        else
            return null;
        return `#${hex6.toLowerCase()}`;
    }

    _startColorEdit() {
        this._colorValue.visible = false;
        this._colorEntry.set_text(this._colorValue.text);
        this._colorEntry.remove_style_class_name('roompanel-color-entry-invalid');
        this._colorEntry.visible = true;
        this._colorEntry.grab_key_focus();
        this._colorEntry.get_clutter_text().set_selection(0, -1);
    }

    _commitColorEdit() {
        const hex = this._parseHex(this._colorEntry.get_text());
        if (!hex) {
            this._colorEntry.add_style_class_name('roompanel-color-entry-invalid');
            return; // stay open so user can fix the input
        }
        this._colorEntry.visible = false;
        this._colorValue.visible = true;
        const rgb = hexToRgb(hex);
        this._colorWheel.setColor(rgb);
        this._updateColorPreview(rgb);
        this._rememberColor(rgb);
        void this._sendColor(rgb);
    }

    _cancelColorEdit() {
        if (!this._colorEntry.visible) return;
        this._colorEntry.visible = false;
        this._colorValue.visible = true;
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
        const all = this._settings.get_strv('color-entities').filter(Boolean);
        const selected = this._settings.get_strv('color-selected').filter(e => all.includes(e));
        const targets = selected.length > 0 ? selected : all;
        const service = this._settings.get_string('color-service');
        const attribute = this._settings.get_string('color-attribute');
        if (targets.length === 0 || !service) return;

        this._markUserCommand();

        const [domain, svc] = service.split('.');
        const validTargets = targets.filter(e => entityMatchesDomain(e, domain));
        if (validTargets.length === 0) {
            console.error(`[RoomPanel] Color call skipped: no entities match domain "${domain}"`);
            return;
        }

        try {
            // HA accepts entity_id as array — single request for all targets
            await this._haClient.callService(domain, svc,
                { entity_id: validTargets.length === 1 ? validTargets[0] : validTargets, [attribute]: rgb });
        } catch (e) {
            console.error('[RoomPanel] Color call failed:', e.message);
        }
    }

    async _onSliderChanged() {
        const targets = this._getTargetSliderConfigs();
        if (targets.length === 0) return;

        this._markUserCommand();

        // Group by (service, attribute, min, max) → batch entities with identical config
        const groups = new Map();
        for (const cfg of targets) {
            if (!cfg.entity_id || !cfg.service) continue;
            const key = `${cfg.service}||${cfg.attribute}||${cfg.min}||${cfg.max}`;
            if (!groups.has(key)) groups.set(key, { cfg, entities: [] });
            groups.get(key).entities.push(cfg.entity_id);
        }

        for (const { cfg, entities } of groups.values()) {
            const [domain, svc] = cfg.service.split('.');
            const valid = entities.filter(e => entityMatchesDomain(e, domain));
            if (valid.length === 0) continue;
            const min = Number(cfg.min ?? 0);
            const max = Number(cfg.max ?? 255);
            const value = Math.round(min + this._slider.value * (max - min));
            try {
                await this._haClient.callService(domain, svc, {
                    entity_id: valid.length === 1 ? valid[0] : valid,
                    [cfg.attribute]: value,
                });
            } catch (e) {
                console.error('[RoomPanel] Slider call failed:', e.message);
            }
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
