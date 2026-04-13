#!/usr/bin/env python3
"""
HAControlPanel Browser Bridge — Interactive Test Client

Simulates the Firefox extension via WebSocket and provides a live terminal UI
for testing tab counts, focus changes, GNOME tab selection, and timing jitter.

Controls:
    q             Quit
    Space         Pause/resume frame streaming
    + / -         Increase/decrease simulated tab count
    Left / Right  Move focused tab
    h / l         Move focused tab
    0             No focused tab
    1..9          Focus a specific tab
    r             Randomize focused tab
    m             Cycle color mode
    [ / ]         Faster / slower random interval range
    , / .         Slower / faster color transitions
    b             Force a fresh random color burst on all tabs
    s             Resend tab status immediately

Requirements:
    pip install websockets        # or: apt install python3-websockets
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import curses
import json
import random
import sys
import time
from collections import deque
from dataclasses import dataclass, field


TAB_TITLES = [
    'Big Buck Bunny',
    'Never Gonna Give You Up',
    'Blender Open Movie',
    'Lo-fi Hip Hop Radio',
    'Aurora Borealis 4K',
    'Synthwave Mix',
    'Deep Focus Session',
    'Cinema Trailer Reel',
]

COLOR_MODES = ('chaos', 'random', 'cycle', 'sunset')
LOG_LIMIT = 8
MIN_INTERVAL_FLOOR_MS = 30
MAX_INTERVAL_CEIL_MS = 3000
MAX_TABS = 12
MIN_COLOR_SPEED = 0.05
MAX_COLOR_SPEED = 2.50


Color = tuple[int, int, int]


@dataclass
class SimTab:
    tab_id: int
    title: str
    active: bool = False
    color: Color = (40, 40, 40)
    target_color: Color = (255, 80, 20)
    frames_sent: int = 0
    last_sent_at: float = 0.0
    next_due_at: float = 0.0
    phase: float = field(default_factory=random.random)


@dataclass
class AppState:
    port: int
    mode: str
    min_interval_ms: int
    max_interval_ms: int
    color_speed: float
    active_index: int
    tabs: list[SimTab] = field(default_factory=list)
    paused: bool = False
    should_exit: bool = False
    connected: bool = False
    reconnect_deadline: float = 0.0
    connection_error: str = ''
    selected_tab: str | None = None
    sent_frames: int = 0
    sent_statuses: int = 0
    last_frame_color: Color | None = None
    last_frame_tab_id: int | None = None
    last_interval_ms: float = 0.0
    status_dirty: bool = True
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=LOG_LIMIT))


def clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def hsv_to_rgb(h: float, s: float, v: float) -> Color:
    if s == 0:
        value = int(v * 255)
        return value, value, value

    i = int(h * 6)
    f = h * 6 - i
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    r, g, b = (
        (v, t, p),
        (q, v, p),
        (p, v, t),
        (p, q, v),
        (t, p, v),
        (v, p, q),
    )[i % 6]
    return int(r * 255), int(g * 255), int(b * 255)


def random_vivid_color() -> Color:
    hue = random.random()
    saturation = random.uniform(0.65, 1.0)
    value = random.uniform(0.65, 1.0)
    return hsv_to_rgb(hue, saturation, value)


def blend_color(base: Color, target: Color, factor: float) -> Color:
    return tuple(
        clamp(int(round(b + (t - b) * factor)), 0, 255)
        for b, t in zip(base, target)
    )


def sunset_color(phase: float) -> Color:
    palette = [
        (255, 84, 24),
        (255, 148, 32),
        (220, 62, 64),
        (176, 38, 96),
        (88, 18, 130),
    ]
    step = phase * len(palette)
    i = int(step) % len(palette)
    j = (i + 1) % len(palette)
    mix = step - int(step)
    return blend_color(palette[i], palette[j], mix)


def color_to_hex(color: Color | None) -> str:
    if color is None:
        return '--------'
    r, g, b = color
    return f'#{r:02X}{g:02X}{b:02X}'


def color_to_payload(color: Color) -> dict[str, int]:
    r, g, b = color
    return {'r': r, 'g': g, 'b': b}


def build_tab_title(index: int) -> str:
    base = TAB_TITLES[index % len(TAB_TITLES)]
    if index < len(TAB_TITLES):
        return f'{base} - YouTube'
    return f'{base} #{index + 1} - YouTube'


def add_log(state: AppState, message: str) -> None:
    state.logs.appendleft(f'{time.strftime("%H:%M:%S")}  {message}')


def random_interval_ms(state: AppState) -> int:
    return random.randint(state.min_interval_ms, state.max_interval_ms)


def next_color_with_speed(tab: SimTab, mode: str, color_speed: float) -> Color:
    color_speed = max(MIN_COLOR_SPEED, min(MAX_COLOR_SPEED, color_speed))

    if mode == 'random':
        if random.random() < min(1.0, 0.18 + color_speed * 0.35):
            tab.target_color = random_vivid_color()
        return blend_color(tab.color, tab.target_color, min(0.95, 0.08 + color_speed * 0.22))

    if mode == 'cycle':
        tab.phase = (tab.phase + random.uniform(0.006, 0.018) * color_speed) % 1.0
        return hsv_to_rgb(tab.phase, 0.9, 0.9)

    if mode == 'sunset':
        tab.phase = (tab.phase + random.uniform(0.004, 0.012) * color_speed) % 1.0
        return sunset_color(tab.phase)

    # chaos: vivid random drift with occasional hard jumps
    if random.random() < min(0.8, 0.06 + color_speed * 0.12):
        tab.target_color = random_vivid_color()

    blend_min = min(0.65, 0.03 + color_speed * 0.04)
    blend_max = min(0.95, 0.10 + color_speed * 0.18)
    color = blend_color(tab.color, tab.target_color, random.uniform(blend_min, blend_max))

    if random.random() < min(0.35, 0.02 + color_speed * 0.05):
        accent = random.choice([
            (255, 255, 255),
            (255, 0, 96),
            (0, 220, 255),
            (255, 200, 0),
            (40, 255, 120),
            (16, 16, 24),
        ])
        accent_mix = min(0.90, 0.08 + color_speed * 0.22)
        color = blend_color(color, accent, random.uniform(accent_mix * 0.6, accent_mix))

    if random.random() < min(0.25, 0.01 + color_speed * 0.04):
        tab.target_color = random_vivid_color()

    return color


def channel_bar(value: int, width: int = 8) -> str:
    filled = int(round((value / 255) * width))
    return '█' * filled + '·' * (width - filled)


def focus_label(state: AppState) -> str:
    if state.active_index < 0:
        return 'none'
    if state.active_index >= len(state.tabs):
        return 'invalid'
    tab = state.tabs[state.active_index]
    return f'{state.active_index + 1}:{tab.tab_id}'


def selected_tab_matches(tab: SimTab, selected_tab: str | None) -> bool:
    if selected_tab is None:
        return False
    if selected_tab == 'auto':
        return tab.active
    return str(tab.tab_id) == str(selected_tab)


def ensure_tab_count(state: AppState, count: int) -> None:
    count = clamp(count, 1, MAX_TABS)
    old_tabs = {tab.tab_id: tab for tab in state.tabs}
    now = time.monotonic()
    new_tabs: list[SimTab] = []

    for index in range(count):
        tab_id = 100 + index
        title = build_tab_title(index)
        existing = old_tabs.get(tab_id)
        if existing:
            existing.title = title
            new_tabs.append(existing)
            continue

        color = random_vivid_color()
        new_tabs.append(SimTab(
            tab_id=tab_id,
            title=title,
            color=color,
            target_color=random_vivid_color(),
            next_due_at=now + random_interval_ms(state) / 1000,
        ))

    state.tabs = new_tabs
    if state.active_index >= len(state.tabs):
        state.active_index = len(state.tabs) - 1
    set_active_index(state, state.active_index)


def set_active_index(state: AppState, index: int) -> None:
    if index < -1:
        index = -1
    if state.tabs and index >= len(state.tabs):
        index = len(state.tabs) - 1
    if not state.tabs:
        index = -1

    state.active_index = index
    for i, tab in enumerate(state.tabs):
        tab.active = (i == index)
    state.status_dirty = True


def move_focus(state: AppState, delta: int) -> None:
    if not state.tabs:
        return
    if state.active_index == -1:
        target = 0 if delta > 0 else len(state.tabs) - 1
    else:
        target = (state.active_index + delta) % len(state.tabs)
    set_active_index(state, target)
    add_log(state, f'Focused tab -> {focus_label(state)}')


def cycle_mode(state: AppState) -> None:
    current_idx = COLOR_MODES.index(state.mode)
    state.mode = COLOR_MODES[(current_idx + 1) % len(COLOR_MODES)]
    add_log(state, f'Color mode -> {state.mode}')


def adjust_speed(state: AppState, factor: float) -> None:
    min_ms = clamp(int(round(state.min_interval_ms * factor)), MIN_INTERVAL_FLOOR_MS, MAX_INTERVAL_CEIL_MS)
    max_ms = clamp(int(round(state.max_interval_ms * factor)), MIN_INTERVAL_FLOOR_MS, MAX_INTERVAL_CEIL_MS)
    if max_ms <= min_ms:
        max_ms = min(MAX_INTERVAL_CEIL_MS, min_ms + 40)
    state.min_interval_ms = min_ms
    state.max_interval_ms = max_ms
    add_log(state, f'Interval range -> {state.min_interval_ms}-{state.max_interval_ms} ms')


def adjust_color_speed(state: AppState, factor: float) -> None:
    state.color_speed = max(MIN_COLOR_SPEED, min(MAX_COLOR_SPEED, state.color_speed * factor))
    add_log(state, f'Color speed -> {state.color_speed:0.2f}x')


def burst_colors(state: AppState) -> None:
    now = time.monotonic()
    for tab in state.tabs:
        tab.target_color = random_vivid_color()
        tab.next_due_at = now
    add_log(state, 'Triggered random color burst')


def make_status_payload(state: AppState) -> dict[str, object]:
    return {
        'type': 'status',
        'tabs': [
            {'tabId': tab.tab_id, 'title': tab.title, 'active': tab.active}
            for tab in state.tabs
        ],
    }


async def send_status(ws, state: AppState) -> None:
    await ws.send(json.dumps(make_status_payload(state)))
    state.status_dirty = False
    state.sent_statuses += 1


async def recv_loop(ws, state: AppState) -> None:
    async for raw in ws:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue

        if data.get('type') != 'config':
            continue

        next_selected = data.get('selectedTab')
        next_selected = None if next_selected is None else str(next_selected)
        if next_selected != state.selected_tab:
            state.selected_tab = next_selected
            add_log(state, f'GNOME selectedTab -> {state.selected_tab or "—"}')


async def send_loop(ws, state: AppState) -> None:
    while True:
        if state.status_dirty:
            await send_status(ws, state)

        if state.paused:
            await asyncio.sleep(0.05)
            continue

        if not state.tabs:
            await asyncio.sleep(0.05)
            continue

        now = time.monotonic()
        due_tabs = [tab for tab in state.tabs if tab.next_due_at <= now]

        if not due_tabs:
            next_due = min(tab.next_due_at for tab in state.tabs)
            await asyncio.sleep(max(0.01, min(0.05, next_due - now)))
            continue

        random.shuffle(due_tabs)
        for tab in due_tabs:
            color = next_color_with_speed(tab, state.mode, state.color_speed)
            await ws.send(json.dumps({
                'type': 'frame',
                'tabId': tab.tab_id,
                'color': color_to_payload(color),
            }))

            sent_at = time.monotonic()
            tab.color = color
            tab.frames_sent += 1
            tab.last_sent_at = sent_at
            interval_ms = random_interval_ms(state)
            tab.next_due_at = sent_at + interval_ms / 1000

            state.sent_frames += 1
            state.last_frame_color = color
            state.last_frame_tab_id = tab.tab_id
            state.last_interval_ms = interval_ms

        await asyncio.sleep(0.01)


async def bridge_loop(state: AppState) -> None:
    try:
        import websockets
    except ImportError:
        add_log(state, 'Missing dependency: install python3-websockets or pip install websockets')
        state.connection_error = 'websockets package missing'
        while not state.should_exit:
            await asyncio.sleep(0.2)
        return

    uri = f'ws://localhost:{state.port}'

    while not state.should_exit:
        recv_task = None
        send_task = None

        try:
            add_log(state, f'Connecting to {uri}')
            async with websockets.connect(uri) as ws:
                state.connected = True
                state.connection_error = ''
                state.reconnect_deadline = 0.0
                state.selected_tab = None
                state.status_dirty = True
                add_log(state, 'Connected')

                recv_task = asyncio.create_task(recv_loop(ws, state))
                send_task = asyncio.create_task(send_loop(ws, state))

                done, pending = await asyncio.wait(
                    [recv_task, send_task],
                    return_when=asyncio.FIRST_COMPLETED,
                )

                for task in pending:
                    task.cancel()
                for task in pending:
                    with contextlib.suppress(asyncio.CancelledError):
                        await task

                for task in done:
                    if task.cancelled():
                        continue
                    exc = task.exception()
                    if exc:
                        raise exc

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            state.connection_error = f'{type(exc).__name__}: {exc}'
            add_log(state, f'Disconnected: {state.connection_error}')
        finally:
            state.connected = False
            state.selected_tab = None
            if recv_task:
                recv_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await recv_task
            if send_task:
                send_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await send_task

        if state.should_exit:
            break

        state.reconnect_deadline = time.monotonic() + 2.0
        while not state.should_exit and time.monotonic() < state.reconnect_deadline:
            await asyncio.sleep(0.1)


def add_text(stdscr, row: int, col: int, text: str, attr: int = 0) -> None:
    height, width = stdscr.getmaxyx()
    if row < 0 or row >= height or col >= width:
        return
    if col < 0:
        text = text[-col:]
        col = 0
    max_len = max(0, width - col - 1)
    if max_len <= 0:
        return
    try:
        stdscr.addnstr(row, col, text, max_len, attr)
    except curses.error:
        pass


def render(stdscr, state: AppState) -> None:
    stdscr.erase()
    height, width = stdscr.getmaxyx()
    now = time.monotonic()

    title = 'HAControlPanel Browser Bridge Lab'
    add_text(stdscr, 0, 0, title, curses.A_BOLD)
    add_text(stdscr, 1, 0, '═' * max(0, width - 1))

    connection = 'connected' if state.connected else 'disconnected'
    reconnect = ''
    if not state.connected and state.reconnect_deadline > now:
        reconnect = f'  reconnect in {state.reconnect_deadline - now:0.1f}s'
    if not state.connected and state.connection_error:
        reconnect += f'  ({state.connection_error})'
    add_text(stdscr, 2, 0, f'Connection: {connection}  ws://localhost:{state.port}{reconnect}')

    add_text(
        stdscr,
        3,
        0,
        f'Stream: {"paused" if state.paused else "live"}  mode={state.mode}  '
        f'tabs={len(state.tabs)}  focus={focus_label(state)}  '
        f'interval={state.min_interval_ms}-{state.max_interval_ms}ms  '
        f'color-speed={state.color_speed:0.2f}x',
    )

    last_color = state.last_frame_color or (0, 0, 0)
    r, g, b = last_color
    add_text(
        stdscr,
        4,
        0,
        f'Last frame: tab={state.last_frame_tab_id or "—"}  color={color_to_hex(state.last_frame_color)}  '
        f'R[{channel_bar(r)}] G[{channel_bar(g)}] B[{channel_bar(b)}]',
    )

    add_text(
        stdscr,
        5,
        0,
        f'GNOME config: selectedTab={state.selected_tab or "—"}  '
        f'frames={state.sent_frames}  statuses={state.sent_statuses}  '
        f'last interval={state.last_interval_ms:0.0f}ms',
    )

    add_text(stdscr, 7, 0, 'Tabs', curses.A_BOLD)
    add_text(stdscr, 8, 0, 'Idx  TabId  Flags       Frames  Next(ms)  Color      Title')
    add_text(stdscr, 9, 0, '─' * max(0, width - 1))

    row = 10
    max_tab_rows = max(0, height - 22)
    visible_tabs = state.tabs[:max_tab_rows] if max_tab_rows else []
    for index, tab in enumerate(visible_tabs):
        flags = []
        if tab.active:
            flags.append('FG')
        if selected_tab_matches(tab, state.selected_tab):
            flags.append('SEL')
        flag_text = ','.join(flags) if flags else '—'
        next_ms = max(0, int((tab.next_due_at - now) * 1000))
        line = (
            f'{index + 1:>3}  {tab.tab_id:>5}  {flag_text:<10}  {tab.frames_sent:>6}  '
            f'{next_ms:>8}  {color_to_hex(tab.color):<9}  {tab.title}'
        )
        add_text(stdscr, row, 0, line)
        row += 1

    if len(state.tabs) > len(visible_tabs):
        add_text(stdscr, row, 0, f'… {len(state.tabs) - len(visible_tabs)} more tab(s) hidden because the terminal is too small')
        row += 1

    log_header_row = min(height - 10, row + 1)
    add_text(stdscr, log_header_row, 0, 'Recent Events', curses.A_BOLD)
    add_text(stdscr, log_header_row + 1, 0, '─' * max(0, width - 1))
    for offset, entry in enumerate(list(state.logs)[:max(0, height - log_header_row - 5)]):
        add_text(stdscr, log_header_row + 2 + offset, 0, entry)

    footer_row = max(log_header_row + 3, height - 3)
    add_text(stdscr, footer_row, 0, 'Controls: +/- tabs  ←/→ focus  0 none  1..9 direct focus  m mode  [ ] timing  , . color speed  b burst  s status  Space pause  q quit')
    add_text(stdscr, footer_row + 1, 0, 'Frames are sent independently per tab with random timing jitter, so background-tab selection can be tested properly.')

    stdscr.refresh()


def handle_input(stdscr, state: AppState) -> None:
    while True:
        key = stdscr.getch()
        if key == -1:
            return

        if key in (ord('q'), ord('Q')):
            state.should_exit = True
            return

        if key == ord(' '):
            state.paused = not state.paused
            add_log(state, f'Streaming {"paused" if state.paused else "resumed"}')
            continue

        if key in (ord('+'), ord('=')):
            ensure_tab_count(state, len(state.tabs) + 1)
            add_log(state, f'Tab count -> {len(state.tabs)}')
            continue

        if key in (ord('-'), ord('_')):
            ensure_tab_count(state, len(state.tabs) - 1)
            add_log(state, f'Tab count -> {len(state.tabs)}')
            continue

        if key in (curses.KEY_LEFT, ord('h'), ord('H')):
            move_focus(state, -1)
            continue

        if key in (curses.KEY_RIGHT, ord('l'), ord('L')):
            move_focus(state, 1)
            continue

        if key == ord('0'):
            set_active_index(state, -1)
            add_log(state, 'Focused tab -> none')
            continue

        if ord('1') <= key <= ord('9'):
            index = key - ord('1')
            if index < len(state.tabs):
                set_active_index(state, index)
                add_log(state, f'Focused tab -> {focus_label(state)}')
            continue

        if key in (ord('r'), ord('R')):
            set_active_index(state, random.randint(-1, len(state.tabs) - 1))
            add_log(state, f'Focused tab -> {focus_label(state)}')
            continue

        if key in (ord('m'), ord('M')):
            cycle_mode(state)
            continue

        if key == ord('['):
            adjust_speed(state, 0.8)
            continue

        if key == ord(']'):
            adjust_speed(state, 1.25)
            continue

        if key == ord(','):
            adjust_color_speed(state, 0.8)
            continue

        if key == ord('.'):
            adjust_color_speed(state, 1.25)
            continue

        if key in (ord('b'), ord('B')):
            burst_colors(state)
            continue

        if key in (ord('s'), ord('S')):
            state.status_dirty = True
            add_log(state, 'Requested immediate status resend')
            continue


async def tui_loop(stdscr, state: AppState) -> None:
    stdscr.nodelay(True)
    stdscr.keypad(True)
    with contextlib.suppress(curses.error):
        curses.curs_set(0)

    while not state.should_exit:
        handle_input(stdscr, state)
        render(stdscr, state)
        await asyncio.sleep(0.05)


async def run_tui(stdscr, args) -> None:
    state = AppState(
        port=args.port,
        mode=args.mode,
        min_interval_ms=args.min_interval_ms,
        max_interval_ms=args.max_interval_ms,
        color_speed=args.color_speed,
        active_index=args.active_tab,
    )

    ensure_tab_count(state, args.tabs)
    if args.active_tab >= args.tabs:
        set_active_index(state, args.tabs - 1)

    add_log(state, 'Interactive bridge client ready')
    add_log(state, f'Initial mode={state.mode}, tabs={len(state.tabs)}, focus={focus_label(state)}, color-speed={state.color_speed:0.2f}x')

    bridge_task = asyncio.create_task(bridge_loop(state))
    try:
        await tui_loop(stdscr, state)
    finally:
        state.should_exit = True
        bridge_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await bridge_task


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='HAControlPanel Browser Bridge interactive test client',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  python3 tools/bridge-test-client.py
  python3 tools/bridge-test-client.py --tabs 4 --active-tab 2
  python3 tools/bridge-test-client.py --mode sunset --color-speed 0.4 --min-interval-ms 120 --max-interval-ms 700
""",
    )
    parser.add_argument('--port', type=int, default=7842,
                        help='WebSocket port (default: 7842)')
    parser.add_argument('--mode', choices=COLOR_MODES, default='chaos',
                        help='Initial color mode (default: chaos)')
    parser.add_argument('--tabs', type=int, default=3, metavar='N',
                        help=f'Initial number of simulated YouTube tabs (default: 3, max: {MAX_TABS})')
    parser.add_argument('--active-tab', type=int, default=0, metavar='INDEX',
                        help='Initial foreground tab; -1 = none active (default: 0)')
    parser.add_argument('--fps', type=float, default=None,
                        help='Legacy convenience option: derive the initial random interval range from a target fps')
    parser.add_argument('--min-interval-ms', type=int, default=None,
                        help='Initial minimum delay between frames per tab in ms')
    parser.add_argument('--max-interval-ms', type=int, default=None,
                        help='Initial maximum delay between frames per tab in ms')
    parser.add_argument('--color-speed', type=float, default=0.60,
                        help='Initial color transition speed multiplier (default: 0.60)')
    args = parser.parse_args()

    args.tabs = clamp(args.tabs, 1, MAX_TABS)
    if args.active_tab >= args.tabs:
        parser.error(f'--active-tab {args.active_tab} is out of range for --tabs {args.tabs}')
    if args.active_tab < -1:
        parser.error('--active-tab must be -1 or a valid 0-based tab index')

    if args.fps is not None:
        if args.fps <= 0:
            parser.error('--fps must be greater than 0')
        base_ms = 1000.0 / args.fps
        if args.min_interval_ms is None:
            args.min_interval_ms = int(max(MIN_INTERVAL_FLOOR_MS, round(base_ms * 0.55)))
        if args.max_interval_ms is None:
            args.max_interval_ms = int(max(args.min_interval_ms + 40, round(base_ms * 1.75)))

    if args.min_interval_ms is None:
        args.min_interval_ms = 80
    if args.max_interval_ms is None:
        args.max_interval_ms = 420

    args.min_interval_ms = clamp(args.min_interval_ms, MIN_INTERVAL_FLOOR_MS, MAX_INTERVAL_CEIL_MS)
    args.max_interval_ms = clamp(args.max_interval_ms, MIN_INTERVAL_FLOOR_MS, MAX_INTERVAL_CEIL_MS)
    if args.max_interval_ms <= args.min_interval_ms:
        parser.error('--max-interval-ms must be greater than --min-interval-ms')
    if not (MIN_COLOR_SPEED <= args.color_speed <= MAX_COLOR_SPEED):
        parser.error(f'--color-speed must be between {MIN_COLOR_SPEED:.2f} and {MAX_COLOR_SPEED:.2f}')

    return args


def main() -> None:
    args = parse_args()

    if not sys.stdout.isatty():
        print('This tool now runs as an interactive terminal UI. Start it from a real terminal.', file=sys.stderr)
        sys.exit(1)

    def wrapped(stdscr):
        return asyncio.run(run_tui(stdscr, args))

    curses.wrapper(wrapped)


if __name__ == '__main__':
    main()
