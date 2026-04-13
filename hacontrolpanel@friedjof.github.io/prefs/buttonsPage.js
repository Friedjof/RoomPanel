import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { haDataStore } from './haDataStore.js';
import {
    escapeMarkup,
    getEntityDomain,
    findReplacementEntityId,
    createStringList,
    getDropDownValue,
    setDropDownValue,
} from './utils.js';
import { readButtonsConfig, readSliderConfigs } from '../lib/configAdapters.js';
import { HaClient } from '../lib/haClient.js';
import { EntitySearchPopover } from './popovers/entitySearch.js';
import { ServiceSearchPopover } from './popovers/serviceSearch.js';
import { ButtonListRow, ButtonEditDialog } from './dialogs/buttonEdit.js';

const VALID_SCREEN_SYNC_CONDITION_OPERATORS = new Set(['=', '!=', 'regex']);

function normalizeScreenSyncConditionConfig(config) {
    const operator = VALID_SCREEN_SYNC_CONDITION_OPERATORS.has(String(config?.operator ?? '='))
        ? String(config?.operator ?? '=')
        : '=';

    return {
        enabled: config?.enabled !== false,
        entity_id: String(config?.entity_id ?? '').trim(),
        operator,
        value: config?.value === undefined || config?.value === null
            ? ''
            : String(config.value),
    };
}

