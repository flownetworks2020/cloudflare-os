/**
 * An HTTP error carrying its response status, so verifiers can classify failures numerically
 * instead of parsing message text.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * True only when the error carries a numeric `status` of 401/403/404 (observer lacks access).
 * Never parses status codes out of message text, which could match a code embedded in a 5xx body
 * and misclassify an operational failure. Errors without a numeric status (5xx, network, parse
 * failures) return false and MUST be rethrown by the caller, never treated as "no access".
 */
export function isNoAccessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}

/**
 * Runs an ACL probe, mapping no-access statuses to `false` and rethrowing anything operational.
 *
 * `check` MUST throw to report failure; the resolved value is never inspected. Passing a bare
 * `fetch` therefore reports access for a 403, because `fetch` resolves for HTTP errors -- the
 * client must check the response itself and throw an `HttpError` carrying the status. Typing the
 * callback `Promise<void>` would not help: TypeScript accepts any return type in a `void`
 * position, so `() => fetch(url)` would still assign.
 */
export async function probeAccess(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    if (isNoAccessError(error)) return false;
    throw error;
  }
}
