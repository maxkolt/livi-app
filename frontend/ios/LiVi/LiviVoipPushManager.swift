import Foundation

@objc(LiviVoipPushManager)
final class LiviVoipPushManager: RCTEventEmitter {
  private static var currentVoipToken: String?
  private static weak var sharedEmitter: LiviVoipPushManager?
  private var hasActiveListeners = false
  private var lastEmittedToken: String?

  override init() {
    super.init()
    LiviVoipPushManager.sharedEmitter = self
  }

  override class func requiresMainQueueSetup() -> Bool {
    true
  }

  override func supportedEvents() -> [String]! {
    ["voipTokenUpdated"]
  }

  override func startObserving() {
    hasActiveListeners = true
    emitVoipTokenIfNeeded()
  }

  override func stopObserving() {
    hasActiveListeners = false
  }

  @objc(getVoipPushToken:rejecter:)
  func getVoipPushToken(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(LiviVoipPushManager.currentVoipToken)
  }

  static func setVoipToken(_ token: String) {
    DispatchQueue.main.async {
      currentVoipToken = token
      sharedEmitter?.emitVoipTokenIfNeeded()
    }
  }

  private func emitVoipTokenIfNeeded() {
    guard hasActiveListeners else { return }
    guard let token = LiviVoipPushManager.currentVoipToken, !token.isEmpty else { return }
    guard lastEmittedToken != token else { return }
    lastEmittedToken = token
    sendEvent(withName: "voipTokenUpdated", body: ["token": token])
  }
}
