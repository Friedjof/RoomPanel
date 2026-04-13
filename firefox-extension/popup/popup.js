/**
 * HAControlPanel Bridge — popup script
 *
 * Displays live connection status, YouTube tab info, and the last
 * received color by polling the background service worker.
 */

const connDot    = document.getElementById('connDot');
const connStatus = document.getElementById('connStatus');
const ytDot      = document.getElementById('ytDot');
const ytStatus   = document.getElementById('ytStatus');
const colorSwatch = document.getElementById('colorSwatch');
const colorValue  = document.getElementById('colorValue');
const selectedSource = document.getElementById('selectedSource');
const frameDot = document.getElementById('frameDot');
const frameStatus = document.getElementById('frameStatus');
const tabList = document.getElementById('tabList');

function trimTitle(title) {
    const clean = (title ?? '').replace(/ [-–|].*YouTube.*$/, '').trim();
    return clean || 'Untitled tab';
}

function formatAge(timestamp) {
    if (!timestamp)
        return 'No frames yet';

    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds <= 1)
        return 'Updated just now';
    if (seconds < 60)
        return `Updated ${seconds}s ago`;

    const minutes = Math.round(seconds / 60);
    return `Updated ${minutes}m ago`;
}

function makeBadge(label, className) {
    const badge = document.createElement('span');
    badge.className = `badge ${className}`;
    badge.textContent = label;
    return badge;
}

function samplerBackendLabel(state) {
    const parts = [];
    if (state?.canvasBackend === 'offscreen')
        parts.push('OffscreenCanvas');
    else if (state?.canvasBackend === 'dom')
        parts.push('Canvas');

    if (state?.samplingMode === 'video-frame')
        parts.push('rVFC');
    else if (state?.samplingMode === 'animation-frame')
        parts.push('rAF');

    return parts.join(' / ');
}

function findPreferredTab(tabs, selectedTab) {
    if (selectedTab === 'auto')
        return tabs.find(tab => tab.active) ?? null;

    return tabs.find(tab => String(tab.tabId) === String(selectedTab)) ?? null;
}

function summarizeSamplerError(state, tabs, preferredTab) {
    const candidates = [
        preferredTab,
        tabs.find(tab => tab.lastError),
    ].filter(Boolean);

    const issue = candidates.find(tab => tab.lastError);
    if (issue) {
        if (issue.lastErrorCode === 'canvas-security')
            return 'Canvas readback blocked';
        if (issue.lastErrorCode === 'canvas-unavailable')
            return 'Canvas backend unavailable';
        if (issue.lastErrorCode === 'video-not-ready')
            return 'Video not ready yet';
        return issue.lastError;
    }

    if (state?.lastSamplerState?.lastError)
        return state.lastSamplerState.lastError;

    return null;
}

function updateFrameStatus(state, tabs, preferredTab) {
    const backend = samplerBackendLabel(state?.lastSamplerState);
    const freshTab = tabs.find(tab => tab.frameFresh);
    const error = summarizeSamplerError(state, tabs, preferredTab);

    if (error) {
        frameDot.className = 'dot dot-red';
        frameStatus.textContent = backend ? `${error} · ${backend}` : error;
        frameStatus.title = state?.lastSamplerState?.lastError ?? error;
        return;
    }

    if (freshTab) {
        frameDot.className = 'dot dot-green';
        frameStatus.textContent = backend ? `Streaming · ${backend}` : 'Streaming';
        frameStatus.title = freshTab.lastColor ?? frameStatus.textContent;
        return;
    }

    if (tabs.length > 0) {
        frameDot.className = 'dot dot-yellow';
        frameStatus.textContent = backend ? `Waiting · ${backend}` : 'Waiting for frames';
        frameStatus.title = frameStatus.textContent;
        return;
    }

    frameDot.className = 'dot dot-gray';
    frameStatus.textContent = 'No sampler activity';
    frameStatus.title = frameStatus.textContent;
}

