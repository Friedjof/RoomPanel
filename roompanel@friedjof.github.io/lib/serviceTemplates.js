/**
 * Static service_data templates for common Home Assistant service calls.
 * Used to pre-fill the service_data field when a service is selected.
 *
 * Format: 'domain.service' → { field: defaultValue, … }
 */
export const SERVICE_TEMPLATES = {
    // ── Light ──────────────────────────────────────────────────────────
    'light.turn_on': { brightness: 255, rgb_color: [255, 255, 255] },
    'light.turn_off': {},
    'light.toggle': {},

    // ── Switch ─────────────────────────────────────────────────────────
    'switch.turn_on': {},
    'switch.turn_off': {},
    'switch.toggle': {},

    // ── Cover ──────────────────────────────────────────────────────────
    'cover.open_cover': {},
    'cover.close_cover': {},
    'cover.stop_cover': {},
    'cover.toggle': {},
    'cover.set_cover_position': { position: 50 },
    'cover.open_cover_tilt': {},
    'cover.close_cover_tilt': {},
    'cover.stop_cover_tilt': {},
    'cover.set_cover_tilt_position': { tilt_position: 50 },

    // ── Climate ────────────────────────────────────────────────────────
    'climate.turn_on': {},
    'climate.turn_off': {},
    'climate.toggle': {},
    'climate.set_temperature': { temperature: 21 },
    'climate.set_hvac_mode': { hvac_mode: 'heat' },
    'climate.set_preset_mode': { preset_mode: 'eco' },
    'climate.set_fan_mode': { fan_mode: 'auto' },
    'climate.set_humidity': { humidity: 50 },
    'climate.set_swing_mode': { swing_mode: 'off' },
    'climate.set_aux_heat': { aux_heat: false },

    // ── Media Player ───────────────────────────────────────────────────
    'media_player.turn_on': {},
    'media_player.turn_off': {},
    'media_player.toggle': {},
    'media_player.media_play': {},
    'media_player.media_pause': {},
    'media_player.media_play_pause': {},
    'media_player.media_stop': {},
    'media_player.media_next_track': {},
    'media_player.media_previous_track': {},
    'media_player.volume_up': {},
    'media_player.volume_down': {},
    'media_player.volume_set': { volume_level: 0.5 },
    'media_player.volume_mute': { is_volume_muted: true },
    'media_player.media_seek': { seek_position: 0 },
    'media_player.select_source': { source: '' },
    'media_player.select_sound_mode': { sound_mode: '' },
    'media_player.shuffle_set': { shuffle: true },
    'media_player.repeat_set': { repeat: 'off' },
    'media_player.play_media': { media_content_id: '', media_content_type: 'music' },
    'media_player.clear_playlist': {},

    // ── Fan ────────────────────────────────────────────────────────────
    'fan.turn_on': { percentage: 50 },
    'fan.turn_off': {},
    'fan.toggle': {},
    'fan.set_percentage': { percentage: 50 },
    'fan.set_preset_mode': { preset_mode: 'auto' },
    'fan.set_direction': { direction: 'forward' },
    'fan.oscillate': { oscillating: true },
    'fan.increase_speed': { percentage_step: 10 },
    'fan.decrease_speed': { percentage_step: 10 },

    // ── Lock ───────────────────────────────────────────────────────────
    'lock.lock': {},
    'lock.unlock': {},
    'lock.open': {},

    // ── Vacuum ─────────────────────────────────────────────────────────
    'vacuum.start': {},
    'vacuum.pause': {},
    'vacuum.stop': {},
    'vacuum.return_to_base': {},
    'vacuum.locate': {},
    'vacuum.clean_spot': {},
    'vacuum.set_fan_speed': { fan_speed: 'balanced' },
    'vacuum.send_command': { command: '' },

    // ── Input Boolean ──────────────────────────────────────────────────
    'input_boolean.turn_on': {},
    'input_boolean.turn_off': {},
    'input_boolean.toggle': {},

    // ── Input Number ──────────────────────────────────────────────────
    'input_number.set_value': { value: 0 },
    'input_number.increment': {},
    'input_number.decrement': {},

    // ── Input Select ──────────────────────────────────────────────────
    'input_select.select_option': { option: '' },
    'input_select.select_next': {},
    'input_select.select_previous': {},

    // ── Scene ──────────────────────────────────────────────────────────
    'scene.turn_on': { transition: 1 },

    // ── Script ────────────────────────────────────────────────────────
    'script.turn_on': { variables: {} },

    // ── Notify ────────────────────────────────────────────────────────
    'notify.send_message': { message: '', title: '' },
    'notify.notify': { message: '', title: '' },

    // ── Automation ────────────────────────────────────────────────────
    'automation.turn_on': {},
    'automation.turn_off': {},
    'automation.toggle': {},
    'automation.trigger': { skip_condition: false },

    // ── Home Assistant generic ─────────────────────────────────────────
    'homeassistant.turn_on': {},
    'homeassistant.turn_off': {},
    'homeassistant.toggle': {},
    'homeassistant.restart': {},
    'homeassistant.reload_core_config': {},
};

/**
 * Get the service_data template for a given domain + service.
 * Returns a deep copy (safe to mutate) or {} if unknown.
 *
 * @param {string} domain  e.g. "light"
 * @param {string} service e.g. "turn_on"
 * @returns {object}
 */
export function getTemplate(domain, service) {
    const key = `${domain}.${service}`;
    const tpl = SERVICE_TEMPLATES[key];
    return tpl ? JSON.parse(JSON.stringify(tpl)) : {};
}

/**
 * Return all known service keys as "domain.service" strings.
 * Useful for offline fallback when /api/services is unavailable.
 */
export function getKnownServiceKeys() {
    return Object.keys(SERVICE_TEMPLATES);
}
