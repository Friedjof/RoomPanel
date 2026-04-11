import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

/** Relative luminance of a hex color (0 = black, 1 = white). */
function _luma(hex) {
    const m = hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (!m) return 0.5;
    const r = parseInt(m[1], 16) / 255;
    const g = parseInt(m[2], 16) / 255;
    const b = parseInt(m[3], 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function _entityMatchesDomain(entityId, domain) {
    return !entityId || !domain || entityId.split('.')[0] === domain;
}

function _hexToRgba(hex, alpha) {
    const m = hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (!m)
        return null;

    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** "light.wohnzimmer_tisch" → "wohnzimmer tisch" */
function _formatEntity(entityId) {
    if (!entityId) return '';
    const dot = entityId.indexOf('.');
    return (dot >= 0 ? entityId.slice(dot + 1) : entityId).replace(/_/g, ' ');
}

/** "turn_on" → "turn on" */
function _formatService(service) {
    return (service ?? '').replace(/_/g, ' ');
}

/**
 * A single configurable action button for the panel menu.
 *
 * Config shape:
 *   { label, icon, color, entity_id, domain, service, service_data }
 *
 * Layout:
 *   ┌─────────────────────────────┐
 *   │  🔆  Toggle Licht           │
 *   │      wohnzimmer · turn on   │
 *   └─────────────────────────────┘
 */
export const ActionButton = GObject.registerClass(
class ActionButton extends St.Button {
    _init(config, haClient) {
        super._init({
            style_class: 'roompanel-action-button button',
            can_focus: true,
            reactive: true,
            x_expand: true,
        });

        this._config = config;
        this._haClient = haClient;

        // ── Inner layout ──────────────────────────────────────────────
        const shell = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
            style_class: 'roompanel-action-button-shell',
        });

        this._iconRail = new St.Bin({
            style_class: 'roompanel-action-button-rail',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconLabel = new St.Label({
            text: config.icon ?? '•',
            style_class: 'roompanel-action-button-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconRail.set_child(this._iconLabel);
        shell.add_child(this._iconRail);

        const content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'roompanel-action-button-box',
        });
        shell.add_child(content);

        const titleText = config.label?.trim() || _formatService(config.service) || 'Action';
        this._titleLabel = new St.Label({
            text: titleText,
            style_class: 'roompanel-action-button-label',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        this._titleLabel.clutter_text.line_wrap = false;
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        content.add_child(this._titleLabel);

        const metaRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'roompanel-action-button-meta-row',
        });
        content.add_child(metaRow);

        this._entityLabel = new St.Label({
            text: _formatEntity(config.entity_id),
            style_class: 'roompanel-action-button-meta roompanel-action-button-meta-entity',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._entityLabel.clutter_text.line_wrap = false;
        this._entityLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        metaRow.add_child(this._entityLabel);

        const separator = new St.Label({
            text: '·',
            style_class: 'roompanel-action-button-meta roompanel-action-button-meta-separator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        metaRow.add_child(separator);

        this._serviceLabel = new St.Label({
            text: _formatService(config.service),
            style_class: 'roompanel-action-button-meta roompanel-action-button-meta-service',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._serviceLabel.clutter_text.line_wrap = false;
        metaRow.add_child(this._serviceLabel);

        if (!this._entityLabel.text)
            separator.visible = false;
        if (!this._serviceLabel.text) {
            separator.visible = false;
            this._serviceLabel.visible = false;
        }

        this.set_child(shell);

        // ── Custom color ──────────────────────────────────────────────
        if (config.color) {
            const fg = _luma(config.color) > 0.5 ? '#000000' : '#ffffff';
            const border = _hexToRgba(config.color, 0.55);
            const fill = _hexToRgba(config.color, 0.12);
            this.set_style(`background-color: ${fill}; border-color: ${border};`);
            this._iconRail.set_style(`background-color: ${config.color}; color: ${fg};`);
        }

        this.connect('clicked', () => this._onClicked());
    }

    async _onClicked() {
        const { domain, service, entity_id, service_data = {} } = this._config;
        if (!domain || !service)
            return;
        if (!_entityMatchesDomain(entity_id, domain)) {
            console.error(`[RoomPanel] Ignoring invalid button config: entity "${entity_id}" does not match service domain "${domain}"`);
            return;
        }

        const data = entity_id
            ? { entity_id, ...service_data }
            : { ...service_data };

        // Visual feedback: brief opacity pulse
        this.ease({
            opacity: 120,
            duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                });
            },
        });

        try {
            await this._haClient.callService(domain, service, data);
        } catch (e) {
            console.error(`[RoomPanel] Failed to call ${domain}.${service}:`, e.message);
        }
    }
});
