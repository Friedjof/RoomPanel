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
 *   │   🔆  Toggle Licht          │  ← main label
 *   │  wohnzimmer tisch  toggle   │  ← meta: entity (left) · service (right)
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
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'roompanel-action-button-box',
        });

        // Main label — St.Bin fills remaining height and centers the text
        const mainText = `${config.icon ?? ''} ${config.label ?? ''}`.trim();
        const mainLabel = new St.Label({
            text: mainText,
            style_class: 'roompanel-action-button-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Bin({
            child: mainLabel,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // Meta line: "entity name – action", right-aligned
        const metaText = [_formatEntity(config.entity_id), _formatService(config.service)]
            .filter(Boolean)
            .join(' – ');
        box.add_child(new St.Label({
            text: metaText,
            style_class: 'roompanel-action-button-meta',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        }));

        this.set_child(box);

        // ── Custom color ──────────────────────────────────────────────
        if (config.color) {
            const fg = _luma(config.color) > 0.5 ? '#000000' : '#ffffff';
            this.set_style(`background-color: ${config.color}; color: ${fg};`);
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
