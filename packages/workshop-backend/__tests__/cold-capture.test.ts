import { describe, expect, it } from "vitest";
import {
  COLD_CAPTURE_WRAPPER_MODULE,
  COLD_CAPTURE_WRAPPER_SOURCE,
  readColdCapture,
} from "../src/cold-capture";

describe("cold gadget capture", () => {
  it("uses a host wrapper which imports server.js without rewriting it", () => {
    expect(COLD_CAPTURE_WRAPPER_MODULE).toBe("capture-wrapper.js");
    expect(COLD_CAPTURE_WRAPPER_SOURCE).toContain('import { Gadget as UserGadget } from "./server.js"');
    expect(COLD_CAPTURE_WRAPPER_SOURCE).toContain("class Gadget extends UserGadget");
    expect(COLD_CAPTURE_WRAPPER_SOURCE).toContain("this.ctx.storage.list()");
  });

  it("returns the exact entries supplied by the host-owned dump method", async () => {
    await expect(readColdCapture({
      async __coldCaptureDump() {
        return [["count", 3], ["enabled", true]];
      },
    })).resolves.toEqual({
      status: "captured",
      entries: [["count", 3], ["enabled", true]],
    });
  });

  it("records an unreadable gadget explicitly instead of treating it as empty storage", async () => {
    await expect(readColdCapture({
      async __coldCaptureDump() {
        throw new Error("server.js failed during module evaluation");
      },
    })).resolves.toEqual({
      status: "unreadable",
      reason: "server.js failed during module evaluation",
    });
  });
});
