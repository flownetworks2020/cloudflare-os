// Profile hints applied when a gatekeeper is connected (re-homed from the TPG fork's sign-in-time
// seeding). Two levels: fetchConnectProfileHints owns "a hint can never break or stall a connect",
// and UserDurableObject.seedProfileFromHints owns the name and avatar policy.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";
import { describeSeeded, fetchConnectProfileHints, sanitizeDisplayNameHint }
  from "../src/profile-hints.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    AVATARS: KVNamespace;
  }
}

const EMAIL = "alice.smith@example.com";
const LOCAL_PART = "alice.smith";
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function vendor(description: Partial<VendorDescription>) {
  return {
    describe: async () => ({ displayName: "Test", ...description }) as VendorDescription,
  };
}

/** Runs `body` against a real UserDurableObject with its own (empty) storage. */
function withUser(body: (user: UserDurableObject) => Promise<void>): Promise<void> {
  const stub = env.TEST_USER.get(env.TEST_USER.newUniqueId());
  return runInDurableObject(stub, async (user: UserDurableObject) => { await body(user); });
}

async function storedAvatar(userId: string): Promise<Uint8Array | null> {
  const value = await env.AVATARS.get(userId, "arrayBuffer");
  return value === null ? null : new Uint8Array(value);
}

describe("fetchConnectProfileHints", () => {
  it("does not ask an account whose vendor declares no profile hints", async () => {
    const account = { getAuthenticatedProfile: vi.fn(async () => ({ name: "Alice Smith" })) };

    await expect(fetchConnectProfileHints(vendor({}), account))
      .resolves.toEqual({ hints: {}, outcome: "unsupported" });
    expect(account.getAuthenticatedProfile).not.toHaveBeenCalled();
  });

  it("returns the hints a declaring vendor's account offers", async () => {
    const account = { getAuthenticatedProfile: async () => ({ name: "Alice Smith" }) };

    await expect(fetchConnectProfileHints(vendor({ providesAuthProfile: true }), account))
      .resolves.toEqual({ hints: { name: "Alice Smith" }, outcome: "ok" });
  });

  it("swallows a failing account", async () => {
    const account = {
      getAuthenticatedProfile: async () => { throw new Error("graph down"); },
    };

    await expect(fetchConnectProfileHints(vendor({ providesAuthProfile: true }), account))
      .resolves.toEqual({ hints: {}, outcome: "failed" });
  });

  it("stops waiting for a slow account", async () => {
    const account = { getAuthenticatedProfile: () => new Promise<never>(() => {}) };

    await expect(fetchConnectProfileHints(vendor({ providesAuthProfile: true }), account, 10))
      .resolves.toEqual({ hints: {}, outcome: "timeout" });
  });

  it("treats a non-object answer as no hints", async () => {
    const account = { getAuthenticatedProfile: async () => "Alice Smith" };

    await expect(fetchConnectProfileHints(vendor({ providesAuthProfile: true }), account))
      .resolves.toEqual({ hints: {}, outcome: "ok" });
  });
});

describe("sanitizeDisplayNameHint", () => {
  it.each([
    ["a non-string", 123],
    ["blank", "   "],
    ["over-long", "A".repeat(101)],
    ["a line break", "Alice\nSmith"],
    ["a null character", `Alice${String.fromCharCode(0)}Smith`],
  ])("refuses %s", (_label, hint) => {
    expect(sanitizeDisplayNameHint(hint)).toBeNull();
  });

  it("trims an acceptable name", () => {
    expect(sanitizeDisplayNameHint("  Alice Smith ")).toBe("Alice Smith");
  });
});

describe("seedProfileFromHints", () => {
  it("replaces the email local-part name the Workshop seeded, never the identity",
      () => withUser(async user => {
    await user.authenticateFromCfAccess(EMAIL, true);

    await expect(user.seedProfileFromHints({ name: "Alice Smith" }))
      .resolves.toEqual({ nameSeeded: true, photoSeeded: false });
    const profile = await user.whoami();
    expect(profile.name).toBe("Alice Smith");
    expect(profile.id).toBe(EMAIL);
  }));

  it("never clobbers a name the user chose", () => withUser(async user => {
    await user.authenticateFromCfAccess(EMAIL, true);
    await user.setOwnDisplayName("Ali");

    await expect(user.seedProfileFromHints({ name: "Alice Smith" }))
      .resolves.toEqual({ nameSeeded: false, photoSeeded: false });
    expect((await user.whoami()).name).toBe("Ali");
  }));

  it("leaves a password account's display name alone", () => withUser(async user => {
    await user.createAccount("alice", "alice", new Uint8Array(32));

    await expect(user.seedProfileFromHints({ name: "Alice Smith" }))
      .resolves.toEqual({ nameSeeded: false, photoSeeded: false });
    expect((await user.whoami()).name).toBe("alice");
  }));

  it("refuses an unusable name hint", () => withUser(async user => {
    await user.authenticateFromCfAccess(EMAIL, true);

    await user.seedProfileFromHints({ name: "Alice\nSmith" });
    expect((await user.whoami()).name).toBe(LOCAL_PART);
  }));

  it("stores a photo only when no avatar exists", () => withUser(async user => {
    const email = `photo-${crypto.randomUUID()}@example.com`;
    await user.authenticateFromCfAccess(email, true);

    await expect(user.seedProfileFromHints({ photo: { data: PNG, mimeType: "image/png" } }))
      .resolves.toEqual({ nameSeeded: false, photoSeeded: true });
    expect(await storedAvatar(email)).toEqual(PNG);

    await expect(user.seedProfileFromHints({ photo: { data: JPEG, mimeType: "image/jpeg" } }))
      .resolves.toEqual({ nameSeeded: false, photoSeeded: false });
    expect(await storedAvatar(email)).toEqual(PNG);
  }));

  it("refuses a photo that is not a JPEG or PNG", () => withUser(async user => {
    const email = `gif-${crypto.randomUUID()}@example.com`;
    await user.authenticateFromCfAccess(email, true);

    await expect(user.seedProfileFromHints({ photo: { data: GIF, mimeType: "image/png" } }))
      .resolves.toEqual({ nameSeeded: false, photoSeeded: false });
    expect(await storedAvatar(email)).toBeNull();
  }));

  it("does nothing for an account that was never created", () => withUser(async user => {
    await expect(user.seedProfileFromHints({ name: "Alice Smith" }))
      .resolves.toEqual({ nameSeeded: false, photoSeeded: false });
  }));

  it("reports what was seeded without its values", () => {
    expect(describeSeeded({ nameSeeded: true, photoSeeded: true })).toBe("name+photo");
    expect(describeSeeded({ nameSeeded: false, photoSeeded: false })).toBe("none");
  });
});
