/**
 * Inline polyfills used by LiveKit / sdp-transform.
 * Avoids dynamic require('array.prototype.at') / promise.allsettled in release Hermes
 * (Play crash: Requiring unknown module "3236").
 */
export function ensureCoreJsPolyfills(): void {
  if (typeof Promise.allSettled !== 'function') {
    Promise.allSettled = function allSettled<T>(
      values: Iterable<T | PromiseLike<T>>,
    ): Promise<PromiseSettledResult<Awaited<T>>[]> {
      return Promise.all(
        Array.from(values, (p) =>
          Promise.resolve(p).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason }),
          ),
        ),
      );
    };
  }

  if (typeof Array.prototype.at !== 'function') {
    // eslint-disable-next-line no-extend-native
    Array.prototype.at = function at(index: number) {
      const len = this.length;
      const relativeIndex = index >= 0 ? index : len + index;
      if (relativeIndex < 0 || relativeIndex >= len) {
        return undefined;
      }
      return this[relativeIndex];
    };
  }
}

ensureCoreJsPolyfills();
