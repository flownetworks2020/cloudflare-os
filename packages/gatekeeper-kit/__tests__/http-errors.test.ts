import { describe, expect, it } from "vitest";
import { HttpError, isNoAccessError, probeAccess } from "../src/http-errors";

describe("isNoAccessError", () => {
  it("treats numeric 401, 403, and 404 statuses as no access, and nothing else", () => {
    expect(isNoAccessError(new HttpError(401, "unauthorized"))).toBe(true);
    expect(isNoAccessError(new HttpError(403, "denied"))).toBe(true);
    expect(isNoAccessError({ status: 404 })).toBe(true);
    expect(isNoAccessError(new HttpError(500, "upstream 404 from origin"))).toBe(false);
    expect(isNoAccessError(new Error("API 404: nope"))).toBe(false);
    expect(isNoAccessError("nope")).toBe(false);
  });
});

describe("probeAccess", () => {
  it("maps no-access statuses to false and rethrows operational failures", async () => {
    expect(await probeAccess(async () => {})).toBe(true);
    expect(await probeAccess(async () => { throw new HttpError(403, "denied"); })).toBe(false);
    await expect(probeAccess(async () => { throw new HttpError(500, "boom"); }))
      .rejects.toThrow("boom");
    await expect(probeAccess(async () => { throw new Error("404 in text"); }))
      .rejects.toThrow("404 in text");
  });
});
