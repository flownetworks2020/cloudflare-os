// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<Array<{ id: string; name: string; type: "agent" }>>>(async () => []);
  const newGadget = vi.fn<() => never>();
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newGadget },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    navigate: vi.fn<(options: unknown) => void>(),
    newGadget,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
    selectedModels: [] as Array<string | null>,
    draftStorageKeys: [] as Array<string | undefined>,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

vi.mock("./features/chat/composer/ChatComposer", () => ({
  ChatComposer: ({ seedText, seedNonce, draftStorageKey, selectedModel }: {
    seedText?: string;
    seedNonce?: number;
    draftStorageKey?: string;
    selectedModel: string | null;
  }) => {
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    testState.draftStorageKeys.push(draftStorageKey);
    testState.selectedModels.push(selectedModel);
    return <textarea aria-label="Prompt" readOnly value={seedText ?? ""} />;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home prompt route flow", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    localStorage.clear();
    testState.seeds.length = 0;
    testState.draftStorageKeys.length = 0;
    testState.selectedModels.length = 0;
    vi.clearAllMocks();
  });

  it("seeds the composer once, clears route state, and does not create a workspace", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent prompt="Create a daily brief." />));

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(
      "Create a daily brief.",
    );
    expect(Math.max(...testState.seeds.map(({ nonce }) => nonce ?? 0))).toBe(1);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    expect(testState.newGadget).not.toHaveBeenCalled();
    expect(testState.draftStorageKeys).toContain("gadgets:composer-draft:v1:user-a:home");
  });

  it("selects a managed workspace agent from provider-page route state", async () => {
    testState.listModels.mockResolvedValueOnce([
      { id: "native", name: "Native", type: "agent" },
      { id: "managed:codex:gpt-5.6-sol", name: "Codex Sol", type: "agent" },
    ]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <HomePageContent model="managed:codex:gpt-5.6-sol" />,
    ));

    expect(testState.selectedModels).toContain("managed:codex:gpt-5.6-sol");
    expect(localStorage.getItem("lastSelectedModel")).toBe("managed:codex:gpt-5.6-sol");
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
  });
});
