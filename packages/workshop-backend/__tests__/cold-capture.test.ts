import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
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
