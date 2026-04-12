import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

export const EMOJI_CATEGORIES = {
    'Smart Home': ['🏠', '🏡', '💡', '🔌', '🌡️', '🔒', '🔓', '🚪', '🪟', '🛋️', '🛏️', '🚿', '🛁', '🪑', '🧹', '🧺', '🚗', '🛎️', '📬', '☕', '🍳', '🧊', '🪣'],
    'Licht':      ['💡', '🔆', '🔅', '🕯️', '🪔', '🔦', '🏮', '🪩', '✨', '💫', '🌟', '🌠', '🎆', '🎇', '🟡', '🟠', '🔴', '🟢', '🔵', '🟣', '⚪', '🟤', '🔲', '🔳', '🌕', '🌖', '🌗', '🌘'],
    'Pflanzen':   ['🪴', '🌱', '🌿', '🍀', '🌵', '🎋', '🌴', '🌲', '🌳', '🌸', '🌺', '🌻', '🌹', '🌷', '🌼', '💐', '🍃', '🍁', '🍂', '🌾', '🎍', '🍄', '💦', '🚰', '🌧️', '🌊'],
    'Aktoren':    ['⚙️', '🔧', '🔩', '🛠️', '🌀', '💦', '🚰', '🔔', '🔕', '🚨', '🛎️', '🔋', '🧲', '🎛️', '🕹️', '🎚️', '🦾', '🔑', '🗝️', '🚦', '🏁', '🎯', '🔐', '🔓'],
    'Media':      ['▶️', '⏸️', '⏹️', '⏭️', '⏮️', '🔊', '🔉', '🔈', '🔇', '📺', '🎵', '🎶', '📻', '🎙️', '🎤', '🎧', '📡', '📽️', '🎞️'],
    'Climate':    ['❄️', '🔥', '🌬️', '☀️', '🌙', '💨', '🌡️', '♨️', '🌀', '💧', '🌊', '☁️', '🌧️', '⛅', '🌤️', '🌫️', '🌨️', '🌩️', '🌪️'],
    'Actions':    ['⬆️', '⬇️', '⬅️', '➡️', '↕️', '↔️', '✅', '❌', '⭐', '❤️', '🔄', '🔃', '⚡', '🌐', '📲', '🔛', '🔝', '🔙', '🚦', '🎯', '🏁', '🔁', '🔂'],
    'Devices':    ['🖥️', '💻', '🖨️', '📱', '⌨️', '🖱️', '📷', '📸', '🤖', '🔭', '🔬', '📡', '📟', '📠', '🔐', '🔑', '🗝️'],
    'Scenes':     ['🌅', '🌄', '🌆', '🌇', '🌃', '🌉', '🌌', '🎬', '🎉', '🎊', '🌈', '🕯️', '🪔', '🔦', '💫', '🎆', '🎇', '🌠', '🌙', '☀️', '🌤️'],
};

export const EmojiPickerPopover = GObject.registerClass(
class EmojiPickerPopover extends Gtk.Popover {
    _init(onSelect) {
        super._init({ has_arrow: false });
        this._onSelect = onSelect;

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8 });
        this.set_child(box);

        const search = new Gtk.SearchEntry({ placeholder_text: 'Search emoji…' });
        box.append(search);

        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 260, max_content_height: 320,
            min_content_width: 300, hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        box.append(scroll);

        const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        scroll.set_child(inner);

        this._allButtons = [];

        for (const [cat, emojis] of Object.entries(EMOJI_CATEGORIES)) {
            inner.append(new Gtk.Label({ label: cat, xalign: 0,
                css_classes: ['heading'], margin_top: 4, margin_start: 4 }));

            const flow = new Gtk.FlowBox({
                max_children_per_line: 10, min_children_per_line: 6,
                selection_mode: Gtk.SelectionMode.NONE,
                row_spacing: 2, column_spacing: 2,
            });
            inner.append(flow);

            for (const emoji of emojis) {
                const btn = new Gtk.Button({ label: emoji,
                    css_classes: ['flat'], tooltip_text: emoji });
                btn._emoji = emoji;
                btn.connect('clicked', () => { this._onSelect(emoji); this.popdown(); });
                flow.append(btn);
                this._allButtons.push(btn);
            }
        }

        search.connect('search-changed', () => {
            const q = search.text.toLowerCase();
            for (const btn of this._allButtons)
                btn.visible = !q || btn._emoji.includes(q);
        });
    }
});
