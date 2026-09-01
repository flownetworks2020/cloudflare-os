import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises ensureManagedWorkpiece, the gadget resolution used by managed workspace-agent
// turns. A managed agent has no `workpiece` tool parameter, so modern (multi-gadget)
// workspaces -- which never set the legacy defaultGadgetId -- must resolve their single
// visible gadget, and an empty workspace must yield a fresh provisional gadget rather than
// failing with tool-call instructions no managed agent can follow.

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

describe("ensureManagedWorkpiece", () => {
  it("resolves the workspace's single gadget when there is no default gadget", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A");
      expect(impl.ensureManagedWorkpiece(1, "Chat Title")).toEqual({ workpieceId: 7 });
    });
  });

  it("ignores gadgets still provisional to another chat", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A");
      addGadget(impl, 8, "GADGET_B", { chatId: 2 });
      expect(impl.ensureManagedWorkpiece(1, "Chat Title")).toEqual({ workpieceId: 7 });
    });
  });

  it("counts a gadget provisional to the requesting chat as visible", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A", { chatId: 1 });
      expect(impl.ensureManagedWorkpiece(1, "Chat Title")).toEqual({ workpieceId: 7 });
    });
  });

  it("creates a provisional gadget for an empty workspace instead of refusing", async () => {
    await withImpl(async impl => {
      const resolved = impl.ensureManagedWorkpiece(1, "  Chat Title  ");
      expect(resolved.created).toMatchObject({
        gadgetId: resolved.workpieceId, title: "Chat Title", bindingName: "GADGET",
      });
      const record = impl.storage.gadgets.get(resolved.workpieceId);
      expect(record).toMatchObject({ title: "Chat Title", bindingName: "GADGET" });
      expect(record.pending).toEqual({ chatId: 1 });
      // The next resolution in the same chat adopts the provisional gadget.
      expect(impl.ensureManagedWorkpiece(1, "Chat Title"))
        .toEqual({ workpieceId: resolved.workpieceId });
    });
  });

  it("falls back to a generic title when the chat has none", async () => {
    await withImpl(async impl => {
      const resolved = impl.ensureManagedWorkpiece(1, "   ");
      expect(resolved.created?.title).toBe("New Gadget");
    });
  });

  it("refuses an ambiguous multi-gadget workspace", async () => {
    await withImpl(async impl => {
      addGadget(impl, 7, "GADGET_A");
      addGadget(impl, 8, "GADGET_B");
      expect(() => impl.ensureManagedWorkpiece(1, "Chat Title")).toThrow(/multiple gadgets/i);
    });
  });

  it("prefers the legacy default gadget when one is recorded", async () => {
    await withImpl(async impl => {
      addGadget(impl, 3, "GADGET");
      addGadget(impl, 9, "GADGET_B");
      impl.storage.defaultGadgetId.put(3);
      impl.defaultGadgetId = 3;
      expect(impl.ensureManagedWorkpiece(1, "Chat Title")).toEqual({ workpieceId: 3 });
    });
  });
});
