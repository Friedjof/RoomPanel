import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

/**
 * Home Assistant WebSocket live-sync client.
 * Subscribes to state_changed events and reconnects automatically.
 *
 * All credentials are accessed via getter callbacks so the parent
 * HaClient can update them without re-creating this object.
 */
export class HaWebSocket {
    constructor(getSession, getUrl, getToken, getVerifySSL) {
        this._getSession = getSession;
        this._getUrl = getUrl;
        this._getToken = getToken;
        this._getVerifySSL = getVerifySSL;

        this._ws = null;
        this._wsNextId = 1;
        this._wsRetries = 0;
        this._wsReconnectId = null;
        this._liveCallbacks = new Set();
    }

    /**
     * Open a persistent WebSocket to /api/websocket and subscribe to
     * state_changed events.  Automatically reconnects on disconnect.
     *
     * @param {Function} onStateChange  Called with
     *   { entity_id, new_state: {state, attributes}, old_state } for every event.
     */
    connectLive(onStateChange) {
        if (typeof onStateChange !== 'function')
            return;

        const wasEmpty = this._liveCallbacks.size === 0;
        this._liveCallbacks.add(onStateChange);
        if (!wasEmpty || this._ws || this._wsReconnectId)
            return;

        this._wsRetries = 0;
        this._wsConnect();
    }

    /** Stop the live connection and cancel any pending reconnect. */
    disconnectLive(onStateChange = null) {
        if (onStateChange)
            this._liveCallbacks.delete(onStateChange);
        else
            this._liveCallbacks.clear();

        if (this._liveCallbacks.size > 0)
            return;

        if (this._wsReconnectId) {
            GLib.source_remove(this._wsReconnectId);
            this._wsReconnectId = null;
        }
        this._wsClose();
    }

    /**
     * Called by HaClient.setCredentials() to reconnect with fresh credentials.
     * If the live channel was active it is re-established immediately.
     */
    reconnect() {
        const wasLive = this._liveCallbacks.size > 0;
        this._wsClose();
        if (this._wsReconnectId) {
            GLib.source_remove(this._wsReconnectId);
            this._wsReconnectId = null;
        }
        if (wasLive)
            this._wsConnect();
    }

    destroy() {
        this.disconnectLive();
    }

    // ── Private ─────────────────────────────────────────────────────────────

    _wsUrl() {
        // http → ws,  https → wss
        return this._getUrl().replace(/^http(s?)/, (_m, s) => `ws${s}`) + '/api/websocket';
    }

    _wsConnect() {
        const url = this._getUrl();
        const token = this._getToken();
        if (!url || !token || this._liveCallbacks.size === 0)
            return;

        try {
            const uri = GLib.Uri.parse(this._wsUrl(), GLib.UriFlags.NONE);
            const msg = new Soup.Message({ method: 'GET', uri });

            if (!this._getVerifySSL())
                msg.connect('accept-certificate', () => true);

            this._getSession().websocket_connect_async(
                msg, null, [], GLib.PRIORITY_DEFAULT, null,
                (_src, result) => {
                    try {
                        this._ws = this._getSession().websocket_connect_finish(result);
                    } catch (e) {
                        console.error('[HAControlPanel] WS connect failed:', e.message);
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
                            console.error('[HAControlPanel] WS message parse error:', e.message);
                        }
                    });

                    this._ws.connect('closed', () => {
                        this._ws = null;
                        if (this._liveCallbacks.size > 0)
                            this._wsScheduleReconnect();
                    });

                    this._ws.connect('error', (_conn, err) => {
                        console.error('[HAControlPanel] WS error:', err.message);
                    });
                }
            );
        } catch (e) {
            console.error('[HAControlPanel] WS setup failed:', e.message);
            this._wsScheduleReconnect();
        }
    }

    _wsHandleMessage(text) {
        const msg = JSON.parse(text);

        switch (msg.type) {
            case 'auth_required':
                this._wsSend({ type: 'auth', access_token: this._getToken() });
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
                console.error('[HAControlPanel] WS: authentication rejected');
                // Do not reconnect – wrong token won't fix itself
                this._wsClose();
                break;

            case 'event':
                if (msg.event?.event_type === 'state_changed') {
                    for (const callback of this._liveCallbacks) {
                        try {
                            callback(msg.event.data);
                        } catch (e) {
                            console.error('[HAControlPanel] WS callback failed:', e.message);
                        }
                    }
                }
                break;

            // 'result' messages (ack for subscribe) – silently ignored
        }
    }

    _wsSend(obj) {
        if (!this._ws) return;
        try {
            this._ws.send_text(JSON.stringify(obj));
        } catch (e) {
            console.error('[HAControlPanel] WS send failed:', e.message);
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
}
