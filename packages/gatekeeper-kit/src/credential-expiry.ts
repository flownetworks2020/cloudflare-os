import { createLogger } from "@gadgets/backend-utils/logger";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce } from "./connect-nonce";

/** KV key holding the expiry-notification latch. Unchanged from every current gatekeeper. */
const EXPIRED_NOTIFIED_KEY = "expiredNotified";

/**
 * Identifies the current arming of the latch, in its own key so the latch itself stays the plain
 * boolean every existing gatekeeper wrote. A notification that started before a reconnect must not
 * set the latch after it.
 *
 * Random per re-arm, and compared for equality only -- never a counter, for the same reason
 * `CredentialCoordinator.identity()` is not one: `revoke()` and the self-destruct alarm call
 * `deleteAll()`, and a counter restarting from zero would hand the replacement connection an arm a
 * notification for the revoked one is still holding, silencing the new account's first expiry.
 * `""` means never armed, which no live notification can observe: a notification requires
 * credentials, and establishing them arms the latch.
 */
const EXPIRY_ARM_KEY = "expiredNotifiedArm";

/**
 * The Durable Object KV surface used by the expiry latch.
 *
 * Pass the DO's own `ctx.storage.kv`, not a fresh wrapper per call: the in-flight map below is
 * keyed by this object's identity, so two adapters over one account's storage each get their own
 * entry and can both notify for a single arm. The durable latch still holds the at-most-once
 * contract in that case -- the coalescing is what is lost, not the guarantee.
 */
export type ExpiryLatchKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.connect" });

/**
 * One in-flight notification per account *per arm*: a caller arriving after a reconnect re-armed
 * the latch needs its own notification, not the one already awaiting a callback for the credentials
 * that were replaced.
 */
const inFlight = new WeakMap<ExpiryLatchKv, { arm: string; done: Promise<void> }>();

/**
 * Tell the Workshop the credentials need attention, at most once per expiry.
 *
 * The latch is set only after the callback resolves: a crash mid-notify then re-notifies later,
 * which is harmless, whereas claiming it up front would let a crash before the release silence
 * every future expiry and leave the user never asked to reconnect.
 *
 * Never throws — including from its own storage reads. Callers await this and then throw their own
 * "please reconnect", which neither a broken stored callback nor a failing latch may replace.
 */
export async function notifyCredentialsExpiredOnce(
  kv: ExpiryLatchKv,
  callback: Fetcher<GatekeeperConnectCallback> | undefined,
  vendorId: string,
): Promise<void> {
  if (callback === undefined) return;

  try {
    if (kv.get<boolean>(EXPIRED_NOTIFIED_KEY)) return;

    const arm = kv.get<string>(EXPIRY_ARM_KEY) ?? "";
    let entry = inFlight.get(kv);
    if (entry?.arm !== arm) {
      entry = { arm, done: notify(kv, callback, vendorId, arm) };
      inFlight.set(kv, entry);
    }
    try {
      await entry.done;
    } finally {
      // Released by whoever installed it, never by `notify` itself: a callback that throws before
      // returning a promise settles the notification inside the frame that started it, so `notify`
      // would try to release an entry that did not exist yet and leave a resolved one behind --
      // wedging every later caller for this arm on a notification that never happened.
      if (inFlight.get(kv) === entry) inFlight.delete(kv);
    }
  } catch (error) {
    logger.warn("expiry latch storage failed", {
      event: "credentials.expiry.latch.failed",
      vendorId,
      error,
    });
  }
}

async function notify(
  kv: ExpiryLatchKv,
  callback: Fetcher<GatekeeperConnectCallback>,
  vendorId: string,
  arm: string,
): Promise<void> {
  try {
    try {
      await callback.credentialsExpired();
    } catch (error) {
      logger.warn("failed to notify credential expiry", {
        event: "credentials.expiry.notify.failed",
        vendorId,
        error,
      });
      return;
    }

    // A reconnect during the call re-armed the latch; latching now would silence its next expiry.
    // Separate from the RPC above so a storage failure is not reported as a failed notification.
    if ((kv.get<string>(EXPIRY_ARM_KEY) ?? "") === arm) kv.put(EXPIRED_NOTIFIED_KEY, true);
  } catch (error) {
    logger.warn("expiry latch storage failed", {
      event: "credentials.expiry.latch.failed",
      vendorId,
      error,
    });
  }
}

/**
 * Re-arm the latch. Call wherever credentials are (re)established.
 *
 * The two writes must stay adjacent and awaitless, so one implicit transaction carries both. Split
 * by an await, a cleared latch could commit with the old arm surviving, and an in-flight
 * notification for the replaced credentials would then match that arm and latch the new ones --
 * silencing the reconnect prompt this module exists to deliver.
 */
export function clearCredentialExpiryLatch(kv: ExpiryLatchKv): void {
  kv.put(EXPIRED_NOTIFIED_KEY, false);
  kv.put(EXPIRY_ARM_KEY, generateNonce());
}
