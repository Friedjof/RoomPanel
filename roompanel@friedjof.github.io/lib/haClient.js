import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Home Assistant REST + WebSocket client using libsoup3.
 * All async methods return Promises.
 */
export class HaClient {
    constructor() {
        this._url = '';
        this._token = '';
        this._verifySSL = true;
        this._session = null;

        // WebSocket live-sync state
        this._ws = null;
        this._wsNextId = 1;
        this._wsRetries = 0;
        this._wsReconnectId = null;
        this._liveCallback = null;
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

        // Reconnect live channel with new credentials if it was active
        const wasLive = !!this._liveCallback;
        this._wsClose();
        if (this._wsReconnectId) {
            GLib.source_remove(this._wsReconnectId);
            this._wsReconnectId = null;
        }
        if (wasLive)
            this._wsConnect();
    }

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

    // ── WebSocket live-sync ─────────────────────────────────────────────────

    /**
     * Open a persistent WebSocket to /api/websocket and subscribe to
     * state_changed events.  Automatically reconnects on disconnect.
     *
     * @param {Function} onStateChange  Called with
     *   { entity_id, new_state: {state, attributes}, old_state } for every event.
     */
    connectLive(onStateChange) {
        this._liveCallback = onStateChange;
        this._wsRetries = 0;
        this._wsConnect();
    }

    /**
     * Stop the live connection and cancel any pending reconnect.
     */
    disconnectLive() {
        this._liveCallback = null;
        if (this._wsReconnectId) {
            GLib.source_remove(this._wsReconnectId);
            this._wsReconnectId = null;
        }
        this._wsClose();
    }

    _wsUrl() {
        // http → ws,  https → wss
        return this._url.replace(/^http(s?)/, (_m, s) => `ws${s}`) + '/api/websocket';
    }

    _wsConnect() {
        if (!this._url || !this._token || !this._liveCallback)
            return;

        try {
            const uri = GLib.Uri.parse(this._wsUrl(), GLib.UriFlags.NONE);
            const msg = new Soup.Message({ method: 'GET', uri });

            if (!this._verifySSL)
                msg.connect('accept-certificate', () => true);

            this._getSession().websocket_connect_async(
                msg, null, [], GLib.PRIORITY_DEFAULT, null,
                (_src, result) => {
                    try {
                        this._ws = this._getSession().websocket_connect_finish(result);
                    } catch (e) {
                        console.error('[RoomPanel] WS connect failed:', e.message);
                        this._wsScheduleReconnect();
                        return;
                    }

                    this._wsRetries = 0;
                    this._wsNextId = 1;

                    this._ws.connect('message', (_conn, type, bytes) => {
                        // Soup.WebsocketDataType.TEXT === 1
                        if (type !== 1) return;
                        try {
                            this._wsHandleMessage(
                                new TextDecoder('utf-8').decode(bytes.get_data())
                            );
                        } catch (e) {
                            console.error('[RoomPanel] WS message parse error:', e.message);
                        }
                    });

                    this._ws.connect('closed', () => {
                        this._ws = null;
                        if (this._liveCallback)
                            this._wsScheduleReconnect();
                    });

                    this._ws.connect('error', (_conn, err) => {
                        console.error('[RoomPanel] WS error:', err.message);
                    });
                }
            );
        } catch (e) {
            console.error('[RoomPanel] WS setup failed:', e.message);
            this._wsScheduleReconnect();
        }
    }

    _wsHandleMessage(text) {
        const msg = JSON.parse(text);

        switch (msg.type) {
            case 'auth_required':
                this._wsSend({ type: 'auth', access_token: this._token });
                break;

            case 'auth_ok':
                // Subscribe to all state_changed events
                this._wsSend({
                    id: this._wsNextId++,
                    type: 'subscribe_events',
                    event_type: 'state_changed',
                });
                break;

            case 'auth_invalid':
                console.error('[RoomPanel] WS: authentication rejected');
                // Do not reconnect – wrong token won't fix itself
                this._wsClose();
                break;

            case 'event':
                if (msg.event?.event_type === 'state_changed' && this._liveCallback)
                    this._liveCallback(msg.event.data);
                break;

            // 'result' messages (ack for subscribe) – silently ignored
        }
    }

    _wsSend(obj) {
        if (!this._ws) return;
        try {
            this._ws.send_text(JSON.stringify(obj));
        } catch (e) {
            console.error('[RoomPanel] WS send failed:', e.message);
        }
    }

    _wsClose() {
        if (!this._ws) return;
        try { this._ws.close(1000, null); } catch { /* ignore */ }
        this._ws = null;
    }

    /** Exponential backoff: 5 s → 10 s → 20 s → 40 s → 60 s (cap). */
    _wsScheduleReconnect() {
        if (this._wsReconnectId) return;
        const delay = Math.min(5000 * (2 ** this._wsRetries), 60000);
        this._wsRetries = Math.min(this._wsRetries + 1, 5);

        this._wsReconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._wsReconnectId = null;
            this._wsConnect();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────

    destroy() {
        this.disconnectLive();

        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }
}
