import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

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

/**
 * A single configurable action button for the panel menu.
 *
 * Config shape:
 *   { label, icon, color, entity_id, domain, service, service_data }
 */
export const ActionButton = GObject.registerClass(
class ActionButton extends St.Button {
    _init(config, haClient) {
        const label = `${config.icon ?? ''} ${config.label ?? ''}`.trim();

        super._init({
            label,
            style_class: 'roompanel-action-button button',
            can_focus: true,
            reactive: true,
            x_expand: true,
        });

        this._config = config;
        this._haClient = haClient;

        if (config.color) {
            const fg = _luma(config.color) > 0.5 ? '#000000' : '#ffffff';
            this.set_style(
                `background-color: ${config.color}; color: ${fg};`
            );
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
