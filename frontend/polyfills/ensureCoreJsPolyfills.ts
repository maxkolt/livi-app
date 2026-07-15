/**
 * Inline polyfills used by LiveKit / sdp-transform.
 * Avoids dynamic require('array.prototype.at') / promise.allsettled / well-known-symbols
 * in Hermes (Play crash / Metro: Requiring unknown module "NNNN").
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

  // LiveKit used to `import 'well-known-symbols/Symbol.*.auto'` — that package
  // is a frequent source of Metro "unknown module NNN" after Fast Refresh.
  try {
    const Sym = globalThis.Symbol as SymbolConstructor & {
      asyncIterator?: symbol;
      iterator?: symbol;
    };
    if (typeof Sym === 'function') {
      if (!Sym.asyncIterator) {
        (Sym as { asyncIterator: symbol }).asyncIterator = Sym.for('Symbol.asyncIterator');
      }
      if (!Sym.iterator) {
        (Sym as { iterator: symbol }).iterator = Sym.for('Symbol.iterator');
      }
    }
  } catch {
    // ignore
  }
}

ensureCoreJsPolyfills();
