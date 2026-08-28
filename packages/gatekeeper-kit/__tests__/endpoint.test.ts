import { describe, expect, it } from "vitest";
import { normalizeVendorOrigin } from "../src/endpoint";

const hostPattern = /^[a-z0-9-]+\.mktorest\.com$/i;
const label = "Marketo REST endpoint";

describe("normalizeVendorOrigin", () => {
  it("drops credentials, paths, queries, and fragments from a recognized endpoint", () => {
    expect(normalizeVendorOrigin(
      "https://user:secret@123-abc.mktorest.com/rest/v1?access_token=secret#part",
      { hostPattern, label },
    )).toBe("https://123-abc.mktorest.com");
  });

  it("requires HTTPS by default", () => {
    expect(() => normalizeVendorOrigin("http://123-abc.mktorest.com", { hostPattern, label }))
      .toThrow("Marketo REST endpoint must use https.");
  });

  it("allows HTTP when HTTPS is not required", () => {
    expect(normalizeVendorOrigin("http://123-abc.mktorest.com/path", {
      hostPattern,
      label,
      requireHttps: false,
    })).toBe("http://123-abc.mktorest.com");
  });

  it("refuses non-HTTP schemes even when HTTPS is not required", () => {
    expect(() => normalizeVendorOrigin("javascript:alert(1)", {
      hostPattern,
      label,
      requireHttps: false,
    })).toThrow("Marketo REST endpoint must use https.");
  });

  it("refuses hosts outside the allowlist", () => {
    expect(() => normalizeVendorOrigin("https://evil.com", { hostPattern, label }))
      .toThrow("That is not a recognized Marketo REST endpoint host.");
  });

  it("tests explicit ports as part of the host", () => {
    expect(() => normalizeVendorOrigin("https://123-abc.mktorest.com:8443", {
      hostPattern,
      label,
    })).toThrow("That is not a recognized Marketo REST endpoint host.");
  });

  it("does not accept an allowed hostname as a suffix", () => {
    expect(() => normalizeVendorOrigin("https://123-abc.mktorest.com.evil.com", {
      hostPattern,
      label,
    })).toThrow("That is not a recognized Marketo REST endpoint host.");
  });

  it("reports unparseable input without echoing it", () => {
    expect(() => normalizeVendorOrigin("not a url", { hostPattern, label }))
      .toThrow("Marketo REST endpoint is not a valid URL.");
  });

  it("refuses a stateful host pattern rather than alternating on identical input", () => {
    // `lastIndex` advances on every match, so a `g`/`y` pattern accepts the first call and refuses
    // the identical second one. Deterministically fatal beats intermittently wrong.
    for (const stateful of [/^[a-z0-9-]+\.mktorest\.com$/gi, /^[a-z0-9-]+\.mktorest\.com$/y]) {
      const call = () =>
        normalizeVendorOrigin("https://123-abc.mktorest.com", { hostPattern: stateful, label });
      expect(call).toThrow("Marketo REST endpoint host pattern must not be global or sticky.");
      expect(call).toThrow(/must not be global or sticky/);
    }
  });

  it("keeps every refusal display-safe", () => {
    for (const raw of [
      "private invalid endpoint",
      "ftp://private.example.com/path",
      "https://private.example.com/path",
    ]) {
      // An accepted endpoint returns its origin, which fails the label assertion below.
      let answer: string;
      try {
        answer = normalizeVendorOrigin(raw, { hostPattern, label });
      } catch (error) {
        answer = (error as Error).message;
      }
      expect(answer).toContain(label);
      expect(answer).not.toContain(raw);
    }
  });
});
