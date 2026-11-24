#!/usr/bin/env python3
"""Exercise the installed Skia patch with a real JSI runtime and ASan/UBSan (macOS)."""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
react = root / 'node_modules/react-native/ReactCommon'
skia = root / 'node_modules/@shopify/react-native-skia/cpp'
with tempfile.TemporaryDirectory(prefix='livi-skia-promises-') as temporary:
    executable = pathlib.Path(temporary) / 'lifecycle'
    subprocess.run([
        'xcrun', 'clang++', '-std=c++17', '-g', '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer', '-Wno-deprecated-declarations',
        '-I' + str(react), '-I' + str(react / 'jsi'), '-I' + str(skia / 'jsi'),
        str(react / 'jsi/jsi/jsi.cpp'), str(react / 'jsi/jsi/jsilib-posix.cpp'),
        str(react / 'jsc/JSCRuntime.cpp'), str(skia / 'jsi/JsiPromises.cpp'),
        str(root / 'scripts/tests/skia-promises-lifecycle.cpp'),
        '-framework', 'JavaScriptCore', '-o', str(executable),
    ], check=True)
    subprocess.run([str(executable)], check=True)
