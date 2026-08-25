// A failed live check (a gatekeeper's addObserver refusing, or the verifier failing to resolve)
// must scrub that gatekeeper from the collaborator's *persisted* observer record synchronously
// with the failure determination: the record is the standing claim that this collaborator was
// verified for that producer, and this open is not going to renew it.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// git-migration-do.test.ts); the gatekeeper facet and the client's User DO are the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

function seedGatekeepers(impl: any): void {
  for (let id of [1, 2]) {
    impl.storage.gatekeepers.put({
      id,
      resourceTitle: `Connection ${id}`,
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    });
  }
}

// A client User DO that always has the account and always mints a verifier.
const fakeClientUser = {
  getVerifier: async () => ({}),
  describeConnectedAccount: async () => null,
} as any;

describe("observer coverage scrub on a failed live check", () => {
  it("a refused re-verification drops the entry", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-coverage-scrub-refused");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      impl.ownerProfileId = "owner";
      // Alice is a reachable collaborator whose previous successful open left coverage for both
      // gatekeepers.
      impl.storage.collaborators.put({
        profile: { type: "user", id: "alice", name: "Alice" },
        addedBy: [{ type: "user", sharer: "owner", created: new Date(), role: "build" }],
      });
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {
          if (id === 1) throw new Error("access revoked upstream");
        },
        removeObserver: async () => {},
      });

      // No repair channel, so gatekeeper 1's refusal is terminal -- and descriptive.
      await expect(impl.ensureObserver("alice", fakeClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // The refused gatekeeper's coverage is scrubbed; the other's survives.
      let record = impl.storage.observers.get("alice");
      expect(1 in record.accountChoices).toBe(false);
      expect(record.accountChoices[2]).toBe(20);
    });
  });

  it("a getVerifier rejection scrubs that gatekeeper's persisted coverage", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-coverage-scrub-getverifier");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      // Already-configured coverage for both gatekeepers, as a previous successful open left it.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {},
        removeObserver: async () => { removed.push(id); },
      });

      // Gatekeeper 1's verifier never materializes: the client's User DO *rejects* (the
      // deterministic vendor-mismatch throw, or any cross-worker transport failure) rather than
      // returning null.
      let failingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 10) throw new Error("account is for a different vendor");
          return {};
        },
        describeConnectedAccount: async () => null,
      } as any;

      // No repair channel, so the failure is terminal -- and descriptive, not the raw RPC error.
      await expect(impl.ensureObserver("alice", failingClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // The rejection went through fail(): gatekeeper 1's persisted coverage is scrubbed -- so
      // the record no longer claims this collaborator was verified for it -- while gatekeeper 2's
      // survives. The invalidated registration is also rolled back (see the TODO in
      // ensureObserver's catch about keeping re-asserted registrations for admitted observers).
      let record = impl.storage.observers.get("alice");
      expect(1 in record.accountChoices).toBe(false);
      expect(record.accountChoices[2]).toBe(20);
      expect(removed).toEqual([1]);
    });
  });
});
