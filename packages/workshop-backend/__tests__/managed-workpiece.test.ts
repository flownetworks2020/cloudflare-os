import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises resolveManagedWorkpiece, the gadget resolution used by managed workspace-agent
// turns. A managed agent has no `workpiece` tool parameter, so modern (multi-gadget)
// workspaces -- which never set the legacy defaultGadgetId -- must resolve their single
// visible gadget rather than failing with tool-call instructions no managed agent can follow.

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`managed-workpiece-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

function addGadget(impl: any, id: number, bindingName: string,
                   pending?: {chatId: number}): void {
  impl.storage.gadgets.put({
    id, title: bindingName, created: new Date(0), bindingName, bindings: {},
    ...(pending ? { pending } : {}),
  });
}

describe("resolveManagedWorkpiece", () => {
  it("resolves the workspace's single gadget when there is no default gadget", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A");
      expect(impl.resolveManagedWorkpiece(1)).toEqual({ workpieceId: 7 });
    });
  });

  it("ignores gadgets still provisional to another chat", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A");
      addGadget(impl, 8, "GADGET_B", { chatId: 2 });
      expect(impl.resolveManagedWorkpiece(1)).toEqual({ workpieceId: 7 });
    });
  });

  it("counts a gadget provisional to the requesting chat as visible", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A", { chatId: 1 });
      expect(impl.resolveManagedWorkpiece(1)).toEqual({ workpieceId: 7 });
    });
  });

  it("refuses a workspace with no gadget in user terms, not tool-call terms", async () => {
    await withImpl(async impl => {
      expect(() => impl.resolveManagedWorkpiece(1)).toThrow(/no gadget for the workspace agent/i);
      expect(() => impl.resolveManagedWorkpiece(1)).not.toThrow(/workpiece.*parameter/i);
    });
  });

  it("refuses an ambiguous multi-gadget workspace", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A");
      addGadget(impl, 8, "GADGET_B");
      expect(() => impl.resolveManagedWorkpiece(1)).toThrow(/multiple gadgets/i);
    });
  });

  it("prefers the legacy default gadget when one is recorded", async () => {
    await withImpl(async impl => {
      addGadget(impl, 3, "GADGET");
      addGadget(impl, 9, "GADGET_B");
      impl.storage.defaultGadgetId.put(3);
      impl.defaultGadgetId = 3;
      expect(impl.resolveManagedWorkpiece(1)).toEqual({ workpieceId: 3 });
    });
  });
});
