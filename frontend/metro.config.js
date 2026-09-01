const { getDefaultConfig } = require("expo/metro-config");
const { resolve: metroResolve } = require("metro-resolver");

const config = getDefaultConfig(__dirname);

config.resolver = config.resolver || {};
const previousResolveRequest = config.resolver.resolveRequest;

// @livekit/* импортирует `event-target-shim/index`; в v6 экспортируется только `.`.
// Перенаправляем на публичный спецификатор — резолв идёт через package.json "exports".
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // LiveKit pulls well-known-symbols; that graph is unstable under Fast Refresh (unknown module id).
  // Real Symbol.asyncIterator / Symbol.iterator are applied in ensureCoreJsPolyfills.ts.
  if (
    moduleName === "well-known-symbols/Symbol.asyncIterator/auto" ||
    moduleName === "well-known-symbols/Symbol.iterator/auto" ||
    moduleName === "well-known-symbols/Symbol.asyncIterator/shim" ||
    moduleName === "well-known-symbols/Symbol.iterator/shim" ||
    moduleName.startsWith("well-known-symbols/")
  ) {
    return {
      type: "sourceFile",
      filePath: require("path").resolve(__dirname, "polyfills/wellKnownSymbolsStub.js"),
    };
  }
  if (moduleName === "event-target-shim/index") {
    return metroResolve(
      { ...context, resolveRequest: metroResolve },
      "event-target-shim",
      platform,
    );
  }
  // react-native-paper probes this optional package before its Expo fallback.
  // Metro assigns a missing module id to that probe, which can surface as
  // `Requiring unknown module "NNNN"` before Paper's try/catch handles it.
  if (moduleName === "@react-native-vector-icons/material-design-icons") {
    return metroResolve(
      { ...context, resolveRequest: metroResolve },
      "@expo/vector-icons/MaterialCommunityIcons",
      platform,
    );
  }
  // CometChat probes its optional calling SDK at runtime. LiVi calls use
  // LiveKit, so resolve both probes to an explicitly unavailable module.
  if (
    moduleName === "@cometchat/calls-sdk-react-native" ||
    moduleName === "@cometchat/calls-sdk-react-native/package.json"
  ) {
    return {
      type: "sourceFile",
      filePath: require("path").resolve(__dirname, "polyfills/optionalModuleStub.js"),
    };
  }
  if (previousResolveRequest) {
    return previousResolveRequest(context, moduleName, platform);
  }
  return metroResolve(context, moduleName, platform);
};

module.exports = config;
