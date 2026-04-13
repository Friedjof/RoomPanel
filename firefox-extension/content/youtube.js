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
const ERROR_REPORT_INTERVAL_MS = 5000;

function createSamplingContext() {
    if (typeof OffscreenCanvas !== 'undefined') {
        try {
            const canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx)
                return { ctx, canvasBackend: 'offscreen' };
        } catch {}
    }

    try {
        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx)
            return { ctx, canvasBackend: 'dom' };
    } catch {}

    return { ctx: null, canvasBackend: 'unavailable' };
}

const { ctx, canvasBackend } = createSamplingContext();
const supportsVideoFrameCallback =
    typeof HTMLVideoElement !== 'undefined' &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function' &&
    typeof HTMLVideoElement.prototype.cancelVideoFrameCallback === 'function';
const samplingMode = supportsVideoFrameCallback ? 'video-frame' : 'animation-frame';

let animId = null;
let activeVideo = null;
let activeScheduler = null;
let lastSent = 0;
let lastReportedError = '';
let lastErrorReportAt = 0;

function sendRuntimeMessage(message) {
    browser.runtime.sendMessage(message).catch(() => {});
}

function reportSamplerStatus(error = undefined) {
    const message = {
        type: 'samplerStatus',
        samplingMode,
        canvasBackend,
    };

    if (error !== undefined)
        message.error = error;

    sendRuntimeMessage(message);
}

function formatSamplingError(error) {
    const name = error?.name ?? 'Error';
    const message = error?.message ? `${name}: ${error.message}` : name;

    if (name === 'SecurityError') {
        return {
            code: 'canvas-security',
            message: 'Canvas readback blocked by the video element',
        };
    }

    if (name === 'InvalidStateError') {
        return {
            code: 'video-not-ready',
            message: 'Video frame not ready for sampling yet',
        };
    }

    if (name === 'CanvasUnavailableError') {
        return {
            code: 'canvas-unavailable',
            message,
        };
    }

    return {
        code: 'sampling-failed',
        message,
    };
}

function reportSamplingError(error) {
    const formatted = formatSamplingError(error);
    const fingerprint = `${formatted.code}:${formatted.message}`;
    const now = Date.now();

    if (fingerprint === lastReportedError &&
        (now - lastErrorReportAt) < ERROR_REPORT_INTERVAL_MS)
        return;

    lastReportedError = fingerprint;
    lastErrorReportAt = now;
    reportSamplerStatus({
        ...formatted,
        at: now,
    });
}

function clearSamplingError() {
    if (!lastReportedError)
        return;

    lastReportedError = '';
    lastErrorReportAt = 0;
    reportSamplerStatus(null);
}

function scheduleNextFrame(video, callback) {
    if (supportsVideoFrameCallback) {
        activeScheduler = 'video-frame';
        animId = video.requestVideoFrameCallback(callback);
        return;
    }

    activeScheduler = 'animation-frame';
    animId = requestAnimationFrame(callback);
}

function cancelScheduledFrame(video) {
    if (animId === null)
        return;

    if (activeScheduler === 'video-frame' &&
        video &&
        typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(animId);
    } else if (activeScheduler === 'animation-frame') {
        cancelAnimationFrame(animId);
    }

    animId = null;
    activeScheduler = null;
}

// ── Color sampling ────────────────────────────────────────────────────────────

function avgColor(video) {
    if (!ctx)
        throw new DOMException('No usable 2D canvas context in content script', 'CanvasUnavailableError');

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
    if (!video)
        return;

    if (activeVideo && activeVideo !== video) {
        const staleVideo = !activeVideo.isConnected || activeVideo.paused || activeVideo.ended;
        if (!staleVideo)
            return;
        stopSampling(activeVideo);
    }

    if (animId !== null)
        return;

    activeVideo = video;

    if (!ctx) {
        reportSamplingError(new DOMException(
            'No usable 2D canvas context in content script',
            'CanvasUnavailableError'
        ));
        return;
    }

    function onFrame(now) {
        try {
            const ready = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
            if (now - lastSent >= MIN_INTERVAL_MS && ready && !video.paused && !video.ended) {
                const color = avgColor(video);
                clearSamplingError();
                sendRuntimeMessage({
                    type: 'frame',
                    color,
                    samplingMode,
                    canvasBackend,
                });
                lastSent = now;
            }
        } catch (error) {
            reportSamplingError(error);
        } finally {
            if (video === activeVideo && video.isConnected)
                scheduleNextFrame(video, onFrame);
            else
                stopSampling(video);
        }
    }

    reportSamplerStatus(null);
    scheduleNextFrame(video, onFrame);
}

function stopSampling(video) {
    if (video && activeVideo && video !== activeVideo)
        return;

    cancelScheduledFrame(activeVideo ?? video);
    activeVideo = null;
}

// ── Tab visibility ────────────────────────────────────────────────────────────

function sendStatus() {
    sendRuntimeMessage({
        type: 'status',
        active: !document.hidden,
        title: document.title,
    });
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
reportSamplerStatus(ctx ? null : {
    code: 'canvas-unavailable',
    message: 'No usable 2D canvas context in content script',
    at: Date.now(),
});
