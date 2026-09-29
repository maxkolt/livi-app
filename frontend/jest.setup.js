// Jest on Node 18 does not always expose Web Crypto as a global. E2E key generation
// deliberately refuses insecure randomness, so give tests Node's real Web Crypto.
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: require('node:crypto').webcrypto,
  });
}
