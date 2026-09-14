# Add project specific ProGuard rules here.
# Appended to proguard-android-optimize.txt via build.gradle.
#
# Goal: enable R8 for Google Play obfuscation score without breaking
# RN bridge, FCM, CallKeep, LiveKit/WebRTC, or AppMetrica.

# ---- Annotations / attributes (reflection, Crashlytics stacks) ----
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes EnclosingMethod
-keepattributes InnerClasses
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ---- React Native bridge ----
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep,allowobfuscation @interface com.facebook.proguard.annotations.KeepGettersAndSetters
-keep,allowobfuscation @interface com.facebook.react.common.annotations.KeepGettersAndSetters

-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
}

-keepclassmembers @com.facebook.proguard.annotations.KeepGettersAndSetters class * {
  void set*(***);
  *** get*();
}

-keep class * extends com.facebook.react.bridge.JavaScriptModule { *; }
-keep class * extends com.facebook.react.bridge.NativeModule { *; }
-keepclassmembers,includedescriptorclasses class * { native <methods>; }
-keepclassmembers class * {
  @com.facebook.react.uimanager.annotations.ReactProp <methods>;
}
-keepclassmembers class * {
  @com.facebook.react.uimanager.annotations.ReactPropGroup <methods>;
}

-dontwarn com.facebook.react.**
-keep class com.facebook.hermes.unicode.** { *; }
-keep class com.facebook.jni.** { *; }

# react-native-reanimated / turbomodules
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Expo modules (autolinking / reflection)
-keep class expo.modules.** { *; }
-dontwarn expo.modules.**

# ---- LiVi native (FCM, call UI, services; some invoked by name / headless) ----
-keep class com.kolt12max.livi.** { *; }

# ---- CallKeep (Telecom ConnectionService + FCM headless) ----
-keep class io.wazo.callkeep.** { *; }
-dontwarn io.wazo.callkeep.**

# ---- LiveKit / WebRTC (JNI + native factories) ----
-keep class org.webrtc.** { *; }
-keep class com.oney.WebRTCModule.** { *; }
-keep class com.livekit.** { *; }
-keep class io.livekit.** { *; }
-dontwarn org.webrtc.**
-dontwarn com.oney.WebRTCModule.**
-dontwarn com.livekit.**
-dontwarn io.livekit.**

# ---- Firebase (FCM / Analytics / Crashlytics) ----
-keep class com.google.firebase.** { *; }
-dontwarn com.google.firebase.**

# ---- AppMetrica ----
-keep class io.appmetrica.** { *; }
-dontwarn io.appmetrica.**

# ---- Misc native deps used from LiviAppModule ----
-keep class me.leolin.shortcutbadger.** { *; }
-dontwarn me.leolin.shortcutbadger.**
-keep class com.android.installreferrer.** { *; }
-dontwarn com.android.installreferrer.**

# OkHttp / okio (common R8 warnings; safe to ignore missing optional classes)
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.**

