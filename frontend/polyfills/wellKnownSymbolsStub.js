// Stub for well-known-symbols/* — polyfills live in ensureCoreJsPolyfills.ts.
// Avoids Metro/Hermes "Requiring unknown module NNN" from that package graph.
module.exports = function noopShim() {
  return undefined;
};
