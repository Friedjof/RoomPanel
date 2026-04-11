import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { SensorValueTile } from './sensorValueTile.js';
import { SensorGaugeTile } from './sensorGaugeTile.js';
import { SensorTrendTile } from './sensorTrendTile.js';
import { readSensorWidgets } from '../lib/configAdapters.js';
import { getNumericValue } from './sensorHelpers.js';

/**
 * Read-only sensor section of the panel menu.
 *
 * Renders a 2-column tile grid (value/gauge = half-width by default,
 * trend and span='full' always full-width).  Live-updates tiles when
 * onStateChanged() is called by panelMenu.
 *
 * @param {Gio.Settings} settings
 * @param {HaClient}     haClient
 */
export class SensorSection {
    constructor(settings, haClient) {
        this._settings     = settings;
        this._haClient     = haClient;
        this._stateCache   = {};   // entityId → last HA state object
        this._tiles        = [];   // [{config, tile}]
        this._settingsChangedId = null;

        this._menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this._separator.add_style_class_name('roompanel-separator');

        this._buildGrid();
        this._connectSettings();
    }

    /** PopupBaseMenuItem containing the tile grid. */
    getMenuItem() { return this._menuItem; }

    /** Separator shown above the sensor section. */
    getSeparator() { return this._separator; }

    /** Fetch current HA state for every configured sensor entity. */
    async hydrateFromHA() {
        const configs   = readSensorWidgets(this._settings);
        const entityIds = [...new Set(configs.map(c => c.entity_id).filter(Boolean))];

        for (const entityId of entityIds) {
            try {
                const state = await this._haClient.getState(entityId);
                if (state) {
                    this._stateCache[entityId] = state;
                    this._updateTilesFor(entityId, state);
                }
            } catch { /* no connection yet */ }
        }

        const trendConfigs = configs.filter(c => c.entity_id && c.widget_type === 'trend');
        for (const cfg of trendConfigs)
            await this._hydrateTrendHistory(cfg);
    }

    /** Called by panelMenu for every incoming state_changed WebSocket event. */
    onStateChanged(entityId, newState) {
        if (!newState) return;
        const configs = readSensorWidgets(this._settings);
        if (!configs.some(c => c.entity_id === entityId)) return;

        this._stateCache[entityId] = newState;
        this._updateTilesFor(entityId, newState);
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._clearTiles();
    }

    // ── Grid construction ────────────────────────────────────────────────────

    _buildGrid() {
        this._clearTiles();

        // Remove old container if it exists
        for (const child of this._menuItem.get_children())
            this._menuItem.remove_child(child);

        const configs = readSensorWidgets(this._settings)
            .filter(c => c.entity_id);

        const box = new St.BoxLayout({ vertical: true, x_expand: true });
        box.add_style_class_name('roompanel-menu');
        box.add_style_class_name('roompanel-sensors-grid');
        this._menuItem.add_child(box);

        if (configs.length === 0) {
            box.add_child(new St.Label({
                text: 'No sensor widgets configured',
                style_class: 'roompanel-sensor-empty-title',
            }));
            box.add_child(new St.Label({
                text: 'Open Settings → Sensors to add read-only sensor tiles.',
                style_class: 'roompanel-sensor-empty-subtitle',
            }));
            return;
        }

        // Layout: pair half-span tiles side-by-side; full-span and trend get own row
        let pending = null; // a half-span {config, tile} waiting for a partner

        for (const cfg of configs) {
            const tile = this._makeTile(cfg);
            this._tiles.push({ config: cfg, tile });

            // Seed immediately from cache
            if (this._stateCache[cfg.entity_id])
                tile.update(this._stateCache[cfg.entity_id]);

            const isFullSpan = cfg.widget_type === 'trend' || cfg.span === 'full';

            if (isFullSpan) {
                if (pending) {
                    this._addRow(box, [pending.tile]);
                    pending = null;
                }
                this._addRow(box, [tile]);
            } else {
                if (pending) {
                    this._addRow(box, [pending.tile, tile]);
                    pending = null;
                } else {
                    pending = { config: cfg, tile };
                }
            }
        }

        if (pending)
            this._addRow(box, [pending.tile]);
    }

    _addRow(box, tiles) {
        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-sensor-row',
        });
        for (const t of tiles)
            row.add_child(t.getActor());
        box.add_child(row);
    }

    _makeTile(config) {
        switch (config.widget_type) {
            case 'gauge': return new SensorGaugeTile(config);
            case 'trend': return new SensorTrendTile(config);
            default:      return new SensorValueTile(config);
        }
    }

    _clearTiles() {
        for (const { tile } of this._tiles)
            tile.destroy();
        this._tiles = [];
    }

    _updateTilesFor(entityId, state) {
        for (const { config, tile } of this._tiles) {
            if (config.entity_id === entityId)
                tile.update(state);
        }
    }

    async _hydrateTrendHistory(config) {
        try {
            const history = await this._haClient.getHistory(config.entity_id, 24);
            const samples = history
                .map(state => getNumericValue(config, state))
                .filter(value => value !== null);

            for (const { config: tileConfig, tile } of this._tiles) {
                if (
                    tileConfig.entity_id === config.entity_id &&
                    tileConfig.widget_type === 'trend' &&
                    typeof tile.setHistorySamples === 'function'
                ) {
                    tile.setHistorySamples(samples);
                }
            }
        } catch {
            /* history endpoint unavailable or entity missing */
        }
    }

    _connectSettings() {
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'sensor-widgets-config') {
                this._buildGrid();
                void this.hydrateFromHA();
            }
        });
    }
}
