import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { HaWebSocket } from './haWebSocket.js';

/**
 * Home Assistant REST API client using libsoup3.
 * WebSocket live-sync is delegated to HaWebSocket.
 * All async methods return Promises.
 */
export class HaClient {
    constructor() {
        this._url = '';
        this._token = '';
        this._verifySSL = true;
        this._session = null;

        this._ws = new HaWebSocket(
            () => this._getSession(),
            () => this._url,
            () => this._token,
            () => this._verifySSL
        );
    }

    /**
     * Configure connection credentials.
     * Resets the HTTP session and reconnects the WebSocket if live.
     */
    setCredentials(url, token, verifySSL) {
        this._url = url.replace(/\/$/, '');
        this._token = token;
        this._verifySSL = verifySSL;
        this._session = null;
        this._ws.reconnect();
    }

    // ── REST API ────────────────────────────────────────────────────────────

    /** Test the connection — resolves true if API is reachable. */
    async testConnection() {
        if (!this._url || !this._token)
            throw new Error('URL or token not configured');

        const result = await this._sendAsync(this._buildMessage('GET', '/api/'));
        if (result?.message !== 'API running.')
            throw new Error(`Unexpected response: ${JSON.stringify(result)}`);
        return true;
    }

    /**
     * Fetch all entity states.
     * @returns {Promise<Array<{entity_id, state, attributes}>>}
     */
    async fetchEntities() {
        if (!this._url || !this._token)
            return [];
        return this._sendAsync(this._buildMessage('GET', '/api/states'));
    }

    /**
     * Fetch all available services.
     * @returns {Promise<Array<{domain: string, services: object}>>}
     */
    async fetchServices() {
        if (!this._url || !this._token)
            return [];
        return this._sendAsync(this._buildMessage('GET', '/api/services'));
    }

    /**
     * Call a Home Assistant service.
     * @param {string} domain  e.g. "light"
     * @param {string} service e.g. "turn_on"
     * @param {object} serviceData e.g. { entity_id: "light.foo", brightness: 200 }
     */
    async callService(domain, service, serviceData = {}) {
        if (!this._url || !this._token)
            throw new Error('URL or token not configured');
        return this._sendAsync(
            this._buildMessage('POST', `/api/services/${domain}/${service}`, serviceData)
        );
    }

    /** Get the current state of a single entity. */
    async getState(entityId) {
        if (!this._url || !this._token)
            throw new Error('URL or token not configured');
        return this._sendAsync(this._buildMessage('GET', `/api/states/${entityId}`));
    }

    /**
     * Fetch state history for an entity during the last `hours` hours.
     * Returns the entity history array as documented by HA's REST API.
     */
    async getHistory(entityId, hours = 24) {
        if (!this._url || !this._token)
            throw new Error('URL or token not configured');

        const safeHours = Math.max(1, Number(hours) || 24);
        const end = new Date();
        const start = new Date(end.getTime() - safeHours * 60 * 60 * 1000);

        const startIso = encodeURIComponent(start.toISOString());
        const endIso = encodeURIComponent(end.toISOString());
        const filter = encodeURIComponent(entityId);
        const path = `/api/history/period/${startIso}?end_time=${endIso}&filter_entity_id=${filter}`;

        const result = await this._sendAsync(this._buildMessage('GET', path));
        if (!Array.isArray(result) || result.length === 0)
            return [];

        return Array.isArray(result[0]) ? result[0] : [];
    }

    // ── WebSocket live-sync ─────────────────────────────────────────────────

    /**
     * Open a persistent WebSocket to /api/websocket and subscribe to
     * state_changed events.  Automatically reconnects on disconnect.
     *
     * @param {Function} onStateChange  Called with
     *   { entity_id, new_state: {state, attributes}, old_state } for every event.
     */
    connectLive(onStateChange) {
        this._ws.connectLive(onStateChange);
    }

    /** Stop the live connection and cancel any pending reconnect. */
    disconnectLive() {
        this._ws.disconnectLive();
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────

    destroy() {
        this._ws.destroy();

        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    // ── Private ─────────────────────────────────────────────────────────────

    _getSession() {
        if (!this._session)
            this._session = new Soup.Session();
        return this._session;
    }

    _buildMessage(method, path, body = null) {
        const uri = GLib.Uri.parse(`${this._url}${path}`, GLib.UriFlags.NONE);
        const msg = new Soup.Message({ method, uri });

        if (!this._verifySSL)
            msg.connect('accept-certificate', () => true);

        msg.request_headers.append('Authorization', `Bearer ${this._token}`);
        msg.request_headers.append('Content-Type', 'application/json');

        if (body !== null) {
            const encoded = new TextEncoder().encode(JSON.stringify(body));
            const bytes = GLib.Bytes.new(encoded);
            msg.set_request_body_from_bytes('application/json', bytes);
        }

        return msg;
    }

    _sendAsync(msg) {
        return new Promise((resolve, reject) => {
            const session = this._getSession();

            session.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                null,
                (src, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = msg.status_code;
                        if (status < 200 || status >= 300) {
                            const reason = msg.reason_phrase ?? String(status);
                            reject(new Error(`HTTP ${status}: ${reason}`));
                            return;
                        }
                        const data = bytes.get_data();
                        const text = new TextDecoder('utf-8').decode(data);
                        resolve(JSON.parse(text));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }
}
