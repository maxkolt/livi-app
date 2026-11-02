#!/usr/bin/env python3
"""Cold-start notification destinations via synthetic intents; no server writes.

python3 frontend/e2e/notification-navigation.py --device emulator-5554 --output /tmp/livi-notification-nav
Real FCM delivery and unread/call counts are separate acceptance scenarios.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
pkg = 'com.kolt12max.livi.dev'


def adb(*command, check=True):
    return subprocess.run(['adb', '-s', args.device, 'shell', shlex.join(command)],
                          text=True, capture_output=True, timeout=30, check=check)


def inspect_page(expected, require_selected):
    remote = '/sdcard/livi-notification-navigation.xml'
    adb('rm', '-f', remote)
    dumped = adb('uiautomator', 'dump', '--compressed', remote)
    if 'UI hierchary dumped to:' not in dumped.stdout:
        raise ET.ParseError('UIAutomator did not produce a fresh hierarchy')
    xml = adb('cat', remote).stdout.strip()
    root = ET.fromstring(xml)

    def matches(node, ancestor_selected=False):
        selected = ancestor_selected or node.get('selected') == 'true'
        label = node.get('text') or node.get('content-desc') or ''
        if re.fullmatch(expected, label) and (selected or not require_selected):
            return True
        return any(matches(child, selected) for child in node)

    return matches(root), xml


cases = [
    ('unread', 'com.kolt12max.livi.OPEN_UNREAD_CHAT', None, 'Unread|Непрочитанные'),
    ('missed', 'com.kolt12max.livi.OPEN_MISSED_CALLS', None, 'Missed|Пропущенные'),
    ('requests', 'android.intent.action.VIEW', 'friend_request', 'Friend requests|Заявки в друзья'),
    ('updates', 'android.intent.action.VIEW', 'app_update', 'Version|Версия'),
]
results = []
for destination, action, kind, expected in cases:
    adb('input', 'keyevent', 'KEYCODE_HOME')
    adb('am', 'force-stop', pkg)
    assert not adb('pidof', pkg, check=False).stdout.strip(), 'app process still alive'
    token = f'livi-nav-{destination}-{time.time_ns()}'
    command = ['am', 'start', '-W', '-n', f'{pkg}/com.kolt12max.livi.MainActivity', '-a', action,
               '--es', 'google.message_id', token]
    if kind:
        command += ['--es', 'body', json.dumps({'type': kind})]
    started = time.monotonic()
    opened = adb(*command)
    assert 'Status: ok' in opened.stdout, opened.stdout + opened.stderr
    (args.output / f'{destination}-launch.txt').write_text(opened.stdout + opened.stderr)
    require_selected = destination in ('unread', 'missed')
    passed, xml = False, ''
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            passed, xml = inspect_page(expected, require_selected)
        except (subprocess.SubprocessError, ET.ParseError):
            passed = False
        if passed:
            break
        time.sleep(.2)
    (args.output / f'{destination}-hierarchy.xml').write_text(xml)
    shot = subprocess.run(['adb', '-s', args.device, 'exec-out', 'screencap', '-p'],
                          capture_output=True, check=True, timeout=20)
    (args.output / f'{destination}.png').write_bytes(shot.stdout)
    row = dict(destination=destination, passed=passed,
               selected_filter=True if passed and require_selected else None,
               scenario_seconds=round(time.monotonic() - started, 2))
    results.append(row)
    print(json.dumps(row), flush=True)
    (args.output / 'results.json').write_text(json.dumps(results, indent=2))
    if not passed:
        raise SystemExit(f'Failed {destination}: {args.output / (destination + "-hierarchy.xml")}')
