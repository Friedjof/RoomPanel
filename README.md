# HAControlPanel

HAControlPanel is a GNOME Shell extension that adds a compact Home Assistant control panel to the top bar. It is built for quick everyday actions: lights, sliders, custom service buttons, read-only sensor tiles, screen sync for RGB lights, and real-time YouTube color sync via a companion Firefox extension.

> This repository is currently in beta. Significant parts of the project are developed with AI assistance, so behavior, UX, and internal structure may still change quickly.

<table>
  <tr>
    <td align="center" width="34%">
      <img src="media/action-panel.png" alt="HAControlPanel panel with color picker, slider, and action buttons" height="250"><br>
      <sub>🎛️ Panel: color picker, sliders, and quick action buttons</sub>
    </td>
    <td align="center" width="33%">
      <img src="media/screen-sync.png" alt="HAControlPanel screen sync settings" height="250"><br>
      <sub>🖥️ Screen Sync: multi-light sync, preview, and condition gating</sub>
    </td>
    <td align="center" width="33%">
      <img src="media/settings.png" alt="HAControlPanel preferences dialog" height="250"><br>
      <sub>⚙️ Preferences: connection, actions, sensors, and backup</sub>
    </td>
  </tr>
</table>

## ✨ Highlights

- 🎚️ Top bar popup with separate Actions and Sensors views
- 🎨 Live color picker for up to 4 RGB-capable Home Assistant lights
- 🔆 Slider controls with configurable entity, service, attribute, and range
- 🧩 Custom action buttons with emoji, optional button color, and JSON service data
- 🌡️ Sensor widgets for read-only status tiles in the panel menu
- 🖥️ Screen sync with multiple target lights, selectable sampling mode, scope, interval, and preview
- ✅ Optional screen sync condition based on any Home Assistant entity using `=`, `!=`, or `regex`
- 🔎 Condition debugging with live status dot, manual check, and last-24-hours state log
- 🦊 **Browser Bridge**: companion Firefox extension streams YouTube video colors to your lights in real time
- 💾 YAML export, import, validation, auto-backup, and sync from file
- 🔐 Backup files intentionally exclude the Home Assistant access token

## 🦊 Browser Bridge

The Browser Bridge lets the companion Firefox extension send YouTube video colors directly to your lights. It feeds into the same screen sync pipeline, so interpolation, throttling, and threshold logic still apply.

### How it works

```
YouTube Tab
  └── content script samples video at ≤10 fps (64×36 canvas)
           ↓  WebSocket  ws://localhost:7842
GNOME Extension (BrowserBridgeServer)
  └── feeds colors into the screen sync pipeline
           ↓
Home Assistant lights
```

### Enable it in HAControlPanel

1. **Enable the server** in Preferences → Connection → *Firefox Extension* → toggle *Enable Browser Bridge*.
2. **Open the Actions preferences**. Once Firefox is connected, a *Firefox Browser Bridge* section appears below *Color Source*.
3. **Enable priority** there if Firefox should exclusively drive screen sync while the extension stays connected.
4. Open YouTube and play a video — your lights will follow the video colors. If no YouTube color data is currently arriving, HAControlPanel keeps waiting for Firefox. Only when Firefox disconnects does the normal screen source take over again.

The *Connection* preferences page shows live diagnostics: connection status, active YouTube tab, and a color preview swatch.

## ✅ Requirements

- GNOME Shell 45, 46, or 47
- `gjs`, `glib-compile-schemas`, and standard GNOME extension tooling
- A reachable Home Assistant instance with a long-lived access token
- Firefox 140+ (for the Browser Bridge feature)

## 📦 Installation

Until the extension is published on extensions.gnome.org, install it from the GitHub Releases page.

1. Download `hacontrolpanel@friedjof.github.io-vX.Y.Z.shell-extension.zip` from the latest release.
2. Install it with `gnome-extensions install --force hacontrolpanel@friedjof.github.io-vX.Y.Z.shell-extension.zip`.
3. Enable it with `gnome-extensions enable hacontrolpanel@friedjof.github.io` or through the Extensions app.

## 🦊 Firefox Extension

The Firefox companion is a separate add-on from the GNOME Shell extension. You can either load it temporarily from the repository during development or install the signed `.xpi` from a GitHub release.

