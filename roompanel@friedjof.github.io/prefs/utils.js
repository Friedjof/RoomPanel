import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { getKnownServiceKeys } from '../lib/serviceTemplates.js';

// ── Service helpers ───────────────────────────────────────────────────────────

export function getServiceEntries(apiServices) {
    const entries = [];

    if (Array.isArray(apiServices) && apiServices.length > 0) {
        for (const entry of apiServices) {
            const names = Array.isArray(entry.services)
                ? entry.services
                : Object.keys(entry.services ?? {});
            for (const service of names)
                entries.push({ domain: entry.domain, service });
        }
    } else if (apiServices && typeof apiServices === 'object') {
        for (const [domain, services] of Object.entries(apiServices)) {
            for (const service of Object.keys(services ?? {}))
                entries.push({ domain, service });
        }
    } else {
        for (const key of getKnownServiceKeys()) {
            const [domain, ...rest] = key.split('.');
            entries.push({ domain, service: rest.join('.') });
        }
    }

    entries.sort((a, b) => `${a.domain}.${a.service}`.localeCompare(`${b.domain}.${b.service}`));
    return entries;
}

export function getServiceDomains(apiServices, extraDomains = []) {
    const domains = new Set(getServiceEntries(apiServices).map(entry => entry.domain));
    for (const domain of extraDomains) {
        if (domain)
            domains.add(domain);
    }
    return [...domains].sort();
}

// ── GTK dropdown helpers ──────────────────────────────────────────────────────

export function createStringList(values) {
    const model = new Gtk.StringList();
    for (const value of values)
        model.append(value);
    return model;
}

export function getDropDownValue(dropdown) {
    const item = dropdown.get_selected_item();
    return item ? item.get_string() : '';
}

export function setDropDownValue(dropdown, model, value) {
    if (!value) {
        dropdown.set_selected(Gtk.INVALID_LIST_POSITION);
        return false;
    }

    const count = model.get_n_items();
    for (let i = 0; i < count; i++) {
        const item = model.get_item(i);
        if (item?.get_string() === value) {
            dropdown.set_selected(i);
            return true;
        }
    }

    dropdown.set_selected(Gtk.INVALID_LIST_POSITION);
    return false;
}

// ── Entity ID helpers ─────────────────────────────────────────────────────────

export function escapeMarkup(text) {
    return GLib.markup_escape_text(String(text ?? ''), -1);
}

export function getEntityDomain(entityId) {
    return String(entityId ?? '').split('.')[0] || '';
}

export function getEntityObjectId(entityId) {
    const parts = String(entityId ?? '').split('.');
    return parts.length > 1 ? parts.slice(1).join('.') : '';
}

export function findReplacementEntityId(entityId, requiredDomain, entities) {
    if (!entityId || !requiredDomain)
        return entityId;

    if (getEntityDomain(entityId) === requiredDomain)
        return entityId;

    const objectId = getEntityObjectId(entityId);
    if (!objectId)
        return '';

    const exactId = `${requiredDomain}.${objectId}`;
    if (entities.some(entity => entity.entity_id === exactId))
        return exactId;

    const current = entities.find(entity => entity.entity_id === entityId);
    const currentName = String(current?.attributes?.friendly_name ?? '').trim().toLowerCase();
    if (!currentName)
        return '';

    const matches = entities.filter(entity =>
        getEntityDomain(entity.entity_id) === requiredDomain &&
        String(entity.attributes?.friendly_name ?? '').trim().toLowerCase() === currentName
    );

    return matches.length === 1 ? matches[0].entity_id : '';
}
