#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(LiviCrypto, NSObject)

RCT_EXTERN_METHOD(pbkdf2Sha256:(NSString *)passwordB64
                  saltB64:(NSString *)saltB64
                  iterations:(nonnull NSNumber *)iterations
                  keyLength:(nonnull NSNumber *)keyLength
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
