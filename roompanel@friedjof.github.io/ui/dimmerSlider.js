import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/**
 * Draw a rounded rectangle path (pill when r = h/2).
 * Caller must call fill() or stroke() afterwards.
 */
function roundedRect(cr, x, y, w, h, r) {
    r = clamp(r, 0, Math.min(w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + r,         y + r,         r, Math.PI,         1.5 * Math.PI);
    cr.arc(x + w - r,     y + r,         r, 1.5 * Math.PI,   2 * Math.PI);
    cr.arc(x + w - r,     y + h - r,     r, 0,               0.5 * Math.PI);
    cr.arc(x + r,         y + h - r,     r, 0.5 * Math.PI,   Math.PI);
    cr.closePath();
}

/**
 * HA-style dimmer slider rendered with Cairo.
 *
 * Signals:
 *   value-changed  – emitted on every drag step (user interaction only,
 *                    NOT when .value is set programmatically)
 */
export const DimmerSlider = GObject.registerClass({
    Signals: { 'value-changed': {} },
}, class DimmerSlider extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            style_class: 'roompanel-dimmer-slider',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            height: 34,
            ...params,
        });

        this._value = 0;
        this._dragging = false;

        this.connect('repaint', () => this._repaint());
        this.connect('button-press-event', (_a, ev) => this._onPress(ev));
        this.connect('motion-event', (_a, ev) => this._onMotion(ev));
        this.connect('button-release-event', () => this._onRelease());
    }

    /** Current value in [0, 1]. Setting this only redraws — no signal fired. */
    get value() { return this._value; }

    set value(v) {
        this._value = clamp(Number(v) || 0, 0, 1);
        this.queue_repaint();
    }

    // ── Event handling ───────────────────────────────────────────────────────

    _valueFromEvent(event) {
        const [sx, sy] = event.get_coords();
        const [ok, lx] = this.transform_stage_point(sx, sy);
        if (!ok) return null;
        const [width] = this.get_size();
        const pad = 10;
        return clamp((lx - pad) / Math.max(1, width - pad * 2), 0, 1);
    }

    _onPress(event) {
        this._dragging = true;
        this.grab_key_focus();
        const v = this._valueFromEvent(event);
        if (v !== null) {
            this._value = v;
            this.queue_repaint();
            this.emit('value-changed');
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        const v = this._valueFromEvent(event);
        if (v !== null) {
            this._value = v;
            this.queue_repaint();
            this.emit('value-changed');
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        this._dragging = false;
        return Clutter.EVENT_STOP;
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    _repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (!width || !height) { cr.$dispose(); return; }

        const r = height / 2;

        // Clear
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        // ── Track background (dark pill) ──────────────────────────────────
        roundedRect(cr, 0, 0, width, height, r);
        cr.setSourceRGBA(0.08, 0.08, 0.08, 0.88);
        cr.fill();

        // ── Lit fill: warm amber → bright warm white ──────────────────────
        if (this._value > 0.004) {
            const fillW = width * this._value;
            roundedRect(cr, 0, 0, fillW, height, r);

            const grad = new Cairo.LinearGradient(0, 0, width, 0);
            grad.addColorStopRGBA(0,    0.50, 0.22, 0.02, 0.90); // dim candlelight
            grad.addColorStopRGBA(0.45, 0.92, 0.60, 0.12, 0.92); // warm amber
            grad.addColorStopRGBA(1,    1.00, 0.94, 0.76, 0.95); // bright warm white
            cr.setSource(grad);
            cr.fill();
        }

        // ── Inner highlight: subtle top gloss ─────────────────────────────
        if (this._value > 0.004) {
            const fillW = width * this._value;
            const glossH = height * 0.45;
            roundedRect(cr, 0, 0, fillW, glossH, r);
            const gloss = new Cairo.LinearGradient(0, 0, 0, glossH);
            gloss.addColorStopRGBA(0, 1, 1, 1, 0.18);
            gloss.addColorStopRGBA(1, 1, 1, 1, 0.0);
            cr.setSource(gloss);
            cr.fill();
        }

        // ── Handle: white vertical bar ────────────────────────────────────
        const hx = width * this._value;
        const inset = Math.round(height * 0.2);
        cr.setLineWidth(2);
        cr.setSourceRGBA(1, 1, 1, 0.90);
        cr.moveTo(hx, inset);
        cr.lineTo(hx, height - inset);
        cr.stroke();

        // Small handle cap (circle) for grip affordance
        cr.arc(hx, height / 2, 3.5, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.fill();

        cr.$dispose();
    }
});
