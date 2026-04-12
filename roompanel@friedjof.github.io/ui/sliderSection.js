import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { DimmerSlider } from './dimmerSlider.js';
import { entityMatchesDomain, formatEntityLabel, formatSliderValue } from './menuHelpers.js';
import { LiveValueSync } from './liveValueSync.js';
import { readSliderConfigs } from '../lib/configAdapters.js';

/**
 * The slider section of the panel menu.
 *
 * Manages its own UI (slider, entity chips), its own slider-value cache,
 * and dispatches HA service calls via haClient.
 *
 * @param {Gio.Settings} settings
 * @param {HaClient}     haClient
 * @param {Function}     getSuppressUntil  () → timestamp (ms)
 * @param {Function}     markUserCommand   () → void
 */
export class SliderSection {
    constructor(settings, haClient, getSuppressUntil, markUserCommand) {
        this._settings = settings;
        this._haClient = haClient;
        this._markUserCommand = markUserCommand;

        this._sync = new LiveValueSync(getSuppressUntil);
        this._sliderSourceId = null;
        this._entityNames = {};
        this._sliderValues = {};
        this._settingsChangedId = null;

        this._menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this._separator.add_style_class_name('roompanel-separator');

        this._buildUI();
        this._connectSettings();
    }

    /** The PopupBaseMenuItem to add to the parent menu. */
    getMenuItem() {
        return this._menuItem;
    }

    /** The separator shown above the buttons section. */
    getSeparator() {
        return this._separator;
    }

    /** Cancel any pending GLib sync timer (called by panelMenu on markUserCommand). */
    cancelPendingSync() {
        this._sync.cancelPending();
    }

    /** Fetch current HA state for all watched entities and seed the slider. */
    async hydrateFromHA() {
        let chipsNeedRebuild = false;

        for (const cfg of this._getSliderConfigs().filter(c => c.entity_id)) {
            try {
                const state = await this._haClient.getState(cfg.entity_id);
                const name = state?.attributes?.friendly_name;
                if (name && this._entityNames[cfg.entity_id] !== name) {
                    this._entityNames[cfg.entity_id] = name;
                    chipsNeedRebuild = true;
                }
                if (this._updateSliderValue(cfg, state))
                    chipsNeedRebuild = true;
            } catch { /* no connection yet */ }
        }

        if (chipsNeedRebuild) {
            this._rebuildSliderChips();
            this._updateSliderLabel();
        }
        this._syncSliderFromSelectedTargets();
    }

    /**
     * Called by panelMenu for every incoming state_changed event.
     * The section decides internally whether the entity is relevant.
     */
    onStateChanged(entityId, newState) {
        if (!newState) return;

        const sliderCfg = this._getSliderConfigs().find(c => c.entity_id === entityId);
        if (!sliderCfg) return;

        // Cache friendly name
        const friendlyName = newState?.attributes?.friendly_name;
        if (friendlyName && this._entityNames[entityId] !== friendlyName) {
            this._entityNames[entityId] = friendlyName;
            this._rebuildSliderChips();
            this._updateSliderLabel();
        }

        if (this._updateSliderValue(sliderCfg, newState))
            this._rebuildSliderChips();

        this._sync.scheduleSync(() => this._syncSliderFromSelectedTargets());
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
        this._sync.destroy();
    }

    // ── UI construction ──────────────────────────────────────────────────────

    _buildUI() {
        const sliderBox = new St.BoxLayout({ vertical: true, x_expand: true });
        sliderBox.add_style_class_name('roompanel-menu');
        this._menuItem.add_child(sliderBox);

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
    }

    _connectSettings() {
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'slider-entities-config' || key === 'slider-selected') {
                this._updateSliderLabel();
                this._rebuildSliderChips();
                this._syncSliderFromSelectedTargets();
            }

            if (key === 'slider-entities-config') {
                const visible = this._getSliderConfigs().some(c => c.entity_id);
                this._menuItem.visible = visible;
                this._separator.visible = visible;
                void this.hydrateFromHA();
            }
        });

        const visible = this._getSliderConfigs().some(c => c.entity_id);
        this._menuItem.visible = visible;
        this._separator.visible = visible;
        this._updateSliderLabel();
        this._rebuildSliderChips();
    }

    // ── Slider config helpers ────────────────────────────────────────────────

    _getSliderConfigs() {
        return readSliderConfigs(this._settings);
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
            states.push({
                raw,
                min,
                max,
                normalized: Math.max(0, Math.min(1, (raw - min) / (max - min))),
            });
        }

        const first = states[0];
        const tolerance = 0.0025;
        const sameNormalizedValue = states.every(entry =>
            Math.abs(entry.normalized - first.normalized) <= tolerance
        );
        if (!sameNormalizedValue)
            return;

        this._slider.value = first.normalized;
    }

    // ── Chip management ──────────────────────────────────────────────────────

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

    // ── UI label ─────────────────────────────────────────────────────────────

    _updateSliderLabel() {
        const targets = this._getTargetSliderConfigs();
        if (targets.length === 0)
            this._sliderLabel.text = 'Value';
        else if (targets.length === 1)
            this._sliderLabel.text = this._entityNames[targets[0].entity_id] ?? formatEntityLabel(targets[0].entity_id);
        else
            this._sliderLabel.text = `${targets.length} entities`;
    }

    // ── HA command dispatch ──────────────────────────────────────────────────

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
                console.error('[HAControlPanel] Slider call failed:', e.message);
            }
        }
    }
}
