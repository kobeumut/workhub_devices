module.exports = {
  preset: '@react-native/jest-preset',
  // Shared package hooks must use the same React as the native renderer (as in Metro).
  moduleNameMapper: { '^react$': require.resolve('react') },
};
