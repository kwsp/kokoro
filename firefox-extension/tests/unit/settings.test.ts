import { describe, expect, it } from "vitest";
import { defaults, validateSettings } from "../../src/settings";

describe("local settings", () => {
  it("normalizes a valid loopback URL without changing credentials", () => {
    expect(
      validateSettings({
        ...defaults,
        baseUrl: "http://localhost:9999/",
        token: "secret",
      }),
    ).toEqual({
      ...defaults,
      baseUrl: "http://localhost:9999",
      token: "secret",
    });
  });
  it.each([
    "https://127.0.0.1:8880",
    "http://example.com",
    "http://127.0.0.1.evil.test",
    "http://user@localhost",
    "http://localhost/path",
    "http://localhost?x=1",
    "http://localhost#x",
  ])("rejects an unsafe endpoint %s", (baseUrl) => {
    expect(() =>
      validateSettings({ ...defaults, token: "secret", baseUrl }),
    ).toThrow();
  });
  it.each([
    { token: "" },
    { speed: NaN },
    { speed: 0 },
    { speed: 3 },
    { voice: "../voice" },
    { voice: "jf_alpha" },
  ])("rejects invalid settings %j", (overrides) => {
    expect(() =>
      validateSettings({ ...defaults, token: "secret", ...overrides }),
    ).toThrow();
  });
});
