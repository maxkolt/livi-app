const { getDefaultConfig } = require("expo/metro-config");
const { resolve: metroResolve } = require("metro-resolver");

const config = getDefaultConfig(__dirname);

config.resolver = config.resolver || {};
const previousResolveRequest = config.resolver.resolveRequest;

// @livekit/* импортирует `event-target-shim/index`; в v6 экспортируется только `.`.
// Перенаправляем на публичный спецификатор — резолв идёт через package.json "exports".
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "event-target-shim/index") {
    return metroResolve(
      { ...context, resolveRequest: metroResolve },
      "event-target-shim",
      platform,
    );
  }
  if (previousResolveRequest) {
    return previousResolveRequest(context, moduleName, platform);
  }
  return metroResolve(context, moduleName, platform);
};

module.exports = config;
