// The single retry four gatekeepers hand-roll around a rejected credential (marketo
// `marketo-api.ts:462-477`, google `auth-retry.ts:100-141`, notion `notion-api.ts:1022-1052`,
// confluence `confluence-api.ts:527-550`). `CredentialSource` has only two outcomes -- pass
// through, or report the grant dead -- so a provider whose 401 can mean a stale derived bearer
// needs this in front of it.

import { createLogger } from "@gadgets/backend-utils/logger";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.auth-retry" });

/** How `withAuthRetry` obtains tokens and classifies failures. */
export type AuthRetryOptions<Token> = {
  /**
   * Returns a usable token. `forceRefresh` demands a provider round trip; `staleToken` is the
   * token the provider just rejected, so a shared cache can skip a redundant mint when another
   * caller already advanced it.
   */
  getToken(options: { forceRefresh: boolean; staleToken?: Token }): Promise<Token>;
  /** Classifies a caught error as the provider rejecting the credential (not transport/5xx). */
  isAuthError(error: unknown): boolean;
  /** Called once when the retry also fails with an auth error -- the grant itself is dead. */
  onPersistentAuthError?(error: unknown): void | Promise<void>;
  /** Folded into the failure log line. */
  vendorId?: string;
};

/**
 * Retries once when a 401 means a stale derived bearer rather than a dead grant. `run` is executed
 * at most twice and must therefore be replayable; build the request inside it for each attempt.
 */
export async function withAuthRetry<Token, T>(
  options: AuthRetryOptions<Token>,
  run: (token: Token) => Promise<T>,
): Promise<T> {
  const token = await options.getToken({ forceRefresh: false });
  try {
    return await run(token);
  } catch (error) {
    if (!options.isAuthError(error)) throw error;
  }

  const retryToken = await options.getToken({ forceRefresh: true, staleToken: token });
  try {
    return await run(retryToken);
  } catch (error) {
    if (!options.isAuthError(error)) throw error;

    try {
      await options.onPersistentAuthError?.(error);
    } catch (reportError) {
      logger.error("failed to report persistent auth error", {
        event: "auth-retry.report.failed",
        vendorId: options.vendorId,
        error: reportError,
      });
    }
    throw error;
  }
}
