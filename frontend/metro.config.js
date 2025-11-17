const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver = config.resolver || {};
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "event-target-shim/index": path.join(
    __dirname,
    "node_modules/event-target-shim/dist/event-target-shim.js"
  ),
};

module.exports = config;