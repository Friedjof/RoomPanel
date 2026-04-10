UUID      = roompanel@friedjof.github.io
DEST      = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC       = $(UUID)
LOG       = /tmp/roompanel-shell.log
OUT_DIR   ?= dist
SCHEMA    = schemas/org.gnome.shell.extensions.roompanel.gschema.xml
ZIP       = $(OUT_DIR)/$(UUID).shell-extension.zip
ZIP_ABS   = $(abspath $(ZIP))

SCREEN_RES := $(shell xrandr 2>/dev/null | awk '/ primary/{match($$0,/[0-9]+x[0-9]+/); print substr($$0,RSTART,RLENGTH)}')
MUTTER_SPECS ?= $(if $(SCREEN_RES),$(SCREEN_RES),1920x1080)

.PHONY: install remove reinstall run log pack

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
