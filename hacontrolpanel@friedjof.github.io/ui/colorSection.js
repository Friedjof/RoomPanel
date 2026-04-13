import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { ColorWheel, rgbToHex } from './colorWheel.js';
import { hexToRgb, loadColorHistory, pushColorToHistory, saveColorHistory } from '../lib/colorHistory.js';
import {
    entityMatchesDomain, buildColorPreviewStyle, darkenHex, formatEntityLabel,
} from './menuHelpers.js';
import { LiveValueSync } from './liveValueSync.js';
import { ColorHistoryView } from './colorHistoryView.js';

/**
 * The color-picker section of the panel menu.
 *
 * Manages its own UI (wheel, hex editor, history, entity chips), its own
 * color-value cache, and dispatches HA service calls via haClient.
 *
 * @param {Gio.Settings} settings
 * @param {HaClient}     haClient
 * @param {Function}     getSuppressUntil  () → timestamp (ms) – echo-suppression window
 * @param {Function}     markUserCommand   () → void – called before every HA command
 */
export class ColorSection {
    constructor(settings, haClient, getSuppressUntil, markUserCommand) {
        this._settings = settings;
        this._haClient = haClient;
        this._markUserCommand = markUserCommand;

        this._sync = new LiveValueSync(getSuppressUntil);
        this._colorSourceId = null;
        this._copyResetSourceId = null;
        this._colorHistory = loadColorHistory();
        this._entityNames = {};
        this._colorValues = {};
        this._currentColorHex = '#ffffff';
        this._settingsChangedId = null;

        this._menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._buildUI();
        this._connectSettings();
    }

    /** The PopupBaseMenuItem to add to the parent menu. */
    getMenuItem() {
        return this._menuItem;
    }

    /** Cancel any pending sync timer (called by panelMenu on markUserCommand). */
    cancelPendingSync() {
        this._sync.cancelPending();
    }

    /**
     * Fetch current HA state for all watched entities and seed the UI.
     * Safe to call multiple times; earlier calls are not cancelled.
     */
    async hydrateFromHA() {
        let chipsNeedRebuild = false;

        for (const entityId of this._settings.get_strv('color-entities').filter(Boolean)) {
            try {
                const state = await this._haClient.getState(entityId);
                const name = state?.attributes?.friendly_name;
                if (name && this._entityNames[entityId] !== name) {
                    this._entityNames[entityId] = name;
                    chipsNeedRebuild = true;
                }
                this._updateColorValue(entityId, state);
            } catch { /* no connection yet */ }
        }

        if (chipsNeedRebuild) {
            this._rebuildChips();
            this._updateColorEntityLabel();
        }
        this._syncColorFromSelectedTargets();
    }

