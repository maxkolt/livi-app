#!/usr/bin/env python3
"""Verify fresh/repeated postinstall and reject incompatible Skia without edits."""
from pathlib import Path
import hashlib
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
name = 'react-native-skia+2.2.4-promises.patch'
patch = root / 'patches' / name
installed = root / 'node_modules/@shopify/react-native-skia'
files = re.findall(r'^\+\+\+ b/(.+)$', patch.read_text(), re.MULTILINE)


def manifest(directory):
    return {file: hashlib.sha256((directory / file).read_bytes()).hexdigest() for file in files}


with tempfile.TemporaryDirectory(prefix='livi-skia-install-') as directory:
    temporary = Path(directory)
    (temporary / 'patches').mkdir()
    (temporary / 'scripts').mkdir()
    shutil.copy2(patch, temporary / 'patches' / name)
    shutil.copy2(root / 'scripts/apply-patches.js', temporary / 'scripts/apply-patches.js')
    # The production installer also requires the React Native retention fix.
    # Include its already-patched dependency so this isolated fixture reaches Skia.
    rn_patch = root / 'patches/react-native+0.79.6-animated-props-retention.patch'
    shutil.copy2(rn_patch, temporary / 'patches' / rn_patch.name)
    for file in re.findall(r'^\+\+\+ b/(.+)$', rn_patch.read_text(), re.MULTILINE):
        destination = temporary / 'node_modules/react-native' / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / 'node_modules/react-native' / file, destination)
    target = temporary / 'node_modules/@shopify/react-native-skia'
    for file in files:
        (target / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(installed / file, target / file)
    expected = manifest(target)
    subprocess.run(['patch', '-p1', '--batch', '--reverse', '-i', str(patch)], cwd=target,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    runner = ['node', str(temporary / 'scripts/apply-patches.js')]
    first = subprocess.run(runner, capture_output=True, text=True, check=True)
    assert 'applied ' + name in first.stdout
    assert manifest(target) == expected
    second = subprocess.run(runner, capture_output=True, text=True, check=True)
    assert 'verified ' + name in second.stdout
    assert manifest(target) == expected
    # Damage one hunk. Dry runs must fail before applying any other hunk.
    (target / 'cpp/jsi/JsiPromises.h').write_text('// incompatible dependency\n')
    damaged = manifest(target)
    failed = subprocess.run(runner, capture_output=True, text=True)
    assert failed.returncode != 0
    assert manifest(target) == damaged
    (temporary / 'patches' / name).unlink()
    missing = subprocess.run(runner, capture_output=True, text=True)
    assert missing.returncode != 0
    print('Skia postinstall: fresh/repeat install, incompatible dependency, missing patch and no partial edits PASS')
