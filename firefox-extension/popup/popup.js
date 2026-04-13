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
        colorValue.textContent = hex.toUpperCase();
    } else {
        colorSwatch.style.background = '';
        colorValue.textContent = '–';
    }
}

refresh();
setInterval(refresh, 1000);