    /**
     * Called by panelMenu for every incoming state_changed event.
     * The section decides internally whether the entity is relevant.
     */
    onStateChanged(entityId, newState) {
        if (!newState) return;

        const colorEntities = this._settings.get_strv('color-entities').filter(Boolean);
        if (!colorEntities.includes(entityId)) return;

        // Cache friendly name; rebuild chips/label if changed
        const friendlyName = newState?.attributes?.friendly_name;
        if (friendlyName && this._entityNames[entityId] !== friendlyName) {
            this._entityNames[entityId] = friendlyName;
            this._rebuildChips();
            this._updateColorEntityLabel();
        }

        if (this._updateColorValue(entityId, newState))
            this._refreshColorChipStyles();

        if (this._sync.isSuppressed()) {
            this._sync.scheduleSync(() => this._syncColorFromSelectedTargets());
            return;
        }

        this._syncColorFromSelectedTargets();
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._colorSourceId) {
            GLib.source_remove(this._colorSourceId);
            this._colorSourceId = null;
        }
        if (this._copyResetSourceId) {
            GLib.source_remove(this._copyResetSourceId);
            this._copyResetSourceId = null;
        }
        this._sync.destroy();
        this._historyView.destroy();
    }

    // ── UI construction ──────────────────────────────────────────────────────

    _buildUI() {
        const colorBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        colorBox.add_style_class_name('roompanel-menu');
        this._menuItem.add_child(colorBox);

        // Top row: "Color" label + entity name (left) | preview + hex + copy (right)
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

        const colorTitleRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-color-title-row',
        });
        colorInfoBox.add_child(colorTitleRow);

        colorTitleRow.add_child(new St.Label({
            text: 'Color',
            style_class: 'roompanel-section-label',
        }));

        this._screenSyncToggleLabel = new St.Label({
            text: 'Sync',
            style_class: 'roompanel-screen-sync-toggle-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._screenSyncToggle = new St.Button({
            style_class: 'button roompanel-screen-sync-toggle',
            can_focus: true,
            reactive: true,
            child: this._screenSyncToggleLabel,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._screenSyncToggle.connect('clicked', () => this._toggleScreenSync());
        colorTitleRow.add_child(this._screenSyncToggle);

        this._colorEntityLabel = new St.Label({
            text: '',
            style_class: 'roompanel-entity-label',
            x_expand: true,
        });
        colorInfoBox.add_child(this._colorEntityLabel);

        // Preview + hex + copy — right side of header row
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

        // Body row: color wheel (left) + history column (right)
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

        colorRightCol.add_child(new St.Label({
            text: 'History',
            style_class: 'roompanel-history-title',
        }));

        this._historyView = new ColorHistoryView(hex => this._applyHistoryColor(hex));
        colorRightCol.add_child(this._historyView.getActor());

        // Chip selector (shown only when > 1 entity)
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
        this._updateScreenSyncToggle();

        // ── Browser Bridge YouTube Sync ──────────────────────────────────
        this._buildBrowserBridgeRow(colorBox);
    }

    _buildBrowserBridgeRow(colorBox) {
        // Wrapper — hidden until Firefox extension is connected
        this._browserSyncBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-browser-sync-box',
            visible: false,
        });
        colorBox.add_child(this._browserSyncBox);

        // Header row: label + mode toggles
        const headerRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-browser-sync-header',
        });
        this._browserSyncBox.add_child(headerRow);

        headerRow.add_child(new St.Label({
            text: 'YT Input',
            style_class: 'roompanel-browser-sync-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));

        // Smart mode button
        this._bridgeSmartBtn = new St.Button({
            label: 'Smart',
            style_class: 'button roompanel-bridge-mode-btn',
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bridgeSmartBtn.connect('clicked', () => {
            this._settings.set_string('browser-bridge-mode', 'smart');
        });
        headerRow.add_child(this._bridgeSmartBtn);

        // YT-only mode button
        this._bridgeYtOnlyBtn = new St.Button({
            label: 'Only YT',
            style_class: 'button roompanel-bridge-mode-btn',
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bridgeYtOnlyBtn.connect('clicked', () => {
            this._settings.set_string('browser-bridge-mode', 'yt-only');
        });
        headerRow.add_child(this._bridgeYtOnlyBtn);

        // Tab chips row (auto + one per open YT tab)
        this._bridgeTabRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-bridge-tab-row',
        });
        this._browserSyncBox.add_child(this._bridgeTabRow);

        this._updateBrowserBridgeUI();
    }

    _connectSettings() {
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'color-entities' || key === 'color-selected') {
                this._updateColorEntityLabel();
                this._rebuildChips();
                this._syncColorFromSelectedTargets();
            }

            if (key === 'color-entities') {
                this._menuItem.visible = this._settings.get_strv('color-entities').some(Boolean);
                void this.hydrateFromHA();
            }

            if (key === 'screen-sync-enabled' || key === 'screen-sync-entities')
                this._updateScreenSyncToggle();

            if (['browser-bridge-connected', 'browser-bridge-mode',
                'browser-bridge-tab', 'browser-bridge-tab-list'].includes(key))
                this._updateBrowserBridgeUI();
        });

        this._menuItem.visible = this._settings.get_strv('color-entities').some(Boolean);
    }

    _updateBrowserBridgeUI() {
        if (!this._browserSyncBox)
            return;

        const connected = this._settings.get_boolean('browser-bridge-connected');
        this._browserSyncBox.visible = connected;

        if (!connected)
            return;

        // Mode toggles
        const mode = this._settings.get_string('browser-bridge-mode');
        if (mode === 'yt-only') {
            this._bridgeSmartBtn.remove_style_class_name('roompanel-bridge-mode-btn-active');
            this._bridgeYtOnlyBtn.add_style_class_name('roompanel-bridge-mode-btn-active');
        } else {
            this._bridgeSmartBtn.add_style_class_name('roompanel-bridge-mode-btn-active');
            this._bridgeYtOnlyBtn.remove_style_class_name('roompanel-bridge-mode-btn-active');
        }

        // Tab chips — rebuild from current tab list
        const children = this._bridgeTabRow.get_children();
        for (const child of children)
            this._bridgeTabRow.remove_child(child);

        let tabs = [];
        try { tabs = JSON.parse(this._settings.get_string('browser-bridge-tab-list')); } catch {}

        const selectedTab = this._settings.get_string('browser-bridge-tab');

        // "Auto" chip is always first
        const autoChip = new St.Button({
            label: 'Auto',
            style_class: 'roompanel-chip' + (selectedTab === 'auto' ? ' roompanel-chip-active' : ''),
            can_focus: true,
            reactive: true,
        });
        autoChip.connect('clicked', () =>
            this._settings.set_string('browser-bridge-tab', 'auto'));
        this._bridgeTabRow.add_child(autoChip);

        // One chip per open YT tab
        for (const tab of tabs) {
            const tabIdStr = String(tab.tabId);
            const isSelected = selectedTab === tabIdStr;
            // Shorten long titles
            const label = (tab.title ?? tabIdStr).replace(/ [-–|].*YouTube.*$/, '').trim().slice(0, 20);
            const chip = new St.Button({
                label,
                style_class: 'roompanel-chip' + (isSelected ? ' roompanel-chip-active' : ''),
                can_focus: true,
                reactive: true,
                x_expand: true,
            });
            chip.tooltip_text = tab.title ?? tabIdStr;
            chip.connect('clicked', () =>
                this._settings.set_string('browser-bridge-tab', tabIdStr));
            this._bridgeTabRow.add_child(chip);
        }

        this._bridgeTabRow.visible = tabs.length > 0;
    }

    // ── Color state ──────────────────────────────────────────────────────────

    _getTargetColorEntities() {
        const all = this._settings.get_strv('color-entities').filter(Boolean);
        const selected = this._settings.get_strv('color-selected').filter(e => all.includes(e));
        return selected.length > 0 ? selected : all;
    }

    _hasScreenSyncTargets() {
        try {
            const configs = JSON.parse(this._settings.get_string('screen-sync-entities'));
            return configs.some(config =>
                config?.enabled !== false &&
                String(config?.entity_id ?? '').trim().startsWith('light.')
            );
        } catch {
            return false;
        }
    }

    _getColorHexFromState(state) {
        const rgb = state?.attributes?.rgb_color;
        if (!Array.isArray(rgb) || rgb.length < 3)
            return null;

        const clamped = rgb
            .slice(0, 3)
            .map(v => Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
        return rgbToHex(clamped);
    }

    _updateColorValue(entityId, state) {
        if (!entityId)
            return false;

        const nextHex = this._getColorHexFromState(state);
        const prevHex = this._colorValues[entityId];

        if (!nextHex) {
            if (prevHex === undefined)
                return false;
            delete this._colorValues[entityId];
            return true;
        }

        if (prevHex === nextHex)
            return false;

        this._colorValues[entityId] = nextHex;
        return true;
    }

    _getSharedColorHexForTargets(targets) {
        if (targets.length === 0)
            return null;

        const colors = [];
        for (const entityId of targets) {
            const hex = this._colorValues[entityId];
            if (!hex)
                return null;
            colors.push(hex);
        }

        const first = colors[0];
        if (!colors.every(hex => hex === first))
            return null;

        return first;
    }

    _getSharedSelectedColorHex() {
        return this._getSharedColorHexForTargets(this._getTargetColorEntities());
    }

    _syncColorFromSelectedTargets() {
        const sharedHex = this._getSharedSelectedColorHex();
        if (!sharedHex)
            return;

        const rgb = hexToRgb(sharedHex);
        if (!rgb)
            return;
        this._colorWheel.setColor(rgb);
        this._updateColorPreview(rgb);
    }



    // ── Chip management ──────────────────────────────────────────────────────

    _refreshColorChipStyles() {
        const targets = new Set(this._getTargetColorEntities());
        for (const chip of this._chipRow.get_children()) {
            const entityId = chip._entityId;
            if (!entityId) continue;
            const entityHex = this._colorValues[entityId];
            const inactiveHex = entityHex ? darkenHex(entityHex) : null;

            if (targets.has(entityId) && entityHex) {
                chip.set_style(`border-color: ${entityHex}; border-width: 2px;`);
            } else if (!targets.has(entityId) && inactiveHex) {
                chip.set_style(`border-color: ${inactiveHex}; border-width: 2px;`);
            } else {
                chip.set_style('');
            }
        }
    }

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
            chip._entityId = entityId;
            chip.set_child(new St.Label({
                text: this._entityNames[entityId] ?? formatEntityLabel(entityId),
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            chip.connect('clicked', () => this._toggleChip(entityId));
            this._chipRow.add_child(chip);
        }

        this._refreshColorChipStyles();
    }

    _toggleChip(entityId) {
        const all = this._settings.get_strv('color-entities').filter(Boolean);
        let selected = this._settings.get_strv('color-selected').filter(e => all.includes(e));

        // Empty means all selected — materialise before toggling
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

    // ── UI update helpers ────────────────────────────────────────────────────

    _updateColorPreview(rgb) {
        const hex = rgbToHex(rgb);
        this._currentColorHex = hex;
        this._colorValue.text = hex;
        this._colorPreview.set_style(buildColorPreviewStyle(hex));
        this._refreshColorChipStyles();
    }

    _updateColorEntityLabel() {
        const targets = this._getTargetColorEntities();

        if (targets.length === 0)
            this._colorEntityLabel.text = 'No entity selected';
        else if (targets.length === 1)
            this._colorEntityLabel.text = this._entityNames[targets[0]] ?? formatEntityLabel(targets[0]);
        else
            this._colorEntityLabel.text = `${targets.length} entities`;
    }

    _updateScreenSyncToggle() {
        if (!this._screenSyncToggle)
            return;

        const hasTargets = this._hasScreenSyncTargets();
        const enabled = hasTargets && this._settings.get_boolean('screen-sync-enabled');

        this._screenSyncToggle.visible = hasTargets;
        this._screenSyncToggle.reactive = hasTargets;
        this._screenSyncToggle.can_focus = hasTargets;
        this._screenSyncToggleLabel.text = 'Sync';
        this._screenSyncToggle.tooltip_text = enabled
            ? 'Screen Sync enabled. Click to disable dynamic screen sync.'
            : 'Screen Sync disabled. Click to enable dynamic screen sync.';

        if (enabled)
            this._screenSyncToggle.add_style_class_name('roompanel-screen-sync-toggle-active');
        else
            this._screenSyncToggle.remove_style_class_name('roompanel-screen-sync-toggle-active');

        if (enabled)
            this._screenSyncToggleLabel.add_style_class_name('roompanel-screen-sync-toggle-label-active');
        else
            this._screenSyncToggleLabel.remove_style_class_name('roompanel-screen-sync-toggle-label-active');
    }

    _toggleScreenSync() {
        if (!this._hasScreenSyncTargets())
            return;

        this._settings.set_boolean(
            'screen-sync-enabled',
            !this._settings.get_boolean('screen-sync-enabled')
        );
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

    // ── Color history ────────────────────────────────────────────────────────

    _rebuildColorHistory() {
        this._historyView.rebuild(this._colorHistory);
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

    // ── Color wheel interaction ──────────────────────────────────────────────

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

    // ── HA command dispatch ──────────────────────────────────────────────────

    async _sendColor(rgb) {
        const targets = this._getTargetColorEntities();
        const service = this._settings.get_string('color-service');
        const attribute = this._settings.get_string('color-attribute');
        if (targets.length === 0 || !service) return;

        this._markUserCommand();

        const [domain, svc] = service.split('.');
        const validTargets = targets.filter(e => entityMatchesDomain(e, domain));
        if (validTargets.length === 0) {
            console.error(`[HAControlPanel] Color call skipped: no entities match domain "${domain}"`);
            return;
        }

        const hex = rgbToHex(rgb);
        for (const entityId of validTargets)
            this._colorValues[entityId] = hex;
        this._refreshColorChipStyles();

        try {
            for (const entityId of validTargets) {
                await this._haClient.callService(domain, svc, {
                    entity_id: entityId,
                    [attribute]: rgb,
                });
            }
        } catch (e) {
            console.error('[HAControlPanel] Color call failed:', e.message);
        }
    }
}
