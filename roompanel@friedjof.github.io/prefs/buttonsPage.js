import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { haDataStore } from './haDataStore.js';
import { escapeMarkup, getEntityDomain, findReplacementEntityId } from './utils.js';
import { EntitySearchPopover } from './popovers/entitySearch.js';
import { ServiceSearchPopover } from './popovers/serviceSearch.js';
import { ButtonListRow, ButtonEditDialog } from './dialogs/buttonEdit.js';

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
        this._entities = haDataStore.getEntities();
        this._services = haDataStore.getServices();
        this._configs = this._loadConfigs();
        this._haDataChangedId = haDataStore.connect('changed', () => this._applyHAData());

        const infoGroup = new Adw.PreferencesGroup({
            title: 'Entity Search',
            description: 'Entities and services are loaded from the Connection tab.',
        });
        this.add(infoGroup);

        infoGroup.add(new Adw.ActionRow({
            title: 'Data Source',
            subtitle: 'Open Connection to refresh Home Assistant entities and services for the search fields below.',
            activatable: false,
        }));

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

    // ── Slider config helpers ─────────────────────────────────────────

    _loadSliderConfigs(settings) {
        try {
            const parsed = JSON.parse(settings.get_string('slider-entities-config') || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
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
        try { return JSON.parse(this._settings.get_string('buttons-config')); }
        catch { return []; }
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

        super.vfunc_unroot();
    }
});
