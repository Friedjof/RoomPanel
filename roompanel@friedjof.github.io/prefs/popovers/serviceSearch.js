import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { getKnownServiceKeys } from '../../lib/serviceTemplates.js';

export const ServiceSearchPopover = GObject.registerClass(
class ServiceSearchPopover extends Gtk.Popover {
    _init(onSelect) {
        super._init({ has_arrow: false });
        this._onSelect = onSelect;
        this._allServices = []; // [{domain, service}]
        this._domainFilter = null;

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        this.set_child(box);

        this._search = new Gtk.SearchEntry({ placeholder_text: 'Filter services…' });
        box.append(this._search);

        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 220, max_content_height: 320,
            min_content_width: 300, hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        box.append(scroll);

        this._listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: ['boxed-list'] });
        this._listBox.set_filter_func(row => this._filter(row));
        scroll.set_child(this._listBox);

        this._search.connect('search-changed', () => this._listBox.invalidate_filter());
        this._listBox.connect('row-activated', (_lb, row) => {
            this._onSelect(row._domain, row._service);
            this.popdown();
        });
    }

    /**
     * Load live services from HA API response.
     * Handles both formats:
     *  – Array: [{domain, services: {svcName: {...}}}, …]  (HA REST API)
     *  – Object: {domain: {svcName: {...}}, …}             (legacy/alt format)
     */
    setServices(apiServices) {
        this._allServices = [];
        if (Array.isArray(apiServices)) {
            for (const entry of apiServices) {
                const names = Array.isArray(entry.services)
                    ? entry.services
                    : Object.keys(entry.services ?? {});
                for (const svc of names)
                    this._allServices.push({ domain: entry.domain, service: svc });
            }
        } else if (apiServices && typeof apiServices === 'object') {
            for (const [domain, svcs] of Object.entries(apiServices))
                for (const svc of Object.keys(svcs ?? {}))
                    this._allServices.push({ domain, service: svc });
        }
        this._rebuild();
    }

    /** Fallback: use known template keys */
    setFallbackServices() {
        this._allServices = getKnownServiceKeys().map(key => {
            const [domain, ...rest] = key.split('.');
            return { domain, service: rest.join('.') };
        });
        this._rebuild();
    }

    setDomainFilter(domain) {
        this._domainFilter = domain || null;
        this._listBox.invalidate_filter();
    }

    _rebuild() {
        let child = this._listBox.get_first_child();
        while (child) { const n = child.get_next_sibling(); this._listBox.remove(child); child = n; }

        for (const { domain, service } of this._allServices) {
            const row = new Gtk.ListBoxRow({ css_classes: ['activatable'] });
            row._domain = domain;
            row._service = service;
            row._key = `${domain}.${service}`;

            const b = new Gtk.Box({ spacing: 8, margin_top: 6, margin_bottom: 6,
                margin_start: 10, margin_end: 10 });
            b.append(new Gtk.Label({ label: domain, xalign: 0,
                css_classes: ['dim-label', 'monospace'] }));
            b.append(new Gtk.Label({ label: service, xalign: 0, hexpand: true,
                css_classes: ['monospace'] }));
            row.set_child(b);
            this._listBox.append(row);
        }
    }

    _filter(row) {
        if (this._domainFilter && row._domain !== this._domainFilter) return false;
        const q = this._search.text.toLowerCase();
        if (!q) return true;
        return row._key?.includes(q) ?? false;
    }
});
