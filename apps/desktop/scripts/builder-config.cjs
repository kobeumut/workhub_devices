// Maps config/app-identity.json to an electron-builder configuration (pure; unit-tested in
// test/builder-config.test.mjs). Identity and version are never written anywhere else.
function builderConfig(identity, electronVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(identity.version ?? '')) throw new Error('config/app-identity.json: version must be x.y.z');
  const d = identity.desktop ?? {};
  if (!d.appId || !d.executableName || !d.maintainer) throw new Error('config/app-identity.json: desktop.appId, executableName and maintainer are required');
  return {
    appId: d.appId,
    // The workspace pins Electron with a range; package exactly the installed binary.
    ...(electronVersion ? { electronVersion } : {}),
    productName: identity.displayName,
    executableName: d.executableName,
    copyright: `© ${identity.displayName}`,
    directories: { output: 'release', buildResources: 'build' },
    // main/preload are esbuild bundles and the renderer is a Vite build: nothing from node_modules
    // is needed at runtime, so it is never packaged (keeps the AppImage/deb small and auditable).
    files: ['dist/**/*', 'package.json', '!node_modules/**/*'],
    extraMetadata: {
      name: d.executableName,
      productName: identity.displayName,
      version: identity.version,
      author: d.maintainer,
      ...(d.homepage ? { homepage: d.homepage } : {}),
      main: 'dist/main.cjs',
    },
    asar: true,
    linux: {
      target: ['AppImage', 'deb'],
      category: d.linuxCategory ?? 'Network',
      maintainer: d.maintainer,
      synopsis: 'Workhub: Nextcloud Talk and Workhub',
      description: 'Nextcloud Talk conversations and Workhub work items in one desktop app.',
      executableName: d.executableName,
      artifactName: `${d.executableName}-\${version}-\${arch}.\${ext}`,
    },
    deb: {
      // Credentials are kept only in the OS secret store (libsecret / KWallet); without one,
      // sign-in is refused, so the secret service is a hard dependency on Debian/Ubuntu.
      depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'],
      recommends: ['gnome-keyring | kwalletmanager'],
      packageCategory: 'net',
    },
    // Windows/macOS: same identity; signing/notarisation stays in a protected pipeline (PLAN.md).
    win: { target: ['nsis'] },
    mac: { target: ['dmg'], category: 'public.app-category.productivity' },
    publish: null,
  };
}

module.exports = { builderConfig };
