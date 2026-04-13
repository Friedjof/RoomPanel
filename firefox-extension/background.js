/**
 * HAControlPanel Bridge — background service worker
 *
 * Maintains a persistent WebSocket connection to the GNOME extension's
 * BrowserBridgeServer (ws://localhost:7842). Relays color frames from
 * content scripts and keeps an up-to-date list of open YouTube tabs.
 *
 * Message flow:
 *   content/youtube.js  →  runtime.sendMessage  →  this worker
 *   this worker         →  WebSocket             →  GNOME extension
 *   GNOME extension     →  WebSocket             →  this worker  (config)
 */

const WS_URL = 'ws://localhost:7842';
const RECONNECT_DELAY_MS = 3000;
const FRAME_STALE_MS = 3000;

let ws = null;
let reconnectTimer = null;
let selectedTab = 'auto'; // updated by GNOME extension via 'config' message
let lastColor = null;      // last color received from active YT tab
let currentTabs = [];      // current list of open YT tabs
let lastFrameTabId = null;
const tabColorState = new Map();
let lastSamplerState = {
    tabId: null,
    samplingMode: null,
    canvasBackend: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorAt: null,
};

function colorToHex(color) {
    if (!color)
        return null;

    return `#${color.r.toString(16).padStart(2, '0')}${color.g.toString(16).padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`;
}

function updateTabColor(tabId, color) {
    if (tabId === null || tabId === undefined || !color)
        return;

    const now = Date.now();
    const prev = tabColorState.get(tabId) ?? { framesSeen: 0 };
    tabColorState.set(tabId, {
        ...prev,
        lastColor: colorToHex(color),
        lastFrameAt: now,
        framesSeen: prev.framesSeen + 1,
        lastError: null,
        lastErrorCode: null,
        lastErrorAt: null,
    });

    lastSamplerState = {
        ...lastSamplerState,
        tabId,
        samplingMode: prev.samplingMode ?? lastSamplerState.samplingMode,
        canvasBackend: prev.canvasBackend ?? lastSamplerState.canvasBackend,
        lastError: null,
        lastErrorCode: null,
        lastErrorAt: null,
    };
}

function updateTabSamplerState(tabId, { samplingMode, canvasBackend, error } = {}) {
    if (tabId === null || tabId === undefined)
        return;

    const prev = tabColorState.get(tabId) ?? { framesSeen: 0 };
    const next = { ...prev };

    if (samplingMode !== undefined)
        next.samplingMode = samplingMode;
    if (canvasBackend !== undefined)
        next.canvasBackend = canvasBackend;

    if (error === null) {
        next.lastError = null;
        next.lastErrorCode = null;
        next.lastErrorAt = null;
    } else if (error) {
        next.lastError = error.message ?? 'Unknown sampler error';
        next.lastErrorCode = error.code ?? 'unknown';
        next.lastErrorAt = error.at ?? Date.now();
    }

    tabColorState.set(tabId, next);
    lastSamplerState = {
        tabId,
        samplingMode: next.samplingMode ?? null,
        canvasBackend: next.canvasBackend ?? null,
        lastError: next.lastError ?? null,
        lastErrorCode: next.lastErrorCode ?? null,
        lastErrorAt: next.lastErrorAt ?? null,
    };
}

function syncTabDiagnostics(tabs) {
    const activeIds = new Set(tabs.map(tab => tab.tabId));
    for (const tabId of tabColorState.keys()) {
        if (!activeIds.has(tabId))
            tabColorState.delete(tabId);
    }

    const now = Date.now();
    currentTabs = tabs.map(tab => {
        const diagnostics = tabColorState.get(tab.tabId) ?? {};
        const lastFrameAt = diagnostics.lastFrameAt ?? null;
        return {
            ...tab,
            lastColor: diagnostics.lastColor ?? null,
            lastFrameAt,
            framesSeen: diagnostics.framesSeen ?? 0,
            frameFresh: lastFrameAt !== null && (now - lastFrameAt) <= FRAME_STALE_MS,
            selected: selectedTab !== 'auto' && String(selectedTab) === String(tab.tabId),
            lastError: diagnostics.lastError ?? null,
            lastErrorCode: diagnostics.lastErrorCode ?? null,
            lastErrorAt: diagnostics.lastErrorAt ?? null,
            samplingMode: diagnostics.samplingMode ?? null,
            canvasBackend: diagnostics.canvasBackend ?? null,
        };
    });
}

