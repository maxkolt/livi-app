import Expo
import PushKit
import React
import ReactAppDependencyProvider
import UIKit
import CryptoKit

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate, PKPushRegistryDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?
  private var voipRegistry: PKPushRegistry?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    configureCallKeep()
    configureVoipPushRegistry()

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    // Не следовать системному Dynamic Type для нативных UILabel/TextField (JS уже ставит allowFontScaling: false на Text).
    if #available(iOS 10.0, *) {
      UILabel.appearance().adjustsFontForContentSizeCategory = false
      UITextField.appearance().adjustsFontForContentSizeCategory = false
      UITextView.appearance().adjustsFontForContentSizeCategory = false
    }
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  private func configureCallKeep() {
    RNCallKeep.setup([
      "appName": "LiVi",
      "handleType": "generic",
      "supportsVideo": true,
      "includesCallsInRecents": false,
      "maximumCallGroups": 1,
      "maximumCallsPerCallGroup": 1,
    ])
  }

  private func configureVoipPushRegistry() {
    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    voipRegistry = registry
  }

  private func hexToken(from credentials: PKPushCredentials) -> String {
    credentials.token.map { String(format: "%02x", $0) }.joined()
  }

  private func stringValue(_ value: Any?) -> String? {
    if let string = value as? String, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return string.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if let number = value as? NSNumber {
      return number.stringValue
    }
    return nil
  }

  private func toMs(_ value: Any?) -> Int64? {
    guard let raw = stringValue(value) else { return nil }
    return Int64(raw)
  }

  private func callKitId(from payload: [AnyHashable: Any]) -> String {
    if let existing = stringValue(payload["callKitId"]) {
      return existing.lowercased()
    }
    if let callId = stringValue(payload["callId"]) {
      let hex = Insecure.SHA1.hash(data: Data(callId.utf8)).map { String(format: "%02x", $0) }.joined()
      let value = "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-5\(hex.dropFirst(13).prefix(3))-a\(hex.dropFirst(17).prefix(3))-\(hex.dropFirst(20).prefix(12))"
      return value.lowercased()
    }
    return UUID().uuidString.lowercased()
  }

  private func isIncomingCallExpired(_ payload: [AnyHashable: Any]) -> Bool {
    let createdAtMs = toMs(payload["ts"])
    let expiresAtMs = toMs(payload["expiresAt"]) ?? createdAtMs.map { $0 + 20_000 }
    guard let expiresAtMs else { return false }
    return Int64(Date().timeIntervalSince1970 * 1000) > expiresAtMs + 2_000
  }

  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    LiviVoipPushManager.setVoipToken(hexToken(from: pushCredentials))
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    LiviVoipPushManager.setVoipToken("")
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    withCompletionHandler completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }

    let data = payload.dictionaryPayload
    let eventType = stringValue(data["type"])?.lowercased() ?? ""
    let callId = stringValue(data["callId"]) ?? ""
    let callKitId = callKitId(from: data)

    if eventType == "call" {
      if isIncomingCallExpired(data) {
        completion()
        return
      }
      let from = stringValue(data["from"]) ?? stringValue(data["fromUserId"]) ?? "unknown"
      let fromNick = stringValue(data["fromNick"]) ?? ""
      RNCallKeep.reportNewIncomingCall(
        callKitId,
        handle: from,
        handleType: "generic",
        hasVideo: true,
        localizedCallerName: fromNick,
        supportsHolding: false,
        supportsDTMF: false,
        supportsGrouping: false,
        supportsUngrouping: false,
        fromPushKit: true,
        payload: [
          "type": "call",
          "callId": callId,
          "callKitId": callKitId,
          "from": from,
          "fromNick": fromNick,
          "ts": stringValue(data["ts"]) ?? "",
          "expiresAt": stringValue(data["expiresAt"]) ?? "",
        ],
        withCompletionHandler: completion
      )
      return
    }

    if eventType == "call_canceled" || eventType == "call_ended" {
      RNCallKeep.endCall(withUUID: callKitId, reason: 2)
      completion()
      return
    }

    completion()
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
