/**
 * HAControlPanel Bridge — YouTube content script
 *
 * Samples the currently playing YouTube video at up to 10fps using
 * requestVideoFrameCallback. Each frame is downscaled to a 64×36
 * OffscreenCanvas and the average RGB value is sent to the background
 * service worker, which forwards it to the GNOME extension via WebSocket.
 *
 * Additionally reports document-visibility changes so the background worker
 * can keep an accurate list of which tabs are active.
 */

const CANVAS_W = 64;
const CANVAS_H = 36;
const MIN_INTERVAL_MS = 100; // ≤ 10 fps

const canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let animId = null;
let lastSent = 0;

// ── Color sampling ────────────────────────────────────────────────────────────

function avgColor(video) {
    ctx.drawImage(video, 0, 0, CANVAS_W, CANVAS_H);
    const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
    let r = 0, g = 0, b = 0;
    const pixels = CANVAS_W * CANVAS_H;
    for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
    }
    return {
        r: Math.round(r / pixels),
        g: Math.round(g / pixels),
        b: Math.round(b / pixels),
    };
}

function startSampling(video) {
    if (animId !== null) return; // already running

    function onFrame(now) {
        if (now - lastSent >= MIN_INTERVAL_MS && !video.paused && !video.ended) {
            const color = avgColor(video);
            browser.runtime.sendMessage({ type: 'frame', color }).catch(() => {});
            lastSent = now;
        }
        animId = video.requestVideoFrameCallback(onFrame);
    }

    animId = video.requestVideoFrameCallback(onFrame);
}

function stopSampling(video) {
    if (animId !== null) {
        video.cancelVideoFrameCallback(animId);
        animId = null;
    }
}

// ── Tab visibility ────────────────────────────────────────────────────────────

function sendStatus() {
    browser.runtime.sendMessage({
        type: 'status',
        active: !document.hidden,
        title: document.title,
    }).catch(() => {});
}

document.addEventListener('visibilitychange', sendStatus);

// ── Video discovery ───────────────────────────────────────────────────────────

function attachVideo(video) {
    if (video._haBridgeAttached) return;
    video._haBridgeAttached = true;
    startSampling(video);

    // Stop when the video is removed from the DOM
    const ro = new MutationObserver(() => {
        if (!document.contains(video)) {
            stopSampling(video);
            ro.disconnect();
        }
    });
    ro.observe(document.body, { childList: true, subtree: true });
}

// Attach to any video already in the DOM
document.querySelectorAll('video').forEach(attachVideo);

// Watch for dynamically added videos (YouTube SPA navigation)
const observer = new MutationObserver(() => {
    document.querySelectorAll('video').forEach(attachVideo);
});
observer.observe(document.body, { childList: true, subtree: true });

// Report initial tab visibility
sendStatus();
