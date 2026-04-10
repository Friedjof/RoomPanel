import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Home Assistant REST API client using libsoup3.
 * All async methods return Promises.
 */
export class HaClient {
    constructor() {
        this._url = '';
        this._token = '';
        this._verifySSL = true;
        this._session = null;
    }

    /**
     * Configure connection credentials.
     * Call this before any request; resets the session.
     */
    setCredentials(url, token, verifySSL) {
        this._url = url.replace(/\/$/, '');
        this._token = token;
        this._verifySSL = verifySSL;
        this._session = null;
    }

    _getSession() {
        if (!this._session)
            this._session = new Soup.Session();
        return this._session;
    }

    _buildMessage(method, path, body = null) {
        const uri = GLib.Uri.parse(`${this._url}${path}`, GLib.UriFlags.NONE);
        const msg = new Soup.Message({ method, uri });

        // libsoup3: TLS bypass is per-message via accept-certificate signal
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

                        // Soup3: status_code is a plain integer property
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
     * @returns {Promise<Array<{domain: string, services: string[]}>>}
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

    destroy() {
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }
}
