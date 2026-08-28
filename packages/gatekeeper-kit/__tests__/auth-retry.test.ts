import { describe, expect, it, vi } from "vitest";
import { withAuthRetry } from "../src/auth-retry";

type TokenRequest = { forceRefresh: boolean; staleToken?: string };

describe("withAuthRetry", () => {
  it("uses the first token without adding a stale-token hint", async () => {
    const getToken = vi.fn(async () => "current");
    const run = vi.fn(async (token: string) => `${token}-result`);

    expect(await withAuthRetry({ getToken, isAuthError: () => false }, run))
      .toBe("current-result");
    expect(getToken).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith({ forceRefresh: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it("passes through a first non-auth failure without refreshing", async () => {
    const failure = new Error("provider unavailable");
    const getToken = vi.fn(async () => "current");
    const run = vi.fn(async () => { throw failure; });

    await expect(withAuthRetry({ getToken, isAuthError: () => false }, run))
      .rejects.toBe(failure);
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("refreshes with the rejected token and returns the replayed result", async () => {
    const authError = new Error("401");
    const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
      forceRefresh ? "fresh" : "stale");
    const run = vi.fn(async (token: string) => {
      if (token === "stale") throw authError;
      return "accepted";
    });

    expect(await withAuthRetry({ getToken, isAuthError: error => error === authError }, run))
      .toBe("accepted");
    expect(getToken).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      staleToken: "stale",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports the second auth failure and throws that failure", async () => {
    const firstError = new Error("first 401");
    const secondError = new Error("second 401");
    const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
      forceRefresh ? "fresh" : "stale");
    const run = vi.fn(async (token: string) => {
      throw token === "stale" ? firstError : secondError;
    });
    const onPersistentAuthError = vi.fn(async () => {});

    await expect(withAuthRetry({
      getToken,
      isAuthError: error => error === firstError || error === secondError,
      onPersistentAuthError,
    }, run)).rejects.toBe(secondError);
    expect(onPersistentAuthError).toHaveBeenCalledOnce();
    expect(onPersistentAuthError).toHaveBeenCalledWith(secondError);
  });

  it("does not report a non-auth failure from the replay as persistent auth", async () => {
    const authError = new Error("401");
    const providerError = new Error("provider unavailable");
    const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
      forceRefresh ? "fresh" : "stale");
    const run = vi.fn(async (token: string) => {
      throw token === "stale" ? authError : providerError;
    });
    const onPersistentAuthError = vi.fn(async () => {});

    await expect(withAuthRetry({
      getToken,
      isAuthError: error => error === authError,
      onPersistentAuthError,
    }, run)).rejects.toBe(providerError);
    expect(onPersistentAuthError).not.toHaveBeenCalled();
  });

  it("keeps the auth failure when reporting it fails", async () => {
    const firstError = new Error("first 401");
    const secondError = new Error("second 401");
    const reportError = new Error("account unavailable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
        forceRefresh ? "fresh" : "stale");
      const run = vi.fn(async (token: string) => {
        throw token === "stale" ? firstError : secondError;
      });

      await expect(withAuthRetry({
        getToken,
        isAuthError: error => error === firstError || error === secondError,
        onPersistentAuthError: async () => { throw reportError; },
        vendorId: "acme",
      }, run)).rejects.toBe(secondError);
      expect(logged).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({
        component: "gatekeeper.auth-retry",
        event: "auth-retry.report.failed",
        vendorId: "acme",
        error: String(reportError),
      }));
    } finally {
      logged.mockRestore();
    }
  });

  it("throws the second auth failure when no reporter is configured", async () => {
    const firstError = new Error("first 401");
    const secondError = new Error("second 401");
    const getToken = vi.fn(async ({ forceRefresh }: TokenRequest) =>
      forceRefresh ? "fresh" : "stale");
    const run = vi.fn(async (token: string) => {
      throw token === "stale" ? firstError : secondError;
    });

    await expect(withAuthRetry({
      getToken,
      isAuthError: error => error === firstError || error === secondError,
    }, run)).rejects.toBe(secondError);
  });
});