### Temporary load from the repository

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click *Load Temporary Add-on*.
3. Select `firefox-extension/manifest.json` from this repository.
4. Open the extension popup to verify that it can see YouTube tabs and connect to HAControlPanel.

This is the fastest way to test local changes, but Firefox removes temporary add-ons on browser restart.

### Install from a GitHub release

Each tagged release publishes a signed Firefox add-on asset named like `hacontrolpanel-bridge-v1.2.3.firefox-extension.xpi` alongside the GNOME Shell zip.

1. Open the latest GitHub release and download the `hacontrolpanel-bridge-vX.Y.Z.firefox-extension.xpi` asset.
2. In Firefox, open *Add-ons and Themes*.
3. Open the gear menu and choose *Install Add-on From File…*.
4. Select the downloaded `.xpi`.
5. Then enable the Browser Bridge in HAControlPanel Preferences → Connection and verify the popup shows *Connected*.

### What the release contains

- `hacontrolpanel@friedjof.github.io-vX.Y.Z.shell-extension.zip`: the GNOME Shell extension bundle
- `hacontrolpanel-bridge-vX.Y.Z.firefox-extension.xpi`: the signed Firefox Browser Bridge add-on

The release notes generated by CI include the same installation steps for both artifacts.

## ⚙️ Configuration

The preferences window is split into focused pages:

- **Connection**: Home Assistant URL, long-lived access token, SSL verification, connection test, entity/service refresh, and Firefox Extension diagnostics
- **Actions**: color picker entities, slider entities, action buttons, and screen sync setup
- **Sensors**: read-only sensor tiles for the panel menu
- **Backup**: YAML export/import, validation, auto-backup, editor integration, and sync from file

The backup validator checks for broken or suspicious values before import or sync, including empty required entity IDs in panel configuration.

## 🛠️ Development

### Repository layout

```text
hacontrolpanel@friedjof.github.io/   ← GNOME Shell extension source
  lib/                               ← core logic (HA client, screen sync, browser bridge)
  ui/                                ← panel menu widgets
  prefs/                             ← preferences dialog pages
  schemas/                           ← GSettings schema

firefox-extension/                   ← companion Firefox extension
  content/youtube.js                 ← video color sampling (content script)
  background.js                      ← WebSocket client + tab tracking
  popup/                             ← status popup

tools/
  bridge-test-client.py              ← simulates the Firefox extension (no browser needed)
```

### Make targets

| Command | Description |
|---|---|
| `make install` | Compile schemas and copy extension into the local GNOME Shell extensions directory |
| `make reinstall` | Remove and install again (picks up all changes) |
| `make run` | Start a nested GNOME Shell session; logs go to `/tmp/roompanel-shell.log` |
| `make log` | Print the last nested-shell log (JS errors, extension output) |
| `make pack` | Create `dist/hacontrolpanel@friedjof.github.io.shell-extension.zip` |
| `make test-bridge` | Start a nested shell **pre-configured** for Browser Bridge testing |
| `make check-bridge` | Verify that port 7842 is open (run in a second terminal) |

### Browser Bridge test environment

`make test-bridge` starts a nested GNOME Shell with `browser-bridge-enabled`, `browser-bridge-priority`, and `screen-sync-enabled` already set. After the shell is ready, it prints step-by-step instructions.

**Option A — with real Firefox:**
1. `make test-bridge`
2. Firefox → `about:debugging` → *Load Temporary Add-on* → `firefox-extension/manifest.json`
3. Open YouTube and play a video
4. Check the extension popup for *Connected* status

**Option B — without Firefox (simulate the extension):**
```bash
pip install websockets          # one-time setup
python3 tools/bridge-test-client.py --mode sunset
```
Streams color frames directly to the GNOME extension to test the pipeline end-to-end without a browser.

Available modes: `cycle` (rainbow), `random`, `sunset` (warm tones).

### Reading logs

```bash
make log                        # full nested-shell output
journalctl -f -o cat            # live GNOME Shell log on the host session
```

JS errors from the extension appear prefixed with `[HAControlPanel]`.

## 📝 Notes

- `hacontrolpanel@friedjof.github.io/schemas/gschemas.compiled` is generated and should not be committed
- Local tool configuration in `.claude/` is intentionally ignored
- YAML backups include panel settings, buttons, sensors, and screen sync condition data, but never the Home Assistant token
- The Browser Bridge WebSocket server only binds to `localhost` — it is not accessible from other machines on the network