function formatHistoryTimestamp(value) {
    const date = new Date(value ?? '');
    if (Number.isNaN(date.getTime()))
        return 'Unknown time';

    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function formatHistoryState(value) {
    const text = String(value ?? '');
    return text === '' ? '""' : text;
}

// ─── ButtonsPage ─────────────────────────────────────────────────────────────

export const ButtonsPage = GObject.registerClass(
class ButtonsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Actions',
            icon_name: 'preferences-other-symbolic',
            name: 'actions',
        });

        this._settings = settings;
        if (settings.get_string('screen-sync-scope') === 'browser') {
            settings.set_string('screen-sync-scope', 'primary');
            settings.set_boolean('browser-bridge-priority', true);
        }
        this._entities = haDataStore.getEntities();
        this._services = haDataStore.getServices();
        this._configs = this._loadConfigs();
        this._haDataChangedId = haDataStore.connect('changed', () => this._applyHAData());
        this._screenSyncConditionCheckPending = false;
        this._screenSyncConditionCurrentState = '';
        this._screenSyncConditionCurrentStateKnown = false;
        this._screenSyncConditionLiveClient = null;
        this._screenSyncConditionLiveEntityId = '';
        this._screenSyncConditionLiveHandler = null;
        this._screenSyncConditionLiveRequestId = 0;
        this._screenSyncConditionSettingsIds = [];
        this._screenSyncPreviewPendingRequest = 0;
        this._screenSyncPreviewTimeoutId = null;
        this._screenSyncConditionLogsPending = false;
        this._screenSyncPreviewResponseId = settings.connect(
            'changed::screen-sync-preview-response',
            () => this._handleScreenSyncPreviewResponse()
        );

        // ── Color Picker Group ────────────────────────────────────────
        const colorGroup = new Adw.PreferencesGroup({
            title: 'Color Picker',
            description: 'Service called when the color is changed',
        });
        this.add(colorGroup);

        this._colorServiceRow = this._makeServiceRow(
            'Service (domain.service)', 'color-service', settings,
            () => '');
        colorGroup.add(this._colorServiceRow);

        this._colorAttributeRow = new Adw.EntryRow({
            title: 'Service Data Attribute',
            text: settings.get_string('color-attribute'),
        });
        colorGroup.add(this._colorAttributeRow);
        this._colorAttributeRow.connect('changed', () =>
            settings.set_string('color-attribute', this._colorAttributeRow.text));

        // ── Color Picker Entities Sub-group ───────────────────────────
        this._colorEntitiesGroup = new Adw.PreferencesGroup({
            title: 'Color Picker Entities',
            description: 'Up to 4 entities controlled together by the color picker',
        });
        this.add(this._colorEntitiesGroup);

        this._colorEntityRows = [];
        const addColorEntityBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['flat', 'circular'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add entity (max 4)',
        });
        this._colorEntitiesGroup.set_header_suffix(addColorEntityBtn);
        this._addColorEntityBtn = addColorEntityBtn;

        this._rebuildColorEntityRows(settings);

        addColorEntityBtn.connect('clicked', () => {
            const entities = settings.get_strv('color-entities');
            if (entities.length >= 4) return;
            entities.push('');
            settings.set_strv('color-entities', entities);
            this._rebuildColorEntityRows(settings);
        });

        // ── Screen Sync Group ────────────────────────────────────────
        const screenSyncGroup = new Adw.PreferencesGroup({
            title: 'Screen Sync',
            description: 'Sample the screen periodically and send the resulting RGB color to a Home Assistant light with light.turn_on.',
        });

        this._screenSyncEnabledRow = new Adw.SwitchRow({
            title: 'Enable Screen Sync',
            subtitle: 'Runs in the GNOME Shell process and updates the target light automatically',
            active: settings.get_boolean('screen-sync-enabled'),
        });
        screenSyncGroup.add(this._screenSyncEnabledRow);
        this._screenSyncEnabledRow.connect('notify::active', () => {
            settings.set_boolean('screen-sync-enabled', this._screenSyncEnabledRow.active);
            this._updateScreenSyncSensitivity();
        });

        this._screenSyncEntityRows = [];
        const createSpinActionRow = ({
            title,
            subtitle,
            lower,
            upper,
            step,
            page,
            value,
            digits = 0,
            unit = '',
            onChanged,
        }) => {
            const row = new Adw.ActionRow({ title, subtitle });
            const spin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower,
                    upper,
                    step_increment: step,
                    page_increment: page,
                    value,
                }),
                digits,
                valign: Gtk.Align.CENTER,
            });
            spin.connect('value-changed', () => onChanged(spin.get_value()));
            row.add_suffix(spin);
            if (unit)
                row.add_suffix(new Gtk.Label({ label: unit, valign: Gtk.Align.CENTER }));
            row.activatable_widget = spin;
            return { row, spin };
        };

        const intervalRow = new Adw.ActionRow({
            title: 'Interval',
            subtitle: 'How often the screen color is sampled',
        });
        this._screenSyncIntervalSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0.5,
                upper: 10.0,
                step_increment: 0.5,
                page_increment: 1.0,
                value: settings.get_double('screen-sync-interval') || 2.0,
            }),
            digits: 1,
            valign: Gtk.Align.CENTER,
        });
        this._screenSyncIntervalSpin.connect('value-changed', () =>
            settings.set_double('screen-sync-interval', this._screenSyncIntervalSpin.get_value()));
        intervalRow.add_suffix(this._screenSyncIntervalSpin);
        intervalRow.add_suffix(new Gtk.Label({ label: 's', valign: Gtk.Align.CENTER }));
        screenSyncGroup.add(intervalRow);
        this._screenSyncIntervalRow = intervalRow;

        const { row: outputIntervalRow, spin: outputIntervalSpin } = createSpinActionRow({
            title: 'Output Interval',
            subtitle: 'How often interpolated colors are sent between screen samples',
            lower: 100,
            upper: 2000,
            step: 50,
            page: 100,
            value: settings.get_int('screen-sync-output-interval') || 500,
            digits: 0,
            unit: 'ms',
            onChanged: value => settings.set_int('screen-sync-output-interval', Math.round(value)),
        });
        screenSyncGroup.add(outputIntervalRow);
        this._screenSyncOutputIntervalRow = outputIntervalRow;
        this._screenSyncOutputIntervalSpin = outputIntervalSpin;

        const modeRow = new Adw.ActionRow({
            title: 'Color Mode',
            subtitle: 'Average blends everything, dominant picks the biggest bucket, vibrant and accent prefer saturated colors, backlight maximises saturation for LED strips behind the screen',
        });
        this._screenSyncModeModel = createStringList(['dominant', 'average', 'vibrant', 'accent', 'backlight']);
        this._screenSyncModeDropdown = new Gtk.DropDown({
            model: this._screenSyncModeModel,
            valign: Gtk.Align.CENTER,
        });
        setDropDownValue(
            this._screenSyncModeDropdown,
            this._screenSyncModeModel,
            settings.get_string('screen-sync-mode') || 'dominant'
        );
        this._screenSyncModeDropdown.connect('notify::selected-item', () =>
            settings.set_string('screen-sync-mode', getDropDownValue(this._screenSyncModeDropdown) || 'dominant'));
        modeRow.add_suffix(this._screenSyncModeDropdown);
        modeRow.activatable_widget = this._screenSyncModeDropdown;
        screenSyncGroup.add(modeRow);
        this._screenSyncModeRow = modeRow;

        // Transition mode — labels are paired with the setting keys stored in GSettings.
        // To add a mode: add an entry here AND add the interpolator in lib/screenSyncController.js.
        const TRANSITION_VALUES = ['off', 'linear', 'ema', 'moving-average', 'catmull-rom', 'spring'];
        const TRANSITION_LABELS = ['Off (instant)', 'Linear', 'Smooth (EMA)', 'Moving Average', 'Catmull-Rom Spline', 'Spring Physics'];

        const transitionRow = new Adw.ActionRow({
            title: 'Color Transition',
            subtitle: 'How to interpolate between sampled screen colors; Catmull-Rom gives smooth organic curves, EMA the softest fade, Spring an elastic feel',
        });
        this._screenSyncTransitionValues = TRANSITION_VALUES;
        this._screenSyncTransitionModel  = createStringList(TRANSITION_LABELS);
        this._screenSyncTransitionDropdown = new Gtk.DropDown({
            model:  this._screenSyncTransitionModel,
            valign: Gtk.Align.CENTER,
        });

        const savedTransition    = settings.get_string('screen-sync-transition') || 'catmull-rom';
        const savedTransitionIdx = TRANSITION_VALUES.indexOf(savedTransition);
        this._screenSyncTransitionDropdown.set_selected(savedTransitionIdx >= 0 ? savedTransitionIdx : 4);

        this._screenSyncTransitionDropdown.connect('notify::selected', () => {
            const sel   = this._screenSyncTransitionDropdown.get_selected();
            const value = this._screenSyncTransitionValues[sel] ?? 'catmull-rom';
            settings.set_string('screen-sync-transition', value);
            this._updateScreenSyncTransitionOptionVisibility();
        });

        transitionRow.add_suffix(this._screenSyncTransitionDropdown);
        transitionRow.activatable_widget = this._screenSyncTransitionDropdown;
        screenSyncGroup.add(transitionRow);
        this._screenSyncTransitionRow = transitionRow;

        const { row: thresholdRow, spin: thresholdSpin } = createSpinActionRow({
            title: 'Change Threshold',
            subtitle: 'Minimum RGB difference before a new output color is sent',
            lower: 0,
            upper: 255,
            step: 1,
            page: 10,
            value: settings.get_int('screen-sync-threshold') || 18,
            digits: 0,
            onChanged: value => settings.set_int('screen-sync-threshold', Math.round(value)),
        });
        screenSyncGroup.add(thresholdRow);
        this._screenSyncThresholdRow = thresholdRow;
        this._screenSyncThresholdSpin = thresholdSpin;

        const scopeRow = new Adw.ActionRow({
            title: 'Color Source',
            subtitle: 'Screen area to sample for normal screen sync',
        });

        // Build scope values and labels dynamically from available monitors
        const scopeValues = ['primary', 'stage'];
        const scopeLabels = ['Primary monitor', 'Entire stage'];

        const gdkDisplay = Gdk.Display.get_default();
        if (gdkDisplay) {
            const gdkMonitors = gdkDisplay.get_monitors();
            const n = gdkMonitors.get_n_items();
            for (let i = 0; i < n; i++) {
                const mon   = gdkMonitors.get_item(i);
                const geo   = mon.get_geometry();
                const mfr   = mon.get_manufacturer() ?? '';
                const model = mon.get_model()        ?? '';
                const name  = [mfr, model].filter(Boolean).join(' ') || null;
                const posLabel = geo.x === 0 && geo.y === 0
                    ? ''
                    : ` at (+${geo.x},+${geo.y})`;
                const label = name
                    ? `Display ${i + 1} · ${name} (${geo.width}×${geo.height})`
                    : `Display ${i + 1} · ${geo.width}×${geo.height}${posLabel}`;
                scopeValues.push(`monitor-${i}`);
                scopeLabels.push(label);
            }
        }

        this._screenSyncScopeValues = scopeValues;
        this._screenSyncScopeModel  = createStringList(scopeLabels);
        this._screenSyncScopeDropdown = new Gtk.DropDown({
            model:  this._screenSyncScopeModel,
            valign: Gtk.Align.CENTER,
        });

        const savedScope = settings.get_string('screen-sync-scope') || 'primary';
        const savedScopeIdx = this._screenSyncScopeValues.indexOf(savedScope);
        this._screenSyncScopeDropdown.set_selected(savedScopeIdx >= 0 ? savedScopeIdx : 0);

        this._screenSyncScopeDropdown.connect('notify::selected', () => {
            const sel   = this._screenSyncScopeDropdown.get_selected();
            const value = this._screenSyncScopeValues[sel] ?? 'primary';
            settings.set_string('screen-sync-scope', value);
            this._updateScreenSyncSourceUI();
        });

        scopeRow.add_suffix(this._screenSyncScopeDropdown);
        scopeRow.activatable_widget = this._screenSyncScopeDropdown;
        screenSyncGroup.add(scopeRow);
        this._screenSyncScopeRow = scopeRow;
        this._buildBrowserBridgeRows(settings, screenSyncGroup);

        const identifyRow = new Adw.ActionRow({
            title: 'Identify Displays',
            subtitle: 'Briefly shows the display index on each connected monitor',
        });
        this._identifyButton = new Gtk.Button({
            label: 'Identify',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Flash monitor numbers on screen for 3 seconds',
        });
        this._identifyButton.connect('clicked', () => void this._identifyDisplays());
        identifyRow.add_suffix(this._identifyButton);
        identifyRow.activatable_widget = this._identifyButton;
        screenSyncGroup.add(identifyRow);
        this._screenSyncIdentifyRow = identifyRow;

        screenSyncGroup.add(new Adw.ActionRow({
            title: 'Output',
            subtitle: 'Output is fixed to light.turn_on with rgb_color on all enabled target lights below.',
            activatable: false,
        }));

        const previewRow = new Adw.ActionRow({
            title: 'Preview Sample',
            subtitle: 'Shows which colors all sampling modes would currently produce',
        });
        this._screenSyncPreviewButton = new Gtk.Button({
            label: 'Preview',
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        this._screenSyncPreviewButton.connect('clicked', () => this._requestScreenSyncPreview());
        previewRow.add_suffix(this._screenSyncPreviewButton);
        screenSyncGroup.add(previewRow);
        this._screenSyncPreviewRow = previewRow;

        this._screenSyncTransitionSettingsGroup = new Adw.PreferencesGroup({
            title: 'Transition Options',
            description: 'Only settings for the selected transition are shown here. Global output controls stay above.',
        });

        const { row: historySizeRow, spin: historySizeSpin } = createSpinActionRow({
            title: 'History Size',
            subtitle: 'Used by Moving Average and Catmull-Rom; more samples smooth more but react slower',
            lower: 2,
            upper: 8,
            step: 1,
            page: 1,
            value: settings.get_int('screen-sync-history-size') || 4,
            digits: 0,
            unit: 'samples',
            onChanged: value => settings.set_int('screen-sync-history-size', Math.round(value)),
        });
        this._screenSyncTransitionSettingsGroup.add(historySizeRow);
        this._screenSyncHistorySizeRow = historySizeRow;
        this._screenSyncHistorySizeSpin = historySizeSpin;

        const { row: emaTimeRow, spin: emaTimeSpin } = createSpinActionRow({
            title: 'EMA Transition Time',
            subtitle: 'Approximate fade time for Smooth (EMA)',
            lower: 0.1,
            upper: 10,
            step: 0.1,
            page: 0.5,
            value: settings.get_double('screen-sync-ema-time') || 2.0,
            digits: 1,
            unit: 's',
            onChanged: value => settings.set_double('screen-sync-ema-time', value),
        });
        this._screenSyncTransitionSettingsGroup.add(emaTimeRow);
        this._screenSyncEmaTimeRow = emaTimeRow;
        this._screenSyncEmaTimeSpin = emaTimeSpin;

        const { row: springStiffnessRow, spin: springStiffnessSpin } = createSpinActionRow({
            title: 'Spring Stiffness',
            subtitle: 'How strongly the spring transition accelerates toward the target color',
            lower: 0.01,
            upper: 1.0,
            step: 0.01,
            page: 0.05,
            value: settings.get_double('screen-sync-spring-stiffness') || 0.15,
            digits: 2,
            onChanged: value => settings.set_double('screen-sync-spring-stiffness', value),
        });
        this._screenSyncTransitionSettingsGroup.add(springStiffnessRow);
        this._screenSyncSpringStiffnessRow = springStiffnessRow;
        this._screenSyncSpringStiffnessSpin = springStiffnessSpin;

        const { row: springDampingRow, spin: springDampingSpin } = createSpinActionRow({
            title: 'Spring Damping',
            subtitle: 'How much motion the spring transition keeps between output ticks',
            lower: 0.05,
            upper: 0.99,
            step: 0.01,
            page: 0.05,
            value: settings.get_double('screen-sync-spring-damping') || 0.75,
            digits: 2,
            onChanged: value => settings.set_double('screen-sync-spring-damping', value),
        });
        this._screenSyncTransitionSettingsGroup.add(springDampingRow);
        this._screenSyncSpringDampingRow = springDampingRow;
        this._screenSyncSpringDampingSpin = springDampingSpin;

        this._updateScreenSyncTransitionOptionVisibility();
        this._updateScreenSyncSensitivity();

        // ── Slider Group ──────────────────────────────────────────────
        this._sliderEntitiesGroup = new Adw.PreferencesGroup({
            title: 'Slider',
            description: 'Up to 4 entities controlled together; each can have its own service and range',
        });
        this.add(this._sliderEntitiesGroup);

        this._sliderEntityRows = [];
        this._sliderEntityEntryRows = [];
        this._sliderServiceEntryRows = [];
        const addSliderEntityBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['flat', 'circular'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add entity (max 4)',
        });
        this._sliderEntitiesGroup.set_header_suffix(addSliderEntityBtn);
        this._addSliderEntityBtn = addSliderEntityBtn;

        this._rebuildSliderEntityRows(settings);

        addSliderEntityBtn.connect('clicked', () => {
            let configs = this._loadSliderConfigs(settings);
            if (configs.length >= 4) return;
            configs.push({ entity_id: '', service: 'light.turn_on', attribute: 'brightness', min: 0, max: 255 });
            settings.set_string('slider-entities-config', JSON.stringify(configs));
            this._rebuildSliderEntityRows(settings);
        });

        // ── Action Buttons Group ──────────────────────────────────────
        this._buttonsGroup = new Adw.PreferencesGroup({ title: 'Action Buttons' });
        this.add(this._buttonsGroup);

        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['suggested-action', 'circular'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add button',
        });
        this._buttonsGroup.set_header_suffix(addBtn);
        addBtn.connect('clicked', () => void this._openEditDialog(null, null));

        this._rebuildList();
        this._applyHAData();

        // Screen Sync goes below Action Buttons
        this.add(screenSyncGroup);
        this.add(this._screenSyncTransitionSettingsGroup);

        this._screenSyncEntitiesGroup = new Adw.PreferencesGroup({
            title: 'Screen Sync Lights',
            description: 'Only lights that support RGB color are shown in the search',
        });
        this.add(this._screenSyncEntitiesGroup);

        const addSyncEntityBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['flat', 'circular'],
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add target light',
        });
        this._screenSyncEntitiesGroup.set_header_suffix(addSyncEntityBtn);
        this._addSyncEntityBtn = addSyncEntityBtn;

        this._rebuildScreenSyncEntityRows(settings);

        addSyncEntityBtn.connect('clicked', () => {
            const current = this._loadSyncConfigs(settings);
            current.push({ entity_id: '', enabled: true });
            this._saveSyncConfigs(settings, current);
            this._rebuildScreenSyncEntityRows(settings);
        });

        this._screenSyncConditionGroup = new Adw.PreferencesGroup({
            title: 'Screen Sync Condition',
            description: 'Optional gate. The selected entity state is string-compared using =, !=, or regex before screen sync runs.',
        });
        this.add(this._screenSyncConditionGroup);

        const syncCondition = this._loadSyncCondition(settings);
        this._screenSyncConditionEnabledRow = new Adw.SwitchRow({
            title: 'Enable Condition',
            subtitle: 'Disable this to ignore the rule without deleting the saved entity and comparison.',
            active: syncCondition.enabled,
        });
        this._screenSyncConditionStatusDot = new Gtk.Label({
            use_markup: true,
            label: '<span foreground="#8a8a8a">●</span>',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Condition status unavailable',
        });
        this._screenSyncConditionEnabledRow.add_prefix(this._screenSyncConditionStatusDot);
        this._screenSyncConditionEnabledRow.connect('notify::active', () => {
            const current = this._loadSyncCondition(settings);
            this._saveSyncCondition(settings, {
                ...current,
                enabled: this._screenSyncConditionEnabledRow.active,
            });
            this._updateScreenSyncConditionConfigSensitivity();
        });
        this._screenSyncConditionGroup.add(this._screenSyncConditionEnabledRow);

        this._screenSyncConditionBehaviorRow = new Adw.ActionRow({
            title: 'Behavior',
            subtitle: 'If disabled or if no entity is set, screen sync stays active. If the rule is enabled and stops matching, screen sync pauses immediately.',
            activatable: false,
        });
        this._screenSyncConditionGroup.add(this._screenSyncConditionBehaviorRow);

        this._screenSyncConditionEntityRow = new Adw.EntryRow({
            title: 'Condition Entity',
            text: syncCondition.entity_id,
        });
        const conditionSearchBtn = new Gtk.Button({
            icon_name: 'system-search-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Browse entities',
        });
        this._screenSyncConditionEntityRow.add_suffix(conditionSearchBtn);
        const conditionPopover = new EntitySearchPopover(picked => {
            this._screenSyncConditionEntityRow.text = picked;
            const current = this._loadSyncCondition(settings);
            this._saveSyncCondition(settings, { ...current, entity_id: picked });
            this._updateScreenSyncConditionActions();
        });
        conditionPopover.set_parent(conditionSearchBtn);
        conditionPopover.setEntities(this._entities);
        this._screenSyncConditionEntityRow._entityPopover = conditionPopover;
        conditionSearchBtn.connect('clicked', () => {
            conditionPopover.setEntities(this._entities);
            conditionPopover.popup();
        });
        this._screenSyncConditionEntityRow.connect('changed', () => {
            const current = this._loadSyncCondition(settings);
            this._saveSyncCondition(settings, {
                ...current,
                entity_id: this._screenSyncConditionEntityRow.text,
            });
            this._updateScreenSyncConditionActions();
        });
        this._screenSyncConditionGroup.add(this._screenSyncConditionEntityRow);

        const conditionOperatorRow = new Adw.ActionRow({
            title: 'Comparison',
            subtitle: 'Exact match, exact mismatch, or regular expression test against the entity state string',
        });
        this._screenSyncConditionOperatorModel = createStringList(['=', '!=', 'regex']);
        this._screenSyncConditionOperatorDropdown = new Gtk.DropDown({
            model: this._screenSyncConditionOperatorModel,
            valign: Gtk.Align.CENTER,
        });
        setDropDownValue(
            this._screenSyncConditionOperatorDropdown,
            this._screenSyncConditionOperatorModel,
            syncCondition.operator
        );
        this._screenSyncConditionOperatorDropdown.connect('notify::selected-item', () => {
            const current = this._loadSyncCondition(settings);
            this._saveSyncCondition(settings, {
                ...current,
                operator: getDropDownValue(this._screenSyncConditionOperatorDropdown) || '=',
            });
        });
        conditionOperatorRow.add_suffix(this._screenSyncConditionOperatorDropdown);
        conditionOperatorRow.activatable_widget = this._screenSyncConditionOperatorDropdown;
        this._screenSyncConditionGroup.add(conditionOperatorRow);
        this._screenSyncConditionOperatorRow = conditionOperatorRow;

        this._screenSyncConditionValueRow = new Adw.EntryRow({
            title: 'Match Value',
            text: syncCondition.value,
        });
        this._screenSyncConditionValueRow.connect('changed', () => {
            const current = this._loadSyncCondition(settings);
            this._saveSyncCondition(settings, {
                ...current,
                value: this._screenSyncConditionValueRow.text,
            });
        });
        this._screenSyncConditionGroup.add(this._screenSyncConditionValueRow);

        this._screenSyncConditionDebugRow = new Adw.ActionRow({
            title: 'Debug',
            subtitle: 'Check whether the saved rule currently matches and inspect the last 24 hours of state changes',
        });
        this._screenSyncConditionCheckButton = new Gtk.Button({
            label: 'Check Now',
            valign: Gtk.Align.CENTER,
        });
        this._screenSyncConditionCheckButton.connect('clicked', () => void this._checkScreenSyncConditionNow());
        this._screenSyncConditionLogsButton = new Gtk.Button({
            label: 'Show Logs',
            valign: Gtk.Align.CENTER,
        });
        this._screenSyncConditionLogsButton.connect('clicked', () => void this._showScreenSyncConditionLogs());
        this._screenSyncConditionDebugRow.add_suffix(this._screenSyncConditionCheckButton);
        this._screenSyncConditionDebugRow.add_suffix(this._screenSyncConditionLogsButton);
        this._screenSyncConditionGroup.add(this._screenSyncConditionDebugRow);
        this._screenSyncConditionSettingsIds = [
            settings.connect('changed::screen-sync-condition', () => this._refreshScreenSyncConditionLiveStatus()),
            settings.connect('changed::ha-url', () => this._refreshScreenSyncConditionLiveStatus()),
            settings.connect('changed::ha-token', () => this._refreshScreenSyncConditionLiveStatus()),
            settings.connect('changed::ha-verify-ssl', () => this._refreshScreenSyncConditionLiveStatus()),
        ];
        this._updateScreenSyncConditionActions();
        this._updateScreenSyncConditionConfigSensitivity();
        this._refreshScreenSyncConditionLiveStatus();
        this._updateScreenSyncSensitivity();
    }

    // ── Helper: entity row with search lupe ──────────────────────────

    _makeEntityRow(title, settingKey, settings, getDomain = null) {
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

        btn.connect('clicked', () => {
            popover.setDomainFilter(getDomain?.() ?? '');
            popover.popup();
        });
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

    // ── Dynamic color entity rows ────────────────────────────────────

    _rebuildColorEntityRows(settings) {
        for (const row of this._colorEntityRows)
            this._colorEntitiesGroup.remove(row);
        this._colorEntityRows = [];

        const entities = settings.get_strv('color-entities');

        if (entities.length === 0) {
            const placeholder = new Adw.ActionRow({
                title: 'No entities configured',
                subtitle: 'Click + to add a color entity',
                sensitive: false,
            });
            this._colorEntitiesGroup.add(placeholder);
            this._colorEntityRows.push(placeholder);
        }

        for (let i = 0; i < entities.length; i++) {
            const idx = i;
            const entityId = entities[i];
            const friendly = this._entities?.find(e => e.entity_id === entityId)?.attributes?.friendly_name;

            const expander = new Adw.ExpanderRow({
                title: friendly || entityId || `Entity ${i + 1}`,
                subtitle: entityId || '',
            });

            const entityRow = new Adw.EntryRow({ title: 'Entity ID', text: entityId });
            const searchBtn = new Gtk.Button({
                icon_name: 'system-search-symbolic',
                valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse entities',
            });
            entityRow.add_suffix(searchBtn);

            const popover = new EntitySearchPopover(picked => {
                entityRow.text = picked;
                const current = settings.get_strv('color-entities');
                current[idx] = picked;
                settings.set_strv('color-entities', current);
                const pickedFriendly = this._entities?.find(e => e.entity_id === picked)?.attributes?.friendly_name;
                expander.title = pickedFriendly || picked || `Entity ${idx + 1}`;
                expander.subtitle = picked;
            });
            popover.set_parent(searchBtn);
            expander._entityPopover = popover;

            searchBtn.connect('clicked', () => {
                const domain = this._colorServiceRow?.text.split('.')[0] || 'light';
                popover.setDomainFilter(domain);
                popover.popup();
            });
            entityRow.connect('changed', () => {
                const current = settings.get_strv('color-entities');
                if (idx < current.length) {
                    current[idx] = entityRow.text;
                    settings.set_strv('color-entities', current);
                    expander.subtitle = entityRow.text;
                }
            });
            expander.add_row(entityRow);

            const removeRow = new Adw.ActionRow({ title: 'Remove this entity' });
            const removeBtn = new Gtk.Button({
                label: 'Remove',
                css_classes: ['destructive-action'],
                valign: Gtk.Align.CENTER,
            });
            removeRow.add_suffix(removeBtn);
            removeBtn.connect('clicked', () => {
                const current = settings.get_strv('color-entities');
                current.splice(idx, 1);
                const selected = settings.get_strv('color-selected').filter(e => current.includes(e));
                settings.set_strv('color-selected', selected);
                settings.set_strv('color-entities', current);
                this._rebuildColorEntityRows(settings);
            });
            expander.add_row(removeRow);

            this._colorEntitiesGroup.add(expander);
            this._colorEntityRows.push(expander);
        }

        this._addColorEntityBtn.sensitive = entities.length < 4;

        if (this._entities?.length > 0)
            this._distributeEntities();
    }

    // ── Screen Sync entity helpers ────────────────────────────────────

    /** Returns entities that are lights and advertise at least one RGB-capable color mode. */
    _colorLightEntities() {
        const COLOR_MODES = new Set(['rgb', 'rgbw', 'rgbww', 'hs', 'xy']);
        return (this._entities ?? []).filter(e => {
            if (!e.entity_id?.startsWith('light.')) return false;
            const modes = e.attributes?.supported_color_modes ?? [];
            return modes.some(m => COLOR_MODES.has(m));
        });
    }

    _loadSyncConfigs(settings) {
        try {
            const parsed = JSON.parse(settings.get_string('screen-sync-entities'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    _saveSyncConfigs(settings, configs) {
        settings.set_string('screen-sync-entities', JSON.stringify(configs));
    }

    _loadSyncCondition(settings) {
        try {
            return normalizeScreenSyncConditionConfig(
                JSON.parse(settings.get_string('screen-sync-condition'))
            );
        } catch {
            return normalizeScreenSyncConditionConfig({});
        }
    }

    _saveSyncCondition(settings, condition) {
        settings.set_string(
            'screen-sync-condition',
            JSON.stringify(normalizeScreenSyncConditionConfig(condition))
        );
    }

    _updateScreenSyncConditionConfigSensitivity() {
        const enabled = this._screenSyncConditionEnabledRow?.active ?? true;
        if (this._screenSyncConditionBehaviorRow)
            this._screenSyncConditionBehaviorRow.sensitive = enabled;
        if (this._screenSyncConditionEntityRow)
            this._screenSyncConditionEntityRow.sensitive = enabled;
        if (this._screenSyncConditionOperatorRow)
            this._screenSyncConditionOperatorRow.sensitive = enabled;
        if (this._screenSyncConditionValueRow)
            this._screenSyncConditionValueRow.sensitive = enabled;
    }

    _updateScreenSyncConditionActions() {
        if (!this._screenSyncConditionLogsButton || !this._screenSyncConditionCheckButton)
            return;

        const hasEntity = String(this._screenSyncConditionEntityRow?.text ?? '').trim().length > 0;
        this._screenSyncConditionCheckButton.sensitive = hasEntity && !this._screenSyncConditionCheckPending;
        this._screenSyncConditionCheckButton.label = this._screenSyncConditionCheckPending ? 'Checking…' : 'Check Now';
        this._screenSyncConditionLogsButton.sensitive = hasEntity && !this._screenSyncConditionLogsPending;
        this._screenSyncConditionLogsButton.label = this._screenSyncConditionLogsPending ? 'Loading…' : 'Show Logs';
    }

    _setScreenSyncConditionStatusDot(color, tooltip) {
        if (!this._screenSyncConditionStatusDot)
            return;

        this._screenSyncConditionStatusDot.label = `<span foreground="${escapeMarkup(color)}">●</span>`;
        this._screenSyncConditionStatusDot.tooltip_text = String(tooltip ?? '');
    }

    _disconnectScreenSyncConditionLiveClient() {
        this._screenSyncConditionLiveRequestId++;
        this._screenSyncConditionLiveEntityId = '';
        this._screenSyncConditionCurrentState = '';
        this._screenSyncConditionCurrentStateKnown = false;

        if (!this._screenSyncConditionLiveClient)
            return;

        if (this._screenSyncConditionLiveHandler)
            this._screenSyncConditionLiveClient.disconnectLive(this._screenSyncConditionLiveHandler);
        this._screenSyncConditionLiveClient.destroy();
        this._screenSyncConditionLiveClient = null;
    }

    _handleScreenSyncConditionLiveState(data) {
        const condition = this._loadSyncCondition(this._settings);
        if (!condition.enabled || !condition.entity_id || data?.entity_id !== condition.entity_id)
            return;

        const actualValue = String(data?.new_state?.state ?? '');
        this._screenSyncConditionCurrentState = actualValue;
        this._screenSyncConditionCurrentStateKnown = true;
        this._updateScreenSyncConditionStatusFromValue(actualValue, condition);
    }

    _updateScreenSyncConditionStatusFromValue(actualValue, condition) {
        try {
            const matches = this._evaluateScreenSyncConditionValue(actualValue, condition);
            this._setScreenSyncConditionStatusDot(
                matches ? '#2e7d32' : '#c62828',
                matches
                    ? `Condition matches: ${formatHistoryState(actualValue)} ${condition.operator} ${formatHistoryState(condition.value)}`
                    : `Condition does not match: ${formatHistoryState(actualValue)} ${condition.operator} ${formatHistoryState(condition.value)}`
            );
        } catch (e) {
            const message = e?.message ?? String(e);
            this._setScreenSyncConditionStatusDot('#c62828', `Condition is invalid: ${message}`);
        }
    }

    async _refreshScreenSyncConditionLiveStatus() {
        const condition = this._loadSyncCondition(this._settings);
        const url = this._settings.get_string('ha-url').trim();
        const token = this._settings.get_string('ha-token').trim();
        const verifySSL = this._settings.get_boolean('ha-verify-ssl');

        if (!condition.enabled) {
            this._disconnectScreenSyncConditionLiveClient();
            this._setScreenSyncConditionStatusDot('#8a8a8a', 'Condition is disabled.');
            return;
        }

        if (!condition.entity_id) {
            this._disconnectScreenSyncConditionLiveClient();
            this._setScreenSyncConditionStatusDot('#8a8a8a', 'Choose a condition entity to evaluate the rule.');
            return;
        }

        if (!url || !token) {
            this._disconnectScreenSyncConditionLiveClient();
            this._setScreenSyncConditionStatusDot('#8a8a8a', 'Configure Home Assistant URL and token to evaluate the condition.');
            return;
        }

        if (!this._screenSyncConditionLiveClient) {
            this._screenSyncConditionLiveClient = new HaClient();
            this._screenSyncConditionLiveHandler = data => this._handleScreenSyncConditionLiveState(data);
        }

        this._screenSyncConditionLiveClient.setCredentials(url, token, verifySSL);
        this._screenSyncConditionLiveClient.connectLive(this._screenSyncConditionLiveHandler);

        const entityChanged = this._screenSyncConditionLiveEntityId !== condition.entity_id;
        this._screenSyncConditionLiveEntityId = condition.entity_id;

        if (!entityChanged && this._screenSyncConditionCurrentStateKnown) {
            this._updateScreenSyncConditionStatusFromValue(this._screenSyncConditionCurrentState, condition);
            return;
        }

        const requestId = ++this._screenSyncConditionLiveRequestId;
        this._screenSyncConditionCurrentStateKnown = false;
        this._setScreenSyncConditionStatusDot('#8a8a8a', `Checking current state for "${condition.entity_id}"…`);

        try {
            const state = await this._screenSyncConditionLiveClient.getState(condition.entity_id);
            if (requestId !== this._screenSyncConditionLiveRequestId)
                return;

            const actualValue = String(state?.state ?? '');
            this._screenSyncConditionCurrentState = actualValue;
            this._screenSyncConditionCurrentStateKnown = true;
            this._updateScreenSyncConditionStatusFromValue(actualValue, condition);
        } catch (e) {
            if (requestId !== this._screenSyncConditionLiveRequestId)
                return;

            this._screenSyncConditionCurrentState = '';
            this._screenSyncConditionCurrentStateKnown = false;
            const message = e?.message ?? String(e);
            this._setScreenSyncConditionStatusDot('#c62828', `Could not evaluate condition: ${message}`);
        }
    }

    _evaluateScreenSyncConditionValue(actualValue, condition) {
        const actual = String(actualValue ?? '');

        switch (condition.operator) {
        case '!=':
            return actual !== condition.value;
        case 'regex':
            return new RegExp(condition.value).test(actual);
        case '=':
        default:
            return actual === condition.value;
        }
    }

    async _checkScreenSyncConditionNow() {
        const condition = this._loadSyncCondition(this._settings);
        if (!condition.entity_id) {
            this._showScreenSyncConditionLogsError('Choose a condition entity first.');
            return;
        }

        const url = this._settings.get_string('ha-url').trim();
        const token = this._settings.get_string('ha-token').trim();
        if (!url || !token) {
            this._showScreenSyncConditionLogsError('Home Assistant connection is missing. Configure URL and token in the Connection tab first.');
            return;
        }

        this._screenSyncConditionCheckPending = true;
        this._updateScreenSyncConditionActions();

        const client = new HaClient();
        client.setCredentials(url, token, this._settings.get_boolean('ha-verify-ssl'));

        try {
            const state = await client.getState(condition.entity_id);
            const actualValue = String(state?.state ?? '');
            const matches = this._evaluateScreenSyncConditionValue(actualValue, condition);
            this._showScreenSyncConditionCheckDialog({
                condition,
                actualValue,
                matches,
            });
        } catch (e) {
            const message = e?.message ?? String(e);
            this._showScreenSyncConditionLogsError(`Could not check condition for "${condition.entity_id}": ${message}`);
        } finally {
            client.destroy();
            this._screenSyncConditionCheckPending = false;
            this._updateScreenSyncConditionActions();
        }
    }

    _showScreenSyncConditionCheckDialog({ condition, actualValue, matches }) {
        const heading = matches ? 'Condition Matches' : 'Condition Does Not Match';
        const statusLine = condition.enabled
            ? 'The saved rule is currently active.'
            : 'The saved rule is currently disabled, but this is what it would evaluate to.';
        const dialog = new Adw.MessageDialog({
            transient_for: this.get_root(),
            heading,
            body: [
                statusLine,
                '',
                `Entity: ${condition.entity_id}`,
                `Current state: ${formatHistoryState(actualValue)}`,
                `Comparison: ${condition.operator} ${formatHistoryState(condition.value)}`,
            ].join('\n'),
        });
        dialog.add_response('ok', 'OK');
        dialog.present();
    }

    _rebuildScreenSyncEntityRows(settings) {
        for (const row of this._screenSyncEntityRows)
            this._screenSyncEntitiesGroup.remove(row);
        this._screenSyncEntityRows = [];

        const configs = this._loadSyncConfigs(settings);

        if (configs.length === 0) {
            const placeholder = new Adw.ActionRow({
                title: 'No lights configured',
                subtitle: 'Click + to add a target light',
                sensitive: false,
            });
            this._screenSyncEntitiesGroup.add(placeholder);
            this._screenSyncEntityRows.push(placeholder);
            return;
        }

        for (let i = 0; i < configs.length; i++) {
            const idx = i;
            const cfg = configs[i];
            const entityId = cfg.entity_id ?? '';
            const enabled = cfg.enabled !== false;
            const friendly = this._entities?.find(e => e.entity_id === entityId)?.attributes?.friendly_name;

            const expander = new Adw.ExpanderRow({
                title: friendly || entityId || `Light ${i + 1}`,
                subtitle: enabled ? entityId : `${entityId} · disabled`,
            });

            // Enable/disable toggle in the row header
            const toggle = new Gtk.Switch({
                active: enabled,
                valign: Gtk.Align.CENTER,
            });
            toggle.connect('notify::active', () => {
                const current = this._loadSyncConfigs(settings);
                if (idx < current.length) {
                    current[idx].enabled = toggle.active;
                    this._saveSyncConfigs(settings, current);
                    expander.subtitle = toggle.active ? entityId : `${entityId} · disabled`;
                }
            });
            expander.add_suffix(toggle);

            // Entity ID entry with search
            const entityRow = new Adw.EntryRow({ title: 'Entity ID', text: entityId });
            const searchBtn = new Gtk.Button({
                icon_name: 'system-search-symbolic',
                valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse RGB lights',
            });
            entityRow.add_suffix(searchBtn);

            const popover = new EntitySearchPopover(picked => {
                entityRow.text = picked;
                const current = this._loadSyncConfigs(settings);
                if (idx < current.length) {
                    current[idx].entity_id = picked;
                    this._saveSyncConfigs(settings, current);
                }
                const pickedFriendly = this._entities?.find(e => e.entity_id === picked)?.attributes?.friendly_name;
                expander.title = pickedFriendly || picked || `Light ${idx + 1}`;
                const isEnabled = current[idx]?.enabled !== false;
                expander.subtitle = isEnabled ? picked : `${picked} · disabled`;
            });
            popover.set_parent(searchBtn);
            expander._entityPopover = popover;
            popover.setEntities(this._colorLightEntities());

            searchBtn.connect('clicked', () => {
                popover.setEntities(this._colorLightEntities());
                popover.popup();
            });
            entityRow.connect('changed', () => {
                const current = this._loadSyncConfigs(settings);
                if (idx < current.length) {
                    current[idx].entity_id = entityRow.text;
                    this._saveSyncConfigs(settings, current);
                    const isEnabled = current[idx].enabled !== false;
                    expander.subtitle = isEnabled ? entityRow.text : `${entityRow.text} · disabled`;
                }
            });
            expander.add_row(entityRow);

            const removeRow = new Adw.ActionRow({ title: 'Remove this light' });
            const removeBtn = new Gtk.Button({
                label: 'Remove',
                css_classes: ['destructive-action'],
                valign: Gtk.Align.CENTER,
            });
            removeRow.add_suffix(removeBtn);
            removeBtn.connect('clicked', () => {
                const current = this._loadSyncConfigs(settings);
                current.splice(idx, 1);
                this._saveSyncConfigs(settings, current);
                this._rebuildScreenSyncEntityRows(settings);
            });
            expander.add_row(removeRow);

            this._screenSyncEntitiesGroup.add(expander);
            this._screenSyncEntityRows.push(expander);
        }
    }

    // ── Slider config helpers ─────────────────────────────────────────

    _loadSliderConfigs(settings) {
        return readSliderConfigs(settings);
    }

    _rebuildSliderEntityRows(settings) {
        for (const row of this._sliderEntityRows)
            this._sliderEntitiesGroup.remove(row);
        this._sliderEntityRows = [];
        this._sliderEntityEntryRows = [];
        this._sliderServiceEntryRows = [];

        const configs = this._loadSliderConfigs(settings);

        const saveConfigs = () =>
            settings.set_string('slider-entities-config', JSON.stringify(configs));

        if (configs.length === 0) {
            const placeholder = new Adw.ActionRow({
                title: 'No entities configured',
                subtitle: 'Click + to add a slider entity',
                sensitive: false,
            });
            this._sliderEntitiesGroup.add(placeholder);
            this._sliderEntityRows.push(placeholder);
        }

        for (let i = 0; i < configs.length; i++) {
            const idx = i;
            const cfg = configs[i];

            const friendlyInit = this._entities?.find(e => e.entity_id === cfg.entity_id)?.attributes?.friendly_name;
            const expander = new Adw.ExpanderRow({
                title: friendlyInit || cfg.entity_id || `Entity ${i + 1}`,
                subtitle: cfg.service || '',
            });

            // Entity row with search
            const entityRow = new Adw.EntryRow({ title: 'Entity ID', text: cfg.entity_id || '' });
            const searchBtn = new Gtk.Button({
                icon_name: 'system-search-symbolic',
                valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse entities',
            });
            entityRow.add_suffix(searchBtn);

            const entityPopover = new EntitySearchPopover(entityId => {
                entityRow.text = entityId;
                configs[idx].entity_id = entityId;
                const friendly = this._entities?.find(e => e.entity_id === entityId)?.attributes?.friendly_name;
                expander.title = friendly || entityId || `Entity ${idx + 1}`;
                saveConfigs();
            });
            entityPopover.set_parent(searchBtn);
            entityRow._entityPopover = entityPopover;

            searchBtn.connect('clicked', () => {
                const domain = (configs[idx].service || '').split('.')[0] || '';
                entityPopover.setDomainFilter(domain);
                entityPopover.popup();
            });
            entityRow.connect('changed', () => {
                configs[idx].entity_id = entityRow.text;
                expander.title = entityRow.text || `Entity ${idx + 1}`;
                saveConfigs();
            });
            expander.add_row(entityRow);
            this._sliderEntityEntryRows.push(entityRow);

            // Service row with search
            const serviceRow = new Adw.EntryRow({
                title: 'Service (domain.service)', text: cfg.service || 'light.turn_on',
            });
            const serviceSrcBtn = new Gtk.Button({
                icon_name: 'system-search-symbolic',
                valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Browse services',
            });
            serviceRow.add_suffix(serviceSrcBtn);

            const servicePopover = new ServiceSearchPopover((domain, service) => {
                serviceRow.text = `${domain}.${service}`;
                configs[idx].service = `${domain}.${service}`;
                expander.subtitle = `${domain}.${service}`;
                saveConfigs();
            });
            servicePopover.setFallbackServices();
            servicePopover.set_parent(serviceSrcBtn);
            serviceRow._servicePopover = servicePopover;

            serviceSrcBtn.connect('clicked', () => {
                const domain = (configs[idx].entity_id || '').split('.')[0] || '';
                servicePopover.setDomainFilter(domain);
                servicePopover.popup();
            });
            serviceRow.connect('changed', () => {
                configs[idx].service = serviceRow.text;
                expander.subtitle = serviceRow.text;
                saveConfigs();
            });
            expander.add_row(serviceRow);
            this._sliderServiceEntryRows.push(serviceRow);

            // Attribute row
            const attrRow = new Adw.EntryRow({
                title: 'Service Data Attribute', text: cfg.attribute || 'brightness',
            });
            attrRow.connect('changed', () => { configs[idx].attribute = attrRow.text; saveConfigs(); });
            expander.add_row(attrRow);

            // Min / Max row
            const rangeRow = new Adw.ActionRow({ title: 'Range (min / max)' });
            const minSpin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower: -10000, upper: 10000, step_increment: 1, value: Number(cfg.min ?? 0),
                }),
                digits: 0, valign: Gtk.Align.CENTER,
            });
            const maxSpin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower: -10000, upper: 10000, step_increment: 1, value: Number(cfg.max ?? 255),
                }),
                digits: 0, valign: Gtk.Align.CENTER,
            });
            rangeRow.add_suffix(minSpin);
            rangeRow.add_suffix(new Gtk.Label({ label: '–', valign: Gtk.Align.CENTER }));
            rangeRow.add_suffix(maxSpin);
            minSpin.connect('value-changed', () => { configs[idx].min = minSpin.value; saveConfigs(); });
            maxSpin.connect('value-changed', () => { configs[idx].max = maxSpin.value; saveConfigs(); });
            expander.add_row(rangeRow);

            // Remove row
            const removeRow = new Adw.ActionRow({ title: 'Remove this entity' });
            const removeBtn = new Gtk.Button({
                label: 'Remove',
                css_classes: ['destructive-action'],
                valign: Gtk.Align.CENTER,
            });
            removeRow.add_suffix(removeBtn);
            removeBtn.connect('clicked', () => {
                configs.splice(idx, 1);
                const sel = settings.get_strv('slider-selected')
                    .filter(e => configs.some(c => c.entity_id === e));
                settings.set_strv('slider-selected', sel);
                saveConfigs();
                this._rebuildSliderEntityRows(settings);
            });
            expander.add_row(removeRow);

            this._sliderEntitiesGroup.add(expander);
            this._sliderEntityRows.push(expander);
        }

        this._addSliderEntityBtn.sensitive = configs.length < 4;

        if (this._entities?.length > 0) this._distributeEntities();
        if (this._services?.length > 0) this._distributeServices();
    }

    // ── Update popovers with fresh HA data ───────────────────────────

    _distributeEntities() {
        for (const row of (this._colorEntityRows || [])) {
            row._entityPopover?.setEntities(this._entities);
            const entityId = row.subtitle;
            if (!entityId) continue;
            const friendly = this._entities.find(e => e.entity_id === entityId)?.attributes?.friendly_name;
            if (friendly) row.title = friendly;
        }

        for (const row of (this._sliderEntityEntryRows || []))
            row._entityPopover?.setEntities(this._entities);

        const colorLights = this._colorLightEntities();
        const syncConfigs = this._loadSyncConfigs(this._settings);
        for (let i = 0; i < (this._screenSyncEntityRows ?? []).length; i++) {
            const row = this._screenSyncEntityRows[i];
            row._entityPopover?.setEntities(colorLights);
            const cfg = syncConfigs[i];
            if (!cfg?.entity_id) continue;
            const friendly = this._entities.find(e => e.entity_id === cfg.entity_id)?.attributes?.friendly_name;
            if (friendly) row.title = friendly;
        }

        this._screenSyncConditionEntityRow?._entityPopover?.setEntities(this._entities);

        const configs = this._loadSliderConfigs(this._settings);
        for (let i = 0; i < configs.length && i < (this._sliderEntityRows?.length ?? 0); i++) {
            const entityId = configs[i].entity_id;
            if (!entityId) continue;
            const friendly = this._entities.find(e => e.entity_id === entityId)?.attributes?.friendly_name;
            if (friendly) this._sliderEntityRows[i].title = friendly;
        }
    }

    _distributeServices() {
        if (this._services.length > 0) {
            this._colorServiceRow._servicePopover?.setServices(this._services);
            for (const row of (this._sliderServiceEntryRows || []))
                row._servicePopover?.setServices(this._services);
        }
    }

    _repairPanelEntity(entityKey, serviceKey, row) {
        const entityId = this._settings.get_string(entityKey);
        const requiredDomain = getEntityDomain(this._settings.get_string(serviceKey));
        const nextEntityId = findReplacementEntityId(entityId, requiredDomain, this._entities);

        if (nextEntityId === entityId)
            return 0;

        row.text = nextEntityId;
        this._settings.set_string(entityKey, nextEntityId);
        return 1;
    }

    _repairButtonConfigs() {
        let repairs = 0;
        this._configs = this._configs.map(config => {
            const requiredDomain = String(config?.domain ?? '');
            const entityId = String(config?.entity_id ?? '');
            const nextEntityId = findReplacementEntityId(entityId, requiredDomain, this._entities);

            if (nextEntityId === entityId)
                return config;

            repairs++;
            return { ...config, entity_id: nextEntityId };
        });

        if (repairs > 0)
            this._saveConfigs();

        return repairs;
    }

    _repairLoadedConfigurations() {
        let repairs = 0;
        repairs += this._repairButtonConfigs();

        if (repairs > 0)
            this._rebuildList();

        return repairs;
    }

    _applyHAData() {
        this._entities = haDataStore.getEntities();
        this._services = haDataStore.getServices();

        this._distributeEntities();
        this._distributeServices();
        this._repairLoadedConfigurations();
    }

    _updateScreenSyncTransitionOptionVisibility() {
        const transition = this._settings.get_string('screen-sync-transition') || 'catmull-rom';
        const showHistory = transition === 'moving-average' || transition === 'catmull-rom';
        const showEma = transition === 'ema';
        const showSpring = transition === 'spring';

        if (this._screenSyncHistorySizeRow)
            this._screenSyncHistorySizeRow.visible = showHistory;
        if (this._screenSyncEmaTimeRow)
            this._screenSyncEmaTimeRow.visible = showEma;
        if (this._screenSyncSpringStiffnessRow)
            this._screenSyncSpringStiffnessRow.visible = showSpring;
        if (this._screenSyncSpringDampingRow)
            this._screenSyncSpringDampingRow.visible = showSpring;
        if (this._screenSyncTransitionSettingsGroup)
            this._screenSyncTransitionSettingsGroup.visible = showHistory || showEma || showSpring;
    }

    _updateScreenSyncSensitivity() {
        const enabled = this._screenSyncEnabledRow?.active ?? false;
        if (this._screenSyncEntitiesGroup)
            this._screenSyncEntitiesGroup.sensitive = enabled;
        if (this._screenSyncConditionGroup)
            this._screenSyncConditionGroup.sensitive = enabled;
        if (this._screenSyncTransitionSettingsGroup)
            this._screenSyncTransitionSettingsGroup.sensitive = enabled;
        if (this._browserBridgePriorityRow)
            this._browserBridgePriorityRow.sensitive = enabled;
        if (this._bridgeTabHeaderRow)
            this._bridgeTabHeaderRow.sensitive = enabled;
        for (const row of this._bridgeTabSelectorRows ?? [])
            row.sensitive = enabled;
        this._updateScreenSyncConditionConfigSensitivity();
        this._screenSyncIntervalRow.sensitive = enabled;
        this._screenSyncOutputIntervalRow.sensitive = enabled;
        this._screenSyncModeRow.sensitive = enabled;
        this._screenSyncTransitionRow.sensitive = enabled;
        this._screenSyncThresholdRow.sensitive = enabled;
        this._screenSyncScopeRow.sensitive = enabled;
        this._updateScreenSyncSourceUI();
    }

    _updateScreenSyncSourceUI() {
        if (this._screenSyncIntervalRow)
            this._screenSyncIntervalRow.visible = true;
        if (this._screenSyncModeRow)
            this._screenSyncModeRow.visible = true;
        if (this._screenSyncIdentifyRow)
            this._screenSyncIdentifyRow.visible = true;
        if (this._screenSyncPreviewRow)
            this._screenSyncPreviewRow.visible = true;
    }

    _buildBrowserBridgeRows(settings, parentGroup) {
        const connected = settings.get_boolean('browser-bridge-connected');

        this._browserBridgePriorityRow = new Adw.SwitchRow({
            title: 'Firefox Browser Bridge',
            subtitle: 'Use Firefox exclusively while connected; monitor sync resumes only after disconnect',
            active: settings.get_boolean('browser-bridge-priority'),
            visible: connected,
        });
        this._browserBridgePriorityRow.connect('notify::active', () => {
            settings.set_boolean('browser-bridge-priority', this._browserBridgePriorityRow.active);
        });
        parentGroup.add(this._browserBridgePriorityRow);

        this._bridgeTabHeaderRow = new Adw.ExpanderRow({
            title: 'Active YouTube Tab',
            subtitle: 'Choose which tab to use when multiple YouTube videos are open.',
            expanded: true,
            visible: false,
        });
        parentGroup.add(this._bridgeTabHeaderRow);

        this._bridgeTabSelectorRows = [];
        this._rebuildBridgeTabSelector(settings);

        this._bridgeSourceSettingsId = settings.connect('changed', (_s, key) => {
            if (key === 'browser-bridge-connected') {
                const isConnected = settings.get_boolean('browser-bridge-connected');
                this._browserBridgePriorityRow.visible = isConnected;
                this._rebuildBridgeTabSelector(settings);
            }
            if (key === 'browser-bridge-priority' && this._browserBridgePriorityRow)
                this._browserBridgePriorityRow.active = settings.get_boolean('browser-bridge-priority');
            if (key === 'browser-bridge-tab')
                this._rebuildBridgeTabSelector(settings);
            if (key === 'browser-bridge-tab-list')
                this._rebuildBridgeTabSelector(settings);
        });
    }

    _rebuildBridgeTabSelector(settings) {
        if (!this._bridgeTabHeaderRow) return;

        for (const row of this._bridgeTabSelectorRows ?? [])
            this._bridgeTabHeaderRow.remove(row);
        this._bridgeTabSelectorRows = [];

        const connected = settings.get_boolean('browser-bridge-connected');
        let tabs = [];
        try { tabs = JSON.parse(settings.get_string('browser-bridge-tab-list')); } catch {}

        if (this._bridgeTabHeaderRow)
            this._bridgeTabHeaderRow.visible = connected && tabs.length > 0;

        if (tabs.length === 0)
            return;
        const selected = settings.get_string('browser-bridge-tab') || 'auto';
        const enabled = this._screenSyncEnabledRow?.active ?? false;

        // "Auto" option
        const autoRow = new Adw.ActionRow({
            title: 'Auto',
            subtitle: 'Always use the focused YouTube tab',
            activatable: true,
            sensitive: enabled,
        });
        const autoCheck = new Gtk.CheckButton({
            active: selected === 'auto',
            can_target: false,
            focusable: false,
            valign: Gtk.Align.CENTER,
        });
        autoRow.add_suffix(autoCheck);
        autoRow.connect('activated', () => {
            settings.set_string('browser-bridge-tab', 'auto');
            this._rebuildBridgeTabSelector(settings);
        });
        this._bridgeTabHeaderRow.add_row(autoRow);
        this._bridgeTabSelectorRows.push(autoRow);

        // One row per open YT tab
        for (const tab of tabs) {
            const tabIdStr = String(tab.tabId);
            const title = (tab.title ?? tabIdStr).replace(/ [-–|].*YouTube.*$/i, '').trim() || `Tab ${tabIdStr}`;
            const tabRow = new Adw.ActionRow({
                title,
                subtitle: tab.active ? 'Currently in foreground' : 'Background tab',
                activatable: true,
                sensitive: enabled,
            });
            const check = new Gtk.CheckButton({
                active: selected === tabIdStr,
                can_target: false,
                focusable: false,
                valign: Gtk.Align.CENTER,
            });
            check.set_group(autoCheck);
            tabRow.add_suffix(check);
            tabRow.connect('activated', () => {
                settings.set_string('browser-bridge-tab', tabIdStr);
                this._rebuildBridgeTabSelector(settings);
            });
            this._bridgeTabHeaderRow.add_row(tabRow);
            this._bridgeTabSelectorRows.push(tabRow);
        }
    }

    async _showScreenSyncConditionLogs() {
        const entityId = String(this._screenSyncConditionEntityRow?.text ?? '').trim();
        if (!entityId) {
            this._showScreenSyncConditionLogsError('Choose a condition entity first.');
            return;
        }

        const url = this._settings.get_string('ha-url').trim();
        const token = this._settings.get_string('ha-token').trim();
        if (!url || !token) {
            this._showScreenSyncConditionLogsError('Home Assistant connection is missing. Configure URL and token in the Connection tab first.');
            return;
        }

        this._screenSyncConditionLogsPending = true;
        this._updateScreenSyncConditionActions();

        const client = new HaClient();
        client.setCredentials(url, token, this._settings.get_boolean('ha-verify-ssl'));

        try {
            const history = await client.getHistory(entityId, 24);
            const entries = history
                .map(entry => ({
                    state: formatHistoryState(entry?.state),
                    timestamp: entry?.last_changed ?? entry?.last_updated ?? '',
                }))
                .filter(entry => entry.timestamp || entry.state);

            this._showScreenSyncConditionLogsDialog(entityId, entries.reverse());
        } catch (e) {
            const message = e?.message ?? String(e);
            this._showScreenSyncConditionLogsError(`Could not load history for "${entityId}": ${message}`);
        } finally {
            client.destroy();
            this._screenSyncConditionLogsPending = false;
            this._updateScreenSyncConditionActions();
        }
    }

    _showScreenSyncConditionLogsError(message) {
        const dialog = new Adw.MessageDialog({
            transient_for: this.get_root(),
            heading: 'Condition Debug Failed',
            body: String(message ?? 'Unknown error'),
        });
        dialog.add_response('ok', 'OK');
        dialog.present();
    }

    _showScreenSyncConditionLogsDialog(entityId, entries) {
        const dialog = new Adw.Dialog({
            title: 'State Logs',
            content_width: 560,
        });

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16,
        });
        dialog.set_child(content);

        const summary = new Gtk.Label({
            label: `${entityId} · last 24 hours · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
            xalign: 0,
            wrap: true,
        });
        summary.add_css_class('dim-label');
        content.append(summary);

        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 320,
            max_content_height: 420,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        scroll.set_child(listBox);

        if (entries.length === 0) {
            listBox.append(new Adw.ActionRow({
                title: 'No state changes found',
                subtitle: 'Home Assistant returned no history entries for the last 24 hours.',
            }));
        } else {
            for (const entry of entries) {
                listBox.append(new Adw.ActionRow({
                    title: formatHistoryTimestamp(entry.timestamp),
                    subtitle: entry.state,
                    subtitle_selectable: true,
                }));
            }
        }

        content.append(scroll);

        const closeButton = new Gtk.Button({
            label: 'Close',
            css_classes: ['suggested-action'],
            halign: Gtk.Align.CENTER,
            margin_top: 4,
        });
        closeButton.connect('clicked', () => dialog.close());
        content.append(closeButton);

        dialog.present(this.get_root());
    }

    _requestScreenSyncPreview() {
        if (this._screenSyncPreviewPendingRequest)
            return;

        this._screenSyncPreviewPendingRequest = this._settings.get_int('screen-sync-preview-request') + 1;
        this._screenSyncPreviewButton.sensitive = false;
        this._screenSyncPreviewButton.label = 'Sampling…';
        this._settings.set_string('screen-sync-preview-error', '');
        this._settings.set_string('screen-sync-preview-dominant', '');
        this._settings.set_string('screen-sync-preview-average', '');
        this._settings.set_string('screen-sync-preview-vibrant', '');
        this._settings.set_string('screen-sync-preview-accent', '');
        this._settings.set_string('screen-sync-preview-backlight', '');
        this._settings.set_int('screen-sync-preview-request', this._screenSyncPreviewPendingRequest);

        this._screenSyncPreviewTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            const stillPending = this._screenSyncPreviewPendingRequest !== 0;
            this._finishScreenSyncPreviewRequest();
            if (stillPending) {
                this._showScreenSyncPreviewError(
                    'No preview response arrived from the running extension. The preview only works while HAControlPanel is enabled in GNOME Shell.'
                );
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _handleScreenSyncPreviewResponse() {
        const responseId = this._settings.get_int('screen-sync-preview-response');
        if (!this._screenSyncPreviewPendingRequest || responseId !== this._screenSyncPreviewPendingRequest)
            return;

        const error = this._settings.get_string('screen-sync-preview-error').trim();
        const dominant = this._settings.get_string('screen-sync-preview-dominant').trim();
        const average = this._settings.get_string('screen-sync-preview-average').trim();
        const vibrant = this._settings.get_string('screen-sync-preview-vibrant').trim();
        const accent = this._settings.get_string('screen-sync-preview-accent').trim();
        const backlight = this._settings.get_string('screen-sync-preview-backlight').trim();

        this._finishScreenSyncPreviewRequest();

        if (error) {
            this._showScreenSyncPreviewError(error);
            return;
        }

        this._showScreenSyncPreviewDialog({ dominant, average, vibrant, accent, backlight });
    }

    _finishScreenSyncPreviewRequest() {
        if (this._screenSyncPreviewTimeoutId) {
            GLib.source_remove(this._screenSyncPreviewTimeoutId);
            this._screenSyncPreviewTimeoutId = null;
        }

        this._screenSyncPreviewPendingRequest = 0;
        if (this._screenSyncPreviewButton) {
            this._screenSyncPreviewButton.sensitive = true;
            this._screenSyncPreviewButton.label = 'Preview';
        }
    }

    _identifyDisplays() {
        if (this._identifyTimeoutId) {
            GLib.source_remove(this._identifyTimeoutId);
            this._identifyTimeoutId = null;
        }

        if (this._identifyButton)
            this._identifyButton.sensitive = false;

        // Trigger the extension-side overlay via a GSettings nonce
        const nonce = Math.max(1, Date.now() & 0x7fffffff);
        this._settings.set_int('screen-sync-identify-request', nonce);

        // Re-enable button after overlays auto-dismiss (3s display + 0.5s fade buffer)
        this._identifyTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
            this._identifyTimeoutId = null;
            if (this._identifyButton)
                this._identifyButton.sensitive = true;
            return GLib.SOURCE_REMOVE;
        });
    }

    _showScreenSyncPreviewError(message) {
        const dialog = new Adw.MessageDialog({
            transient_for: this.get_root(),
            heading: 'Screen Sync Preview Failed',
            body: String(message ?? 'Unknown error'),
        });
        dialog.add_response('ok', 'OK');
        dialog.present();
    }

    _showScreenSyncPreviewDialog(preview) {
        const dialog = new Adw.Dialog({
            title: 'Screen Sync Preview',
            content_width: 440,
        });

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16,
        });
        dialog.set_child(content);

        // ── Color swatches ────────────────────────────────────────────
        const swatchRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            homogeneous: true,
        });
        for (const [name, hex] of [
            ['Dominant', preview.dominant],
            ['Average',  preview.average],
            ['Vibrant',  preview.vibrant],
            ['Accent',   preview.accent],
            ['Backlight', preview.backlight],
        ])
            swatchRow.append(this._createScreenSyncPreviewSwatch(name, hex));
        content.append(swatchRow);

        // ── Mode descriptions ─────────────────────────────────────────
        const currentMode = this._settings.get_string('screen-sync-mode') || 'dominant';
        const modeDescriptions = [
            ['Dominant', 'Groups pixels into coarse buckets and picks the largest cluster.'],
            ['Average', 'Blends all sampled pixels equally — can drift toward grey.'],
            ['Vibrant', 'Weights saturated and bright buckets more strongly to avoid washed-out results.'],
            ['Accent', 'Heavily prefers the most saturated samples for vivid, punchy colors.'],
            ['Backlight', 'Like dominant but with maximum saturation boost — ideal for LED strips behind the screen.'],
        ];

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        for (const [name, desc] of modeDescriptions) {
            const isActive = name.toLowerCase() === currentMode;
            const row = new Adw.ActionRow({
                title: isActive ? `<b>${name}</b> ✓` : name,
                subtitle: desc,
                use_markup: true,
            });
            listBox.append(row);
        }
        content.append(listBox);

        const closeButton = new Gtk.Button({
            label: 'Close',
            css_classes: ['suggested-action'],
            halign: Gtk.Align.CENTER,
            margin_top: 4,
        });
        closeButton.connect('clicked', () => dialog.close());
        content.append(closeButton);

        dialog.present(this.get_root());
    }

    _createScreenSyncPreviewSwatch(title, hex) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
        });

        const [red, green, blue] = this._parsePreviewHex(hex);
        const area = new Gtk.DrawingArea({
            content_width: 120,
            content_height: 56,
            hexpand: true,
            vexpand: false,
        });
        area.set_draw_func((_area, cr, width, height) => {
            const radius = 6;
            cr.newSubPath();
            cr.arc(radius, radius, radius, Math.PI, -Math.PI / 2);
            cr.arc(width - radius, radius, radius, -Math.PI / 2, 0);
            cr.arc(width - radius, height - radius, radius, 0, Math.PI / 2);
            cr.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
            cr.closePath();
            cr.setSourceRGBA(red / 255, green / 255, blue / 255, 1);
            cr.fill();
        });
        box.append(area);

        const titleLabel = new Gtk.Label({
            label: title,
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });
        titleLabel.add_css_class('caption');
        box.append(titleLabel);

        const valueLabel = new Gtk.Label({
            label: hex || '—',
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });
        valueLabel.add_css_class('dim-label');
        valueLabel.add_css_class('caption');
        box.append(valueLabel);

        return box;
    }

    _parsePreviewHex(hex) {
        const match = String(hex ?? '').trim().match(/^#?([0-9a-fA-F]{6})$/);
        if (!match)
            return [80, 80, 80];

        const value = match[1];
        return [
            parseInt(value.slice(0, 2), 16),
            parseInt(value.slice(2, 4), 16),
            parseInt(value.slice(4, 6), 16),
        ];
    }

    // ── Button list ──────────────────────────────────────────────────

    _rebuildList() {
        if (this._buttonListRows) {
            for (const r of this._buttonListRows)
                this._buttonsGroup.remove(r);
        }
        this._buttonListRows = [];

        for (let i = 0; i < this._configs.length; i++) {
            const row = new ButtonListRow(
                this._configs[i], i,
                idx => this._openEditDialog(idx, this._configs[idx]),
                idx => this._confirmDeleteButton(idx)
            );
            this._buttonsGroup.add(row);
            this._buttonListRows.push(row);
        }
    }

    async _openEditDialog(index, config) {
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

    _confirmDeleteButton(index) {
        const config = this._configs[index];
        if (!config)
            return;

        const label = String(config.label ?? '').trim() || `Button ${index + 1}`;
        const dialog = new Adw.MessageDialog({
            transient_for: this.get_root(),
            heading: 'Delete Button?',
            body: `Remove "${escapeMarkup(label)}" from the panel?`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'delete')
                this._deleteButton(index);
        });
        dialog.present();
    }

    _deleteButton(index) {
        this._configs.splice(index, 1);
        this._saveConfigs();
        this._rebuildList();
    }

    _loadConfigs() {
        return readButtonsConfig(this._settings);
    }

    _saveConfigs() {
        this._settings.set_int('button-count', this._configs.length);
        this._settings.set_string('buttons-config', JSON.stringify(this._configs));
    }

    vfunc_unroot() {
        if (this._haDataChangedId) {
            haDataStore.disconnect(this._haDataChangedId);
            this._haDataChangedId = null;
        }

        if (this._screenSyncPreviewResponseId) {
            this._settings.disconnect(this._screenSyncPreviewResponseId);
            this._screenSyncPreviewResponseId = null;
        }

        for (const id of this._screenSyncConditionSettingsIds ?? [])
            this._settings.disconnect(id);
        this._screenSyncConditionSettingsIds = [];

        if (this._identifyTimeoutId) {
            GLib.source_remove(this._identifyTimeoutId);
            this._identifyTimeoutId = null;
        }

        if (this._bridgeSourceSettingsId) {
            this._settings.disconnect(this._bridgeSourceSettingsId);
            this._bridgeSourceSettingsId = null;
        }

        this._disconnectScreenSyncConditionLiveClient();
        this._finishScreenSyncPreviewRequest();

        super.vfunc_unroot();
    }
});
