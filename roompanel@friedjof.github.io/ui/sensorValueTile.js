import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import { formatDisplayValue, getUnit, getIcon, getName } from './sensorHelpers.js';

/**
 * Compact value tile: icon circle | value unit / name.
 * Default span is 'half' (two tiles per row).
 */
export class SensorValueTile {
    constructor(config) {
        this._config = config;
        this._build();
    }

    getActor() { return this._actor; }

    _build() {
        this._actor = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-sensor-tile',
        });

        // Icon circle
        const iconWrap = new St.Bin({
            style_class: 'roompanel-sensor-icon-wrap',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconActor = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'roompanel-sensor-icon',
        });
        iconWrap.set_child(this._iconActor);
        this._actor.add_child(iconWrap);

        // Text column
        const col = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-sensor-col',
        });
        this._actor.add_child(col);

        this._nameLabel = new St.Label({
            text: '',
            style_class: 'roompanel-sensor-name roompanel-sensor-name-top',
            x_expand: true,
        });
        this._nameLabel.clutter_text.line_wrap = false;
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(this._nameLabel);

        const valueRow = new St.BoxLayout({
            vertical: false,
            style_class: 'roompanel-sensor-value-row',
        });
        col.add_child(valueRow);

        this._valueLabel = new St.Label({
            text: '—',
            style_class: 'roompanel-sensor-value',
            y_align: Clutter.ActorAlign.END,
        });
        valueRow.add_child(this._valueLabel);

        this._unitLabel = new St.Label({
            text: '',
            style_class: 'roompanel-sensor-unit',
            y_align: Clutter.ActorAlign.END,
        });
        valueRow.add_child(this._unitLabel);
    }

    update(state) {
        this._valueLabel.text = formatDisplayValue(this._config, state);
        this._unitLabel.text = getUnit(this._config, state);
        this._nameLabel.text = getName(this._config, state);
        this._iconActor.icon_name = getIcon(this._config, state);
    }

    destroy() {}
}
