import { describe, expect, it } from "vitest";
import { defaults, validateSettings } from "../../src/settings";

describe("server settings", () => {
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
    "http://192.168.1.42:8880",
    "http://10.0.0.4",
    "http://172.31.0.2",
    "https://speech.example.com",
  ])("accepts a LAN or HTTPS endpoint %s", (baseUrl) => {
    expect(
      validateSettings({ ...defaults, token: "secret", baseUrl }).baseUrl,
    ).toBe(baseUrl);
  });
  it.each([
    "http://example.com",
    "http://172.32.0.2",
    "http://192.169.1.2",
    "ftp://192.168.1.2",
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
