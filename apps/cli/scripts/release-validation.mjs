const enhancedSeaTemporaryEntrypoint =
  /(?:\/[A-Za-z0-9._-]+)+\/pkg-sea-[A-Za-z0-9_-]+\/sea-main\.js/u;

export function assertNoEnhancedSeaTemporaryEntrypoint(contents) {
  const match = Buffer.from(contents).toString("latin1").match(enhancedSeaTemporaryEntrypoint);
  if (match !== null) {
    throw new Error(
      `Standalone artifact contains a random Enhanced SEA temporary entrypoint: ${match[0]}`,
    );
  }
}
