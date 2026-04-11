import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function rgbToHsv([r, g, b]) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
        if (max === red)
            hue = 60 * (((green - blue) / delta) % 6);
        else if (max === green)
            hue = 60 * (((blue - red) / delta) + 2);
        else
            hue = 60 * (((red - green) / delta) + 4);
    }

    if (hue < 0)
        hue += 360;

    return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(hue, saturation, value) {
    const chroma = value * saturation;
    const sector = hue / 60;
    const x = chroma * (1 - Math.abs((sector % 2) - 1));

    let red = 0;
    let green = 0;
    let blue = 0;

    if (sector >= 0 && sector < 1)
        [red, green, blue] = [chroma, x, 0];
    else if (sector < 2)
        [red, green, blue] = [x, chroma, 0];
    else if (sector < 3)
        [red, green, blue] = [0, chroma, x];
    else if (sector < 4)
        [red, green, blue] = [0, x, chroma];
    else if (sector < 5)
        [red, green, blue] = [x, 0, chroma];
    else
        [red, green, blue] = [chroma, 0, x];

    const match = value - chroma;
    return [
        Math.round((red + match) * 255),
        Math.round((green + match) * 255),
        Math.round((blue + match) * 255),
    ];
}

export function rgbToHex([r, g, b]) {
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export const ColorWheel = GObject.registerClass({
    Signals: {
        'color-changed': {},
        'color-selected': {},
    },
}, class ColorWheel extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            style_class: 'roompanel-color-wheel',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: 156,
            height: 156,
            ...params,
        });

        this._padding = 8;
        this._dragging = false;
        this._selectionDirty = false;
        this._rgb = [255, 255, 255];
        this._wheelSurface = null;
        this._wheelSurfaceKey = '';

        this.connect('repaint', () => this._repaint());
        this.connect('button-press-event', (_actor, event) => this._onButtonPress(event));
        this.connect('motion-event', (_actor, event) => this._onMotion(event));
        this.connect('button-release-event', () => this._onButtonRelease());
    }

    setColor(rgb) {
        this._rgb = rgb.map(component => clamp(Math.round(component), 0, 255));
        this.queue_repaint();
    }

    getColor() {
        return [...this._rgb];
    }

    _onButtonPress(event) {
        this._dragging = true;
        this._selectionDirty = false;
        this.grab_key_focus();
        this._pickColorFromEvent(event);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        this._pickColorFromEvent(event);
        return Clutter.EVENT_STOP;
    }

    _onButtonRelease() {
        if (this._dragging && this._selectionDirty)
            this.emit('color-selected');

        this._dragging = false;
        this._selectionDirty = false;
        return Clutter.EVENT_STOP;
    }

    _pickColorFromEvent(event) {
        const [stageX, stageY] = event.get_coords();
        const [ok, localX, localY] = this.transform_stage_point(stageX, stageY);
        if (!ok)
            return;

        const rgb = this._colorAtPoint(localX, localY);
        if (!rgb)
            return;

        this.setColor(rgb);
        this._selectionDirty = true;
        this.emit('color-changed');
    }

    _colorAtPoint(x, y) {
        const [width, height] = this.get_size();
        const radius = Math.max(Math.min(width, height) / 2 - this._padding, 1);
        const dx = x - width / 2;
        const dy = y - height / 2;
        const distance = Math.hypot(dx, dy);

        if (distance > radius)
            return null;

        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const saturation = clamp(distance / radius, 0, 1);
        return hsvToRgb(hue, saturation, 1);
    }

    _ensureWheelSurface(width, height) {
        const key = `${width}x${height}`;
        if (this._wheelSurface && this._wheelSurfaceKey === key)
            return;

        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
        const cr = new Cairo.Context(surface);
        const radius = Math.max(Math.min(width, height) / 2 - this._padding, 1);
        const centerX = width / 2;
        const centerY = height / 2;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dx = x - centerX;
                const dy = y - centerY;
                const distance = Math.hypot(dx, dy);
                if (distance > radius)
                    continue;

                const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
                const saturation = clamp(distance / radius, 0, 1);
                const [red, green, blue] = hsvToRgb(hue, saturation, 1);
                cr.setSourceRGBA(red / 255, green / 255, blue / 255, 1);
                cr.rectangle(x, y, 1, 1);
                cr.fill();
            }
        }

        cr.$dispose();
        surface.flush();
        this._wheelSurface = surface;
        this._wheelSurfaceKey = key;
    }

    _repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (!width || !height)
            return;

        this._ensureWheelSurface(width, height);

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        cr.setSourceSurface(this._wheelSurface, 0, 0);
        cr.paint();

        const radius = Math.max(Math.min(width, height) / 2 - this._padding, 1);
        const [hue, saturation] = rgbToHsv(this._rgb);
        const angle = (hue * Math.PI) / 180;
        const markerX = width / 2 + Math.cos(angle) * radius * saturation;
        const markerY = height / 2 + Math.sin(angle) * radius * saturation;

        cr.setLineWidth(2);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.arc(markerX, markerY, 8, 0, Math.PI * 2);
        cr.strokePreserve();
        cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.fill();
        cr.$dispose();
    }
});
