// Build-only adapter: Firefox injects the unchanged vendor script first.
// Unit tests import the package directly through extraction.ts.
export const Readability = (
  globalThis as typeof globalThis & {
    Readability: typeof import("@mozilla/readability").Readability;
  }
).Readability;
