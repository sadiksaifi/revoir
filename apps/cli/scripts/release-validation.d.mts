export declare function assertNoEnhancedSeaTemporaryEntrypoint(contents: Uint8Array): void;
export declare function standaloneNativeAssetPaths(
  architecture: "arm64" | "x64",
): readonly string[];
export declare function standaloneNativeRuntimeAssetPaths(
  architecture: "arm64" | "x64",
): readonly string[];
export declare function assertStandaloneNativeManifest(
  nativeAssets: readonly string[],
  architecture: "arm64" | "x64",
  manifestRoot: string,
): void;
