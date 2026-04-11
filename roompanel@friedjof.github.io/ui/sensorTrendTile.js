import Cairo from 'cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import { formatDisplayValue, getNumericValue, getUnit, getIcon, getName } from './sensorHelpers.js';

const MAX_SAMPLES = 30;

const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'roompanel-sparkline',
            height: 28,
            x_expand: true,
        });
        this._samples = [];
        this.connect('repaint', () => this._repaint());
    }

    setSamples(samples) {
        this._samples = samples;
        this.queue_repaint();
    }

    _repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        if (!w || !h || this._samples.length < 2) {
            cr.$dispose();
            return;
        }

        const vals = this._samples;
        const minV = Math.min(...vals);
        const maxV = Math.max(...vals);
        const range = maxV - minV || 1;
        const n = vals.length;
        const pad = 3;

        // Line
        cr.setSourceRGBA(1, 1, 1, 0.50);
        cr.setLineWidth(1.5);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);

        for (let i = 0; i < n; i++) {
            const x = pad + (i / (n - 1)) * (w - pad * 2);
            const y = h - pad - ((vals[i] - minV) / range) * (h - pad * 2);
            if (i === 0) cr.moveTo(x, y);
            else         cr.lineTo(x, y);
        }
        cr.stroke();

        // Dot at the latest value
        const lx = w - pad;
        const ly = h - pad - ((vals[n - 1] - minV) / range) * (h - pad * 2);
        cr.arc(lx, ly, 2.5, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 0.85);
        cr.fill();

        cr.$dispose();
    }
});

/**
 * Trend tile: icon | name (left) + value unit (right) + sparkline below.
 * Always full-width (trend tiles need horizontal space for the sparkline).
 */
export class SensorTrendTile {
    constructor(config) {
        this._config  = config;
        this._samples = [];
        this._build();
    }

    getActor() { return this._actor; }

    setHistorySamples(samples) {
        if (!Array.isArray(samples) || samples.length === 0) {
            this._samples = [];
            this._sparkline.setSamples([]);
            return;
        }

        const numeric = samples.filter(value => Number.isFinite(value));
        if (numeric.length === 0) {
            this._samples = [];
            this._sparkline.setSamples([]);
            return;
        }

        const step = Math.max(1, Math.ceil(numeric.length / MAX_SAMPLES));
        const reduced = [];

        for (let i = 0; i < numeric.length; i += step)
            reduced.push(numeric[i]);

        const last = numeric[numeric.length - 1];
        if (reduced[reduced.length - 1] !== last)
            reduced.push(last);

        this._samples = reduced.slice(-MAX_SAMPLES);
        this._sparkline.setSamples([...this._samples]);
    }

    /** Push a new numeric sample into the sparkline buffer. */
    pushSample(value) {
        if (!Number.isFinite(value)) return;
        const previous = this._samples[this._samples.length - 1];
        if (previous === value)
            return;
        this._samples.push(value);
        if (this._samples.length > MAX_SAMPLES)
            this._samples.shift();
        this._sparkline.setSamples([...this._samples]);
    }

    _build() {
        this._actor = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'roompanel-sensor-tile',
        });

        // Top row: icon | name (fills) | value unit
        const topRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-sensor-trend-top',
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

        this._nameLabel = new St.Label({
            text: '',
            style_class: 'roompanel-sensor-name roompanel-sensor-trend-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._nameLabel.clutter_text.line_wrap = false;
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add_child(this._nameLabel);

        const valueRow = new St.BoxLayout({ vertical: false });
        topRow.add_child(valueRow);

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

        // Sparkline
        this._sparkline = new Sparkline();
        this._actor.add_child(this._sparkline);
    }

    update(state) {
        this._valueLabel.text = formatDisplayValue(this._config, state);
        this._unitLabel.text  = getUnit(this._config, state);
        this._nameLabel.text  = getName(this._config, state);
        this._iconActor.icon_name = getIcon(this._config, state);

        const numeric = getNumericValue(this._config, state);
        if (numeric !== null)
            this.pushSample(numeric);
    }

    destroy() {}
}
