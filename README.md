# RoomPanel

RoomPanel is a GNOME Shell extension that puts a compact Home Assistant control panel into the top bar. The current state of the project is beta.

## Features

- Color picker that sends live Home Assistant service calls
- Slider control with configurable entity, service, attribute, and range
- Configurable action buttons with emoji, optional color, and custom service data
- Preferences UI for connection setup, entity/service lookup, and YAML import/export
- Optional automatic YAML backup without exporting the Home Assistant token

## Requirements

- GNOME Shell 45, 46, or 47
- `gjs`, `glib-compile-schemas`, and standard GNOME extension tooling
- A reachable Home Assistant instance with a long-lived access token

## Development

The project directory is the unpacked extension source:

```text
roompanel@friedjof.github.io/
```

Useful commands:

```bash
make install
make reinstall
make run
make log
```

`make run` starts a nested GNOME Shell session and writes shell output to `/tmp/roompanel-shell.log`.

## Notes

- The generated schema cache `roompanel@friedjof.github.io/schemas/gschemas.compiled` should not be committed.
- Local tool configuration in `.claude/` is intentionally ignored.
- YAML backups include panel settings and button configuration, but not the Home Assistant token.
