import Foundation
import CommonCrypto

/// Вывод ключа из пароля для резервной копии ключа сквозного шифрования
/// (frontend/sockets/modules/e2eCrypto.ts). На JS в Hermes (без JIT) это десятки
/// секунд с заблокированным JS-потоком, поэтому считаем нативно в фоне.
/// PBKDF2-HMAC-SHA256 над сырыми байтами пароля — результат совпадает с Android и JS.
@objc(LiviCrypto)
final class LiviCrypto: NSObject {
  private let queue = DispatchQueue(label: "com.kolt12max.livi.crypto", qos: .userInitiated)

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(pbkdf2Sha256:saltB64:iterations:keyLength:resolver:rejecter:)
  func pbkdf2Sha256(
    _ passwordB64: String,
    saltB64: String,
    iterations: NSNumber,
    keyLength: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let rounds = iterations.intValue
    let length = keyLength.intValue
    guard rounds >= 1, rounds <= 10_000_000, length >= 1, length <= 64,
          let password = Data(base64Encoded: passwordB64),
          let salt = Data(base64Encoded: saltB64) else {
      reject("E_ARGS", "bad pbkdf2 arguments", nil)
      return
    }
    queue.async {
      var derived = Data(count: length)
      let status = derived.withUnsafeMutableBytes { derivedPtr -> Int32 in
        password.withUnsafeBytes { passwordPtr in
          salt.withUnsafeBytes { saltPtr in
            CCKeyDerivationPBKDF(
              CCPBKDFAlgorithm(kCCPBKDF2),
              passwordPtr.baseAddress?.assumingMemoryBound(to: Int8.self),
              password.count,
              saltPtr.baseAddress?.assumingMemoryBound(to: UInt8.self),
              salt.count,
              CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
              UInt32(rounds),
              derivedPtr.baseAddress?.assumingMemoryBound(to: UInt8.self),
              length
            )
          }
        }
      }
      if status == kCCSuccess {
        resolve(derived.base64EncodedString())
      } else {
        reject("E_PBKDF2", "CCKeyDerivationPBKDF failed: \(status)", nil)
      }
      derived.resetBytes(in: 0..<derived.count)
    }
  }
}
