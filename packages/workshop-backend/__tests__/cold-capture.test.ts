import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  COLD_CAPTURE_WRAPPER_MODULE,
  COLD_CAPTURE_WRAPPER_SOURCE,
  readColdCapture,
} from "../src/cold-capture";
import { OVERSEER_CAPTURE_COLLECTIONS } from "../src/overseer";
import type { OverseerDurableObject } from "../src/overseer";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

let counter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`cold-capture-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

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

describe("OverseerImpl.captureWorkspaceSnapshot", () => {
  it("enumerates only the explicit live capture set", () => withImpl(async impl => {
    let names = impl.captureWorkspaceSnapshot().map((entry: { name: string }) => entry.name);
    expect(names).toEqual(OVERSEER_CAPTURE_COLLECTIONS);
    expect(names).not.toContain("code");
    expect(names).not.toContain("snapshots");
    expect(names).not.toContain("chatDraftUpdates");
    expect(names).toEqual(expect.arrayContaining([
      "gitObjects", "gadgets", "chats", "chatModelData", "chatCompactions", "chatAttachmentContent",
    ]));
  }));

  it("fails closed when the schema exposes an unrecognized collection", () => withImpl(async impl => {
    impl.storage.futureCollection = { list: () => [] };
    expect(() => impl.captureWorkspaceSnapshot()).toThrow("futureCollection");
  }));
});
