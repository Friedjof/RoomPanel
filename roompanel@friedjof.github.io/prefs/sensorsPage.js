import Adw from 'gi://Adw';
import GObject from 'gi://GObject';

export const SensorsPage = GObject.registerClass(
    class SensorsPage extends Adw.PreferencesPage {
        _init(_settings) {
            super._init({
                title: 'Sensors',
                icon_name: 'utilities-system-monitor-symbolic',
                name: 'sensors',
            });

            const introGroup = new Adw.PreferencesGroup({
                title: 'Sensor Widgets',
                description: 'This page will configure read-only sensor tiles, badges, and status widgets for the panel.',
            });
            this.add(introGroup);

            introGroup.add(new Adw.ActionRow({
                title: 'Coming Next',
                subtitle: 'Sensor entities, widget types, and layout options will be configured here.',
            }));
        }
    }
);
