UUID      = hacontrolpanel@friedjof.github.io
DEST      = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC       = $(UUID)
FIREFOX_SRC = firefox-extension
LOG       = /tmp/roompanel-shell.log
OUT_DIR   ?= dist
SCHEMA    = schemas/org.gnome.shell.extensions.hacontrolpanel.gschema.xml
ZIP       = $(OUT_DIR)/$(UUID).shell-extension.zip
ZIP_ABS   = $(abspath $(ZIP))
FIREFOX_ZIP = $(OUT_DIR)/hacontrolpanel-bridge.firefox-extension.xpi
FIREFOX_ZIP_ABS = $(abspath $(FIREFOX_ZIP))

SCREEN_RES := $(shell xrandr 2>/dev/null | awk '/ primary/{match($$0,/[0-9]+x[0-9]+/); print substr($$0,RSTART,RLENGTH)}')
MUTTER_SPECS ?= $(if $(SCREEN_RES),$(SCREEN_RES),1920x1080)

BRIDGE_PORT ?= 7842

.PHONY: install remove reinstall run log pack pack-firefox test-bridge check-bridge

install:
	glib-compile-schemas $(SRC)/schemas/
	rm -rf $(DEST)
	cp -r $(SRC) $(DEST)
	@echo "Installed $(UUID) → $(DEST)"

remove:
	gnome-extensions disable $(UUID) 2>/dev/null || true
	rm -rf $(DEST)
	@echo "Removed $(UUID)"

reinstall: remove install

pack:
	mkdir -p $(OUT_DIR)
	glib-compile-schemas --strict $(SRC)/schemas/
	rm -f $(ZIP_ABS)
	cd $(SRC) && zip -qr $(ZIP_ABS) \
		metadata.json \
		extension.js \
		prefs.js \
		stylesheet.css \
		lib \
		prefs \
		ui \
		$(SCHEMA)
	@echo "Packed $(ZIP)"

pack-firefox:
	mkdir -p $(OUT_DIR)
	rm -f $(FIREFOX_ZIP_ABS)
	cd $(FIREFOX_SRC) && zip -qr $(FIREFOX_ZIP_ABS) \
		manifest.json \
		background.js \
		content \
		icons \
		popup
	@echo "Packed $(FIREFOX_ZIP)"

# Launch a nested GNOME Shell session.
# The extension is enabled *inside* the new D-Bus session by polling until
# gnome-shell is ready, then calling gnome-extensions enable.
# All shell output (including JS errors) is saved to $(LOG).
run: install
	@echo "Log: $(LOG)"
	@echo "Starting nested GNOME Shell at $(MUTTER_SPECS)…"
	@MUTTER_DEBUG_DUMMY_MODE_SPECS=$(MUTTER_SPECS) \
	dbus-run-session -- bash -c '\
		gnome-shell --nested --wayland 2>&1 | tee $(LOG) & \
		SHELL_PID=$$!; \
		echo "  Waiting for extension to be registered…"; \
		TRIES=0; \
		until gnome-extensions list 2>/dev/null | grep -qF "$(UUID)"; do \
			sleep 0.5; TRIES=$$((TRIES+1)); \
			[ $$TRIES -gt 60 ] && echo "  Timeout waiting for extension" && break; \
		done; \
		gnome-extensions enable $(UUID) 2>/dev/null \
			&& echo "  Extension enabled: $(UUID)" \
			|| echo "  Extension already active via GSettings"; \
		wait $$SHELL_PID'

# Show last nested-shell log (JS errors, extension state, etc.)
log:
	@cat $(LOG) 2>/dev/null || echo "No log yet – run 'make run' first"

# ── Browser Bridge test environment ─────────────────────────────────────────
# Starts a nested GNOME Shell with the extension pre-configured for
# Browser Bridge testing (bridge enabled on port $(BRIDGE_PORT) with bridge
# priority enabled over the selected screen source).
# After the shell is ready, instructions for loading the Firefox extension
# are printed. Use 'make check-bridge' in a second terminal to verify the port.
test-bridge: install
	@echo "──────────────────────────────────────────────"
	@echo " Browser Bridge test environment"
	@echo " Port: $(BRIDGE_PORT)"
	@echo " Log:  $(LOG)"
	@echo "──────────────────────────────────────────────"
	@MUTTER_DEBUG_DUMMY_MODE_SPECS=$(MUTTER_SPECS) \
	dbus-run-session -- bash -c '\
		gnome-shell --nested --wayland 2>&1 | tee $(LOG) & \
		SHELL_PID=$$!; \
		echo "  Waiting for shell…"; \
		TRIES=0; \
		until gnome-extensions list 2>/dev/null | grep -qF "$(UUID)"; do \
			sleep 0.5; TRIES=$$((TRIES+1)); \
			[ $$TRIES -gt 60 ] && echo "  Timeout!" && break; \
		done; \
		gnome-extensions enable $(UUID) 2>/dev/null \
			&& echo "  Extension enabled" \
			|| echo "  Extension already active"; \
		sleep 1; \
		SCHEMA_ID=org.gnome.shell.extensions.hacontrolpanel; \
		SDIR=$(DEST)/schemas; \
		gsettings --schemadir $$SDIR set $$SCHEMA_ID browser-bridge-enabled true; \
		gsettings --schemadir $$SDIR set $$SCHEMA_ID browser-bridge-port $(BRIDGE_PORT); \
		gsettings --schemadir $$SDIR set $$SCHEMA_ID browser-bridge-priority true; \
		gsettings --schemadir $$SDIR set $$SCHEMA_ID screen-sync-enabled true; \
		gsettings --schemadir $$SDIR set $$SCHEMA_ID screen-sync-scope primary; \
		echo ""; \
		echo "  ✓ Browser Bridge enabled on port $(BRIDGE_PORT)"; \
		echo "  ✓ Browser Bridge priority enabled"; \
		echo "  ✓ Screen Sync source set to: primary"; \
		echo ""; \
		echo "  Next steps:"; \
		echo "  1. Open Firefox → about:debugging → This Firefox"; \
		echo "     → Load Temporary Add-on → select firefox-extension/manifest.json"; \
		echo "  2. Open https://www.youtube.com and play a video"; \
		echo "  3. Check the extension popup — it should show 'Connected'"; \
		echo "  4. Run in another terminal:  make check-bridge"; \
		echo "  5. Or simulate Firefox:      python3 tools/bridge-test-client.py"; \
		echo ""; \
		wait $$SHELL_PID'

# Check whether the bridge port is listening (run in a second terminal while test-bridge is active)
check-bridge:
	@echo "Checking port $(BRIDGE_PORT)…"
	@ss -tlnp | grep :$(BRIDGE_PORT) \
		&& echo "  ✓ Port $(BRIDGE_PORT) is open" \
		|| echo "  ✗ Port $(BRIDGE_PORT) not found — is test-bridge running?"
