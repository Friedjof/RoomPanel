import Cairo from 'cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import { formatDisplayValue, getNumericValue, getUnit, getIcon, getName, getSeverityColor } from './sensorHelpers.js';

// ok=#4caf50  warn=#ffb300  alert=#e53935
const SEVERITY_RGBA = {
    ok:    [0.298, 0.686, 0.314, 0.90],
    warn:  [1.000, 0.702, 0.000, 0.90],
    alert: [0.898, 0.224, 0.208, 0.90],
};

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + r,     y + r,     r, Math.PI,       1.5 * Math.PI);
    cr.arc(x + w - r, y + r,     r, 1.5 * Math.PI, 2 * Math.PI);
    cr.arc(x + w - r, y + h - r, r, 0,             0.5 * Math.PI);
    cr.arc(x + r,     y + h - r, r, 0.5 * Math.PI, Math.PI);
    cr.closePath();
}

const GaugeBar = GObject.registerClass(
class GaugeBar extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'roompanel-gauge-bar',
            height: 6,
            x_expand: true,
        });
        this._ratio    = 0;
        this._colorKey = 'ok';
        this.connect('repaint', () => this._repaint());
    }

    set ratio(v) {
        this._ratio = Math.max(0, Math.min(1, Number(v) || 0));
        this.queue_repaint();
    }

    set colorKey(v) {
        this._colorKey = v;
        this.queue_repaint();
    }

    _repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        if (!w || !h) { cr.$dispose(); return; }

        const r = h / 2;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        // Track background
        roundedRect(cr, 0, 0, w, h, r);
        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.fill();

        // Filled portion
        if (this._ratio > 0.004) {
            const fillW = Math.max(h, w * this._ratio); // minimum = full circle
            roundedRect(cr, 0, 0, fillW, h, r);
            const [rr, g, b, a] = SEVERITY_RGBA[this._colorKey] ?? SEVERITY_RGBA.ok;
            cr.setSourceRGBA(rr, g, b, a);
            cr.fill();
        }

        cr.$dispose();
    }
});

/**
 * Gauge tile: icon | value unit / name + horizontal fill bar.
 * Default span is 'half'; set span='full' in config for full-width.
 */
export class SensorGaugeTile {
    constructor(config) {
        this._config = config;
        this._build();
    }

    getActor() { return this._actor; }

    _build() {
        this._actor = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-sensor-tile',
        });

        const topRow = new St.BoxLayout({
            vertical: false,
            style_class: 'roompanel-sensor-gauge-top',
        });
        this._actor.add_child(topRow);

        const iconWrap = new St.Bin({
            style_class: 'roompanel-sensor-icon-wrap',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconActor = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'roompanel-sensor-icon',
        });
        iconWrap.set_child(this._iconActor);
        topRow.add_child(iconWrap);

        const col = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-sensor-col',
        });
        topRow.add_child(col);

        this._nameLabel = new St.Label({
            text: '',
            style_class: 'roompanel-sensor-name roompanel-sensor-name-top',
            x_expand: true,
        });
        this._nameLabel.clutter_text.line_wrap = false;
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        col.add_child(this._nameLabel);

        const valueRow = new St.BoxLayout({ vertical: false });
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

        this._gaugeBar = new GaugeBar();
        this._actor.add_child(this._gaugeBar);
    }

    update(state) {
        const numeric = getNumericValue(this._config, state);

        this._valueLabel.text = formatDisplayValue(this._config, state);
        this._unitLabel.text  = getUnit(this._config, state);
        this._nameLabel.text  = getName(this._config, state);
        this._iconActor.icon_name = getIcon(this._config, state);

        if (numeric !== null) {
            const min = Number(this._config.min ?? 0);
            const max = Number(this._config.max ?? 100);
            this._gaugeBar.ratio    = max > min ? (numeric - min) / (max - min) : 0;
            this._gaugeBar.colorKey = getSeverityColor(this._config.severity, numeric);
        }
    }

    destroy() {}
}