function getTabsForServer() {
    return currentTabs.map(({ tabId, title, active }) => ({ tabId, title, active }));
}

// ── WebSocket lifecycle ───────────────────────────────────────────────────────

function connect() {
    if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    try {
        ws = new WebSocket(WS_URL);
    } catch {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        console.log('[HABridge] Connected to GNOME extension');
        broadcastTabStatus();
    };

    ws.onclose = () => {
        ws = null;
        console.log('[HABridge] Disconnected — reconnecting in', RECONNECT_DELAY_MS, 'ms');
        scheduleReconnect();
    };

    ws.onerror = () => {
        ws?.close();
    };

    ws.onmessage = event => {
        try {
            const msg = JSON.parse(event.data);
            handleServerMessage(msg);
        } catch {}
    };
}

function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_DELAY_MS);
}

function send(msg) {
    if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(msg));
}

// ── Server → client messages ──────────────────────────────────────────────────

function handleServerMessage(msg) {
    if (msg.type === 'config' && msg.selectedTab !== undefined) {
        selectedTab = String(msg.selectedTab);
        syncTabDiagnostics(currentTabs.map(({ tabId, title, active }) => ({ tabId, title, active })));
    }
}

// ── Tab status ────────────────────────────────────────────────────────────────

async function broadcastTabStatus() {
    try {
        const tabs = await browser.tabs.query({ url: '*://www.youtube.com/*' });
        syncTabDiagnostics(tabs.map(t => ({
            tabId: t.id,
            title: t.title ?? '',
            active: t.active,
        })));
        send({ type: 'status', tabs: getTabsForServer() });
    } catch {}
}

// ── Content script messages ───────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'frame') {
        const tabId = sender.tab?.id ?? null;
        lastColor = colorToHex(msg.color);
        lastFrameTabId = tabId;
        updateTabSamplerState(tabId, {
            samplingMode: msg.samplingMode,
            canvasBackend: msg.canvasBackend,
            error: null,
        });
        updateTabColor(tabId, msg.color);
        syncTabDiagnostics(currentTabs.map(({ tabId, title, active }) => ({ tabId, title, active })));
        send({
            type: 'frame',
            tabId,
            color: msg.color,
        });
    }

    if (msg.type === 'status') {
        broadcastTabStatus();
    }

    if (msg.type === 'samplerStatus') {
        const tabId = sender.tab?.id ?? null;
        const hasExplicitError = Object.prototype.hasOwnProperty.call(msg, 'error');
        updateTabSamplerState(tabId, {
            samplingMode: msg.samplingMode,
            canvasBackend: msg.canvasBackend,
            error: hasExplicitError ? msg.error : undefined,
        });
        syncTabDiagnostics(currentTabs.map(({ tabId, title, active }) => ({ tabId, title, active })));
    }

    // Popup requests current state
    if (msg.type === 'getState') {
        return Promise.resolve({
            connected: ws?.readyState === WebSocket.OPEN,
            tabs: currentTabs,
            lastColor,
            lastFrameTabId,
            selectedTab,
            lastSamplerState,
        });
    }
});

// ── Tab event listeners ───────────────────────────────────────────────────────

browser.tabs.onActivated.addListener(() => broadcastTabStatus());
browser.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete' || info.title !== undefined)
        broadcastTabStatus();
});
browser.tabs.onRemoved.addListener(tabId => {
    tabColorState.delete(tabId);
    broadcastTabStatus();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

connect();
