// Marketo proves operator-pasted endpoints need an anchored host allowlist; Home Assistant's
// scheme-only check leaves the gap this closes. mcp-shared's MCP-scoped blocklist stays local.

/**
 * Normalizes an operator-pasted vendor endpoint to its origin, or throws a display-safe error.
 * `hostPattern` MUST be anchored (`/^...$/`) and is tested against `url.host` (which includes any
 * explicit port, so an anchored pattern refuses ports unless it names one). The thrown messages
 * never echo the input.
 */
export function normalizeVendorOrigin(raw: string, options: {
  /** Anchored, and neither global nor sticky -- both carry `lastIndex` between calls. */
  hostPattern: RegExp;
  /** Names the endpoint in error messages, e.g. "Marketo REST endpoint". */
  label: string;
  /** Default true. */
  requireHttps?: boolean;
}): string {
  // A `g` or `y` pattern advances `lastIndex` on every match, so the same endpoint would alternate
  // between accepted and refused. A programming error rather than bad input: fail on every call,
  // not on every other one.
  if (options.hostPattern.global || options.hostPattern.sticky) {
    throw new Error(`${options.label} host pattern must not be global or sticky.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${options.label} is not a valid URL.`);
  }

  if (url.protocol !== "https:" && (options.requireHttps !== false || url.protocol !== "http:")) {
    throw new Error(`${options.label} must use https.`);
  }
  if (!options.hostPattern.test(url.host)) {
    throw new Error(`That is not a recognized ${options.label} host.`);
  }
  return url.origin;
}
