const enhancedSeaTemporaryEntrypoint =
  /(?:\/[A-Za-z0-9._-]+)+\/pkg-sea-[A-Za-z0-9_-]+\/sea-main\.js/u;

export function standaloneNativeAssetPaths(architecture) {
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error(`Unsupported standalone native architecture "${architecture}".`);
  }
  return [
    `node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-${architecture}/darwin-modifiers.node`,
    `node_modules/@mariozechner/clipboard-darwin-${architecture}/clipboard.darwin-${architecture}.node`,
  ];
}

export function standaloneNativeRuntimeAssetPaths(architecture) {
  return [
    ...standaloneNativeAssetPaths(architecture),
    "node_modules/@mariozechner/clipboard/index.js",
    "node_modules/@mariozechner/clipboard/package.json",
    `node_modules/@mariozechner/clipboard-darwin-${architecture}/package.json`,
  ];
}

export function assertStandaloneNativeManifest(nativeAssets, architecture, manifestRoot) {
  const root = manifestRoot.replace(/\/+$/u, "");
  const expected = standaloneNativeAssetPaths(architecture)
    .map((path) => `${root}/${path}`)
    .toSorted();
  const actual = nativeAssets.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Packaged manifest does not contain exactly the host-native addons (${architecture}).`,
    );
  }
}

export function assertNoEnhancedSeaTemporaryEntrypoint(contents) {
  const match = Buffer.from(contents).toString("latin1").match(enhancedSeaTemporaryEntrypoint);
  if (match !== null) {
    throw new Error(
      `Standalone artifact contains a random Enhanced SEA temporary entrypoint: ${match[0]}`,
    );
  }
}