function renderTabs(tabs, selectedTab) {
    tabList.textContent = '';

    if (!tabs.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No YouTube tabs detected';
        tabList.append(empty);
        return;
    }

    const sortedTabs = [...tabs].sort((a, b) => {
        const aPriority = (a.selected ? 4 : 0) + (a.active ? 2 : 0) + (a.frameFresh ? 1 : 0);
        const bPriority = (b.selected ? 4 : 0) + (b.active ? 2 : 0) + (b.frameFresh ? 1 : 0);
        if (aPriority !== bPriority)
            return bPriority - aPriority;
        return (b.lastFrameAt ?? 0) - (a.lastFrameAt ?? 0);
    });

    for (const tab of sortedTabs) {
        const card = document.createElement('div');
        const effectiveSelected = selectedTab === 'auto' ? !!tab.active : !!tab.selected;
        card.className = `tab-card${effectiveSelected ? ' selected' : ''}`;

        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = tab.lastColor ?? '';
        card.append(swatch);

        const main = document.createElement('div');
        main.className = 'tab-main';

        const title = document.createElement('div');
        title.className = 'tab-title';
        title.textContent = trimTitle(tab.title);
        main.append(title);

        const meta = document.createElement('div');
        meta.className = 'tab-meta';
        meta.append(makeBadge(`Tab ${tab.tabId}`, 'badge-gray'));
        if (tab.active)
            meta.append(makeBadge('Focused', 'badge-blue'));
        if (tab.selected)
            meta.append(makeBadge('Selected', 'badge-green'));
        if (selectedTab === 'auto' && tab.active)
            meta.append(makeBadge('Auto', 'badge-green'));
        if (tab.lastError)
            meta.append(makeBadge('Sampler Error', 'badge-red'));
        else if (tab.frameFresh)
            meta.append(makeBadge('Streaming', 'badge-yellow'));
        else if (tab.framesSeen > 0)
            meta.append(makeBadge('Idle', 'badge-gray'));
        else
            meta.append(makeBadge('No Frames', 'badge-gray'));
        main.append(meta);
        card.append(main);
        if (tab.lastError)
            card.title = tab.lastError;

        const side = document.createElement('div');
        side.className = 'tab-side';

        const hex = document.createElement('div');
        hex.className = 'tab-color';
        hex.textContent = (tab.lastColor ?? '–').toUpperCase();
        side.append(hex);

        const age = document.createElement('div');
        age.className = 'tab-age';
        age.textContent = formatAge(tab.lastFrameAt);
        side.append(age);

        card.append(side);
        tabList.append(card);
    }
}

async function refresh() {
    let state;
    try {
        state = await browser.runtime.sendMessage({ type: 'getState' });
    } catch {
        // Background not yet ready
        return;
    }

    if (!state) return;

    // Connection status
    if (state.connected) {
        connDot.className = 'dot dot-green';
        connStatus.textContent = 'Connected';
    } else {
        connDot.className = 'dot dot-red';
        connStatus.textContent = 'Disconnected';
    }

    // YouTube tabs
    const tabs = state.tabs ?? [];
    const activeTab = tabs.find(t => t.active);
    if (tabs.length === 0) {
        ytDot.className = 'dot dot-gray';
        ytStatus.textContent = 'No tabs';
    } else if (activeTab) {
        ytDot.className = 'dot dot-green';
        const name = (activeTab.title ?? '').replace(/ [-–|].*YouTube.*$/, '').trim() || 'Active tab';
        ytStatus.textContent = name.slice(0, 22);
    } else {
        ytDot.className = 'dot dot-yellow';
        ytStatus.textContent = `${tabs.length} tab(s), none active`;
    }

    // Last color
    const hex = state.lastColor;
    if (hex) {
        colorSwatch.style.background = hex;
        colorValue.textContent = state.lastFrameTabId !== null
            ? `${hex.toUpperCase()} · T${state.lastFrameTabId}`
            : hex.toUpperCase();
    } else {
        colorSwatch.style.background = '';
        colorValue.textContent = '–';
    }

    if (state.selectedTab === 'auto') {
        selectedSource.textContent = activeTab ? `Auto: ${trimTitle(activeTab.title)}` : 'Auto';
    } else {
        const selected = tabs.find(tab => String(tab.tabId) === String(state.selectedTab));
        selectedSource.textContent = selected
            ? trimTitle(selected.title)
            : `Tab ${state.selectedTab}`;
    }

    updateFrameStatus(state, tabs, findPreferredTab(tabs, state.selectedTab));
    renderTabs(tabs, state.selectedTab);
}

refresh();
setInterval(refresh, 1000);
