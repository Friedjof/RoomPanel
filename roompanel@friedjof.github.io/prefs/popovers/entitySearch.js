import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

export const EntitySearchPopover = GObject.registerClass(
class EntitySearchPopover extends Gtk.Popover {
    _init(onSelect) {
        super._init({ has_arrow: false });
        this._onSelect = onSelect;
        this._domainFilter = null;

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        this.set_child(box);

        this._search = new Gtk.SearchEntry({ placeholder_text: 'Filter entities…' });
        box.append(this._search);

        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 220, max_content_height: 320,
            min_content_width: 340, hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        box.append(scroll);

        this._listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: ['boxed-list'] });
        this._listBox.set_filter_func(row => this._filter(row));
        scroll.set_child(this._listBox);

        this._search.connect('search-changed', () => this._listBox.invalidate_filter());
        this._listBox.connect('row-activated', (_lb, row) => {
            this._onSelect(row._entityId);
            this.popdown();
        });
    }

    setEntities(entities) {
        let child = this._listBox.get_first_child();
        while (child) { const n = child.get_next_sibling(); this._listBox.remove(child); child = n; }

        for (const e of entities) {
            const row = new Gtk.ListBoxRow({ css_classes: ['activatable'] });
            row._entityId = e.entity_id;
            row._entityName = e.attributes?.friendly_name || e.entity_id;
            const b = new Gtk.Box({ spacing: 8, margin_top: 6, margin_bottom: 6,
                margin_start: 10, margin_end: 10 });
            b.append(new Gtk.Label({ label: row._entityName, xalign: 0, hexpand: true }));
            row.set_child(b);
            row.tooltip_text = row._entityId;
            this._listBox.append(row);
        }
    }

    setDomainFilter(domain) {
        this._domainFilter = domain || null;
        this._listBox.invalidate_filter();
    }

    _filter(row) {
        if (this._domainFilter) {
            const domain = row._entityId?.split('.')[0] ?? '';
            if (domain !== this._domainFilter)
                return false;
        }

        const q = this._search.text.toLowerCase();
        if (!q) return true;
        return (row._entityId?.toLowerCase() ?? '').includes(q) ||
               (row._entityName?.toLowerCase() ?? '').includes(q);
    }
});
