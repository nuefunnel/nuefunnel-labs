// The version comes from package.json: scripts/build.mjs writes it in as READBACK_VERSION.
// Tests run the sources directly, without the build, and see "dev".
declare const READBACK_VERSION: string | undefined;
export const VERSION: string = typeof READBACK_VERSION === "string" ? READBACK_VERSION : "dev";
