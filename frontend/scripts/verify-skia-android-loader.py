#!/usr/bin/env python3
"""Run the installed Java loader against instrumented streams/connections (JDK 17)."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
stubs = {
    'android/os/Looper.java': 'package android.os; public class Looper { public static Looper getMainLooper() { return null; } }',
    'android/os/Handler.java': 'package android.os; public class Handler { public Handler(Looper l) {} public void post(Runnable r) {} }',
    'android/content/res/Resources.java': '''package android.content.res;
public class Resources {
  public java.io.InputStream stream;
  public int getIdentifier(String s, String type, String p) { return s.equals("raw") ? 1 : 0; }
  public java.io.InputStream openRawResource(int id) { return stream; }
  public static class Metrics { public float density = 1; }
  public Metrics getDisplayMetrics() { return new Metrics(); }
}''',
    'com/facebook/jni/HybridData.java': 'package com.facebook.jni; public class HybridData { public void resetNative() {} }',
    'com/facebook/proguard/annotations/DoNotStrip.java': 'package com.facebook.proguard.annotations; public @interface DoNotStrip {}',
    'com/facebook/react/bridge/ReactContext.java': '''package com.facebook.react.bridge;
public class ReactContext {
  public final android.content.res.Resources resources = new android.content.res.Resources();
  public android.content.res.Resources getResources() { return resources; }
  public String getPackageName() { return "test"; }
  public void handleException(Exception e) {}
}''',
    'com/shopify/reactnative/skia/RNSkVideo.java': 'package com.shopify.reactnative.skia; public class RNSkVideo { public RNSkVideo(Object c, String u) {} }',
    'com/shopify/reactnative/skia/ViewScreenshotService.java': 'package com.shopify.reactnative.skia; public class ViewScreenshotService { public static Object makeViewScreenshotFromTag(Object c, int t) { return null; } }',
}
with tempfile.TemporaryDirectory(prefix='livi-skia-loader-') as directory:
    temporary = Path(directory)
    sources = []
    for name, source in stubs.items():
        path = temporary / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        sources.append(str(path))
    sources += [str(root / 'node_modules/@shopify/react-native-skia/android/src/main/java/com/shopify/reactnative/skia/PlatformContext.java'),
                str(root / 'scripts/tests/SkiaAndroidLoaderTest.java')]
    subprocess.run(['javac', '-d', str(temporary), *sources], check=True)
    subprocess.run(['java', '-ea', '-cp', str(temporary), 'SkiaAndroidLoaderTest'], check=True)
