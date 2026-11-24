#!/usr/bin/env python3
"""Read-only dev acceptance capture. Never clears logcat, resets stats or changes apps."""
import argparse
import concurrent.futures
import datetime
import json
import pathlib
import re
import signal
import subprocess
import threading
import time


def adb(serial, *args):
    return subprocess.run(['adb', '-s', serial, *args], capture_output=True, timeout=25)


def capture(serial, package, destination, duration, interval, stop):
    folder = destination / serial
    folder.mkdir(parents=True, exist_ok=True)
    info = adb(serial, 'shell', 'dumpsys', 'package', package)
    (folder / 'package.txt').write_bytes(info.stdout + info.stderr)
    uid = re.search(rb'(?:userId|appId)=(\d+)', info.stdout)
    if not uid:
        raise RuntimeError(f'{serial}: package UID unavailable')
    process = subprocess.Popen(
        ['adb', '-s', serial, 'logcat', '-b', 'all', '--uid=' + uid[1].decode(), '-v', 'threadtime', '-T', '1'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    errors = []

    def logs():
        path = folder / 'logcat.txt'
        try:
            with path.open('ab') as output:
                while line := process.stdout.readline():
                    output.write(line)
                    if output.tell() >= 8 * 1024 * 1024:
                        output.flush()
                        # Four bounded rotations, preserving the most recent session.
                        for index in range(3, 0, -1):
                            old = folder / f'logcat.{index}.txt'
                            if old.exists():
                                old.replace(folder / f'logcat.{index + 1}.txt')
                        # Rename the open inode; subsequent reads go into a fresh file.
                        path.replace(folder / 'logcat.1.txt')
                        output.close()
                        output = path.open('ab')
        except (OSError, ValueError) as error:
            errors.append(str(error))
        finally:
            try:
                output.close()
            except (UnboundLocalError, OSError):
                pass

    reader = threading.Thread(target=logs, daemon=True)
    reader.start()
    deadline = time.monotonic() + duration
    sample = 0
    try:
        with (folder / 'samples.jsonl').open('a') as summary:
            while time.monotonic() < deadline and not stop.is_set():
                timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
                try:
                    memory = adb(serial, 'shell', 'dumpsys', 'meminfo', package)
                    text = memory.stdout.decode(errors='replace')
                    record = {'at': timestamp, 'sample': sample}
                    for name, pattern in {
                        'pid': r'MEMINFO in pid (\d+)', 'pssKiB': r'TOTAL PSS:\s+(\d+)',
                        'rssKiB': r'TOTAL RSS:\s+(\d+)', 'graphicsKiB': r'Graphics:\s+(\d+)',
                        'nativeKiB': r'Native Heap:\s+(\d+)', 'javaKiB': r'Java Heap:\s+(\d+)',
                        'views': r'Views:\s+(\d+)', 'webViews': r'WebViews:\s+(\d+)',
                    }.items():
                        match = re.search(pattern, text)
                        if match:
                            record[name] = int(match[1])
                    summary.write(json.dumps(record) + '\n')
                    summary.flush()
                    if sample % 3 == 0:
                        # Retain a bounded window of 20 detailed snapshots.
                        slot = (sample // 3) % 20
                        (folder / f'meminfo-{slot:02}.txt').write_text(timestamp + '\n' + text)
                        for name, args in {
                            'gfxinfo': ['shell', 'dumpsys', 'gfxinfo', package],
                            'services': ['shell', 'dumpsys', 'activity', 'services', package],
                            'exits': ['shell', 'dumpsys', 'activity', 'exit-info', package],
                        }.items():
                            result = adb(serial, *args)
                            (folder / f'{name}-{slot:02}.txt').write_bytes(timestamp.encode() + b'\n' + result.stdout + result.stderr)
                except (subprocess.SubprocessError, OSError) as error:
                    summary.write(json.dumps({'at': timestamp, 'error': str(error)}) + '\n')
                    summary.flush()
                sample += 1
                stop.wait(min(interval, max(0, deadline - time.monotonic())))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        reader.join(timeout=5)
        (folder / 'capture-result.json').write_text(json.dumps({'samples': sample, 'logErrors': errors}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--devices', nargs='+', required=True)
    parser.add_argument('--package', default='com.kolt12max.livi.dev')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--duration', type=int, default=7200)
    parser.add_argument('--interval', type=int, default=20)
    options = parser.parse_args()
    options.output.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(options.devices)) as executor:
        futures = [executor.submit(capture, serial, options.package, options.output, options.duration, options.interval, stop) for serial in options.devices]
        for future in futures:
            future.result()
