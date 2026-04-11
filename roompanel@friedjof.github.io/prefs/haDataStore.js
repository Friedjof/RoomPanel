import GObject from 'gi://GObject';
import { HaClient } from '../lib/haClient.js';

function getServiceCount(services) {
    if (Array.isArray(services))
        return services.reduce((count, entry) => {
            if (Array.isArray(entry?.services))
                return count + entry.services.length;
            return count + Object.keys(entry?.services ?? {}).length;
        }, 0);

    if (services && typeof services === 'object')
        return Object.values(services)
            .reduce((count, value) => count + Object.keys(value ?? {}).length, 0);

    return 0;
}

const HADataStore = GObject.registerClass({
    Signals: {
        changed: {},
    },
}, class HADataStore extends GObject.Object {
    _init() {
        super._init();

        this._entities = [];
        this._services = [];
        this._status = 'Open this tab to sync entities and services.';
        this._loading = false;
        this._loadTask = null;
    }

    getEntities() {
        return this._entities;
    }

    getServices() {
        return this._services;
    }

    getStatus() {
        return this._status;
    }

    isLoading() {
        return this._loading;
    }

    getServiceCount() {
        return getServiceCount(this._services);
    }

    refresh(settings) {
        if (this._loadTask)
            return this._loadTask;

        this._loadTask = this._refresh(settings)
            .finally(() => {
                this._loadTask = null;
            });
        return this._loadTask;
    }

    async _refresh(settings) {
        const url = settings.get_string('ha-url').trim();
        const token = settings.get_string('ha-token').trim();

        if (!url || !token) {
            this._entities = [];
            this._services = [];
            this._status = 'Connection missing. Configure URL and token above.';
            this._loading = false;
            this.emit('changed');
            return;
        }

        this._loading = true;
        this._status = 'Loading entities and services…';
        this.emit('changed');

        const client = new HaClient();
        client.setCredentials(
            url,
            token,
            settings.get_boolean('ha-verify-ssl')
        );

        try {
            const [entities, services] = await Promise.all([
                client.fetchEntities(),
                client.fetchServices(),
            ]);

            this._entities = entities;
            this._services = services;
            this._status = `${entities.length} entities, ${services.length} domains, ${this.getServiceCount()} services`;
        } catch (e) {
            this._status = `Loading failed: ${e.message}`;
        } finally {
            this._loading = false;
            client.destroy();
            this.emit('changed');
        }
    }
});

export const haDataStore = new HADataStore();
