import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

/**
 * BrowserBridgeServer
 *
 * Hosts a local WebSocket server (localhost only) that the HAControlPanel
 * Firefox extension connects to. Receives YouTube video color frames and
 * tab-status updates, and routes them to the ScreenSyncController via
 * callbacks.
 *
 * Protocol (Firefox → GNOME):
 *   { "type": "frame",  "tabId": 123, "color": { "r": 128, "g": 64, "b": 200 } }
 *   { "type": "status", "tabs": [{ "tabId": 123, "title": "…", "active": true }] }
 *
 * Protocol (GNOME → Firefox):
 *   { "type": "config", "selectedTab": "auto" | tabId }
 */
export class BrowserBridgeServer {
    /**
     * @param {number} port - localhost port to listen on
     * @param {object} callbacks
     * @param {function(number, number, number): void} callbacks.onColor - called with (r, g, b) when a frame arrives for the selected tab
     * @param {function(): void} callbacks.onYTInactive - called when no YT tab is active (3s timeout or status with no active tabs)
     * @param {function(Array): void} callbacks.onTabsChanged - called with the current tab list
     * @param {function(boolean): void} callbacks.onConnected - called when connection count changes (true = at least one client)
     */
    constructor(port, { onColor, onYTInactive, onTabsChanged, onConnected } = {}) {
        this._port = port;
        this._onColor = onColor ?? null;
        this._onYTInactive = onYTInactive ?? null;
        this._onTabsChanged = onTabsChanged ?? null;
        this._onConnected = onConnected ?? null;

        this._server = null;
        this._connections = new Set();
        this._selectedTab = 'auto';
        this._ytTimeoutId = null;
        this._lastColor = null;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    start() {
        if (this._server)
            return;

        try {
            this._server = new Soup.Server();

            this._server.add_websocket_handler('/', null, null,
                (_srv, _msg, _path, conn) => this._onNewConnection(conn));

            this._server.listen_local(this._port, 0);
            console.log(`[HAControlPanel] Browser bridge listening on port ${this._port}`);
        } catch (e) {
            console.error(`[HAControlPanel] Browser bridge failed to start: ${e.message}`);
            this._server = null;
        }
    }

    stop() {
        this._clearYtTimeout();

        for (const conn of this._connections) {
            try { conn.close(1000, 'Server stopping'); } catch {}
        }
        this._connections.clear();

        if (this._server) {
            this._server.disconnect();
            this._server = null;
        }

        console.log('[HAControlPanel] Browser bridge stopped');
    }

    destroy() {
        this.stop();
    }

    /**
     * Update which tab should be used as color source and inform all clients.
     * @param {string} tabId - "auto" or a numeric tab ID as string
     */
    setSelectedTab(tabId) {
        this._selectedTab = tabId;
        for (const conn of this._connections)
            this._sendConfig(conn);
    }

    /** Last color received from the active tab, or null */
    get lastColor() {
        return this._lastColor;
    }

    // -------------------------------------------------------------------------
    // Private: connection lifecycle
    // -------------------------------------------------------------------------

    _onNewConnection(conn) {
        this._connections.add(conn);

        if (this._connections.size === 1)
            this._onConnected?.(true);

        // Send current config immediately so the client knows which tab to prioritise
        this._sendConfig(conn);

        conn.connect('message', (_c, type, bytes) => {
            // Soup.WebsocketDataType.TEXT === 1
            if (type !== 1)
                return;
            try {
                const text = new TextDecoder('utf-8').decode(bytes.get_data());
                this._handleMessage(JSON.parse(text));
            } catch (e) {
                console.error(`[HAControlPanel] Browser bridge parse error: ${e.message}`);
            }
        });

        conn.connect('closed', () => {
            this._connections.delete(conn);
            if (this._connections.size === 0) {
                this._clearYtTimeout();
                this._onConnected?.(false);
                this._onYTInactive?.();
            }
        });

        conn.connect('error', (_c, err) => {
            console.error(`[HAControlPanel] Browser bridge WS error: ${err.message}`);
        });
    }

    // -------------------------------------------------------------------------
    // Private: message handling
    // -------------------------------------------------------------------------

    _handleMessage(msg) {
        if (msg.type === 'frame')
            this._handleFrame(msg);
        else if (msg.type === 'status')
            this._handleStatus(msg);
    }

    _handleFrame(msg) {
        const tabId = msg.tabId;
        const color = msg.color;

        if (!color || typeof color.r !== 'number')
            return;

        const sel = this._selectedTab;
        // In auto mode accept any frame; otherwise only the selected tab
        if (sel !== 'auto' && String(tabId) !== String(sel))
            return;

        this._lastColor = color;
        this._resetYtTimeout();
        this._onColor?.(color.r, color.g, color.b);
    }

    _handleStatus(msg) {
        const tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
        this._onTabsChanged?.(tabs);

        const anyActive = tabs.some(t => t.active);
        if (!anyActive)
            this._triggerYTInactive();
    }

    // -------------------------------------------------------------------------
    // Private: YT-active timeout
    // -------------------------------------------------------------------------

    _resetYtTimeout() {
        this._clearYtTimeout();
        // If no new frame arrives within 3 seconds, consider YT inactive
        this._ytTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._ytTimeoutId = null;
            this._onYTInactive?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearYtTimeout() {
        if (this._ytTimeoutId !== null) {
            GLib.source_remove(this._ytTimeoutId);
            this._ytTimeoutId = null;
        }
    }

    _triggerYTInactive() {
        this._clearYtTimeout();
        this._onYTInactive?.();
    }

    // -------------------------------------------------------------------------
    // Private: send config to client
    // -------------------------------------------------------------------------

    _sendConfig(conn) {
        try {
            conn.send_text(JSON.stringify({
                type: 'config',
                selectedTab: this._selectedTab,
            }));
        } catch {}
    }
}
