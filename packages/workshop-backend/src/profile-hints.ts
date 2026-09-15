// Profile hints -- a display name and a photo -- that a gatekeeper offers about the person behind an
// account (GatekeeperUser.getAuthenticatedProfile, declared by VendorDescription.providesAuthProfile).
//
// The TPG fork applied these at sign-in. Flow applies them when an account is *connected* instead:
// identity here is Cloudflare Access, and a connection gatekeeper such as Microsoft is deliberately
// not in AUTH_GATEKEEPERS, so it never signs anyone in and connect is the only moment its hints
// exist. Hints are never an identity signal, and nothing here may fail or stall a connect.

import type { GatekeeperUser, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";

/** How long a connect waits for hints. A slow provider costs a seeded name, never a slow connect. */
export const PROFILE_HINT_TIMEOUT_MS = 5000;

// The string is a third party's and ends up wherever the user is named.
const MAX_NAME_HINT_LENGTH = 100;

// getAuthenticatedProfile() is optional on GatekeeperUser; the vendor's providesAuthProfile
// declaration is what is gated on, so the stub is viewed through a shape that marks it required.
type ProfileAccountStub = Required<Pick<GatekeeperUser, "getAuthenticatedProfile">>;
export type ProfileHints = Awaited<ReturnType<ProfileAccountStub["getAuthenticatedProfile"]>>;

export type ProfileHintOutcome = "ok" | "unsupported" | "timeout" | "failed";

/**
 * Vets an offered display name: trimmed, non-empty, at most MAX_NAME_HINT_LENGTH, and free of
 * control characters. Returns null when unusable. Takes `unknown` because the value crossed a
 * worker boundary and is only a string by declaration.
 */
export function sanitizeDisplayNameHint(hint: unknown): string | null {
  if (typeof hint !== "string") return null;
  let trimmed = hint.trim();
  if (trimmed === "" || trimmed.length > MAX_NAME_HINT_LENGTH) return null;
  if (/\p{Cc}/u.test(trimmed)) return null;
  return trimmed;
}

const HINTS_TIMED_OUT = Symbol("profile hints timed out");

/**
 * Ask a just-connected account for profile hints when its vendor declares it can supply them,
 * bounded by `timeoutMs`. Never throws: an undeclaring, slow, broken or hint-less gatekeeper yields
 * `{}`, with the outcome saying which.
 */
export async function fetchConnectProfileHints(
    vendor: { describe(): Promise<VendorDescription> },
    account: unknown,
    timeoutMs = PROFILE_HINT_TIMEOUT_MS)
    : Promise<{hints: ProfileHints, outcome: ProfileHintOutcome}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // On timeout the gatekeeper's promise stays pending, but Promise.race has already attached
    // handlers to it, so a late rejection cannot surface as an unhandled rejection.
    let result = await Promise.race([
      (async () => {
        if ((await vendor.describe()).providesAuthProfile !== true) return null;
        return await (account as ProfileAccountStub).getAuthenticatedProfile();
      })(),
      new Promise<typeof HINTS_TIMED_OUT>(resolve => {
        timer = setTimeout(() => resolve(HINTS_TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === HINTS_TIMED_OUT) return {hints: {}, outcome: "timeout"};
    if (result === null) return {hints: {}, outcome: "unsupported"};
    // Another worker's value, only a hints object by declaration.
    if (typeof result !== "object") return {hints: {}, outcome: "ok"};
    return {hints: result, outcome: "ok"};
  } catch {
    return {hints: {}, outcome: "failed"};
  } finally {
    clearTimeout(timer);
  }
}

/** Which hints were applied, never their values: the name and the photo are the user's. */
export function describeSeeded(seeded: {nameSeeded: boolean, photoSeeded: boolean})
    : "name+photo" | "name" | "photo" | "none" {
  if (seeded.nameSeeded && seeded.photoSeeded) return "name+photo";
  if (seeded.nameSeeded) return "name";
  if (seeded.photoSeeded) return "photo";
  return "none";
}
