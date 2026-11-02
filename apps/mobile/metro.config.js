const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const root = path.resolve(__dirname, '../..');

/**
 * Shared packages live in ../../packages and are linked via file: dependencies. All modules
 * (react, react-native, …) resolve ONLY from this app's node_modules to avoid duplicate React.
 */
const config = {
  watchFolders: [path.join(root, 'packages'), path.join(root, 'config')],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    disableHierarchicalLookup: true,
    unstable_enableSymlinks: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
