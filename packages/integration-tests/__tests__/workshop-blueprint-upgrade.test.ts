import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiChatMessage, Overseer, WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, RpcTarget, signUp, stubFor, waitFor } from "../src/rpc-client.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID,
  SCRIPTED_MODEL_PROFILE, type ScriptedChatCompletions,
} from "../src/mock-model.js";

type StoredValueGadget = { remember(value: string): Promise<void>; recall(): Promise<string> };
let harness: Harness;
let model: ScriptedChatCompletions | undefined;
const network = new NetworkInterceptor({ handlers: [(...args) => model?.handler(...args) ?? null] });
beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [], enableGadgetExecution: true });
});
afterAll(async () => {
  try { await harness?.server.close(); expect(network.getUnmockedCalls()).toEqual([]); }
  finally { network.uninstall(); }
});

async function workpieces(workspace: RpcStub<Overseer>): Promise<WorkpieceSummary[]> {
  const values: WorkpieceSummary[] = [];
  const ready = Promise.withResolvers<void>();
  class Subscriber extends RpcTarget {
    entry(value: WorkpieceSummary) { values.push(value); }
    removed() {}
    ready() { ready.resolve(); }
  }
  using subscriber = stubFor(new Subscriber());
  using _subscription = await workspace.subscribeToWorkpieces(subscriber);
  await ready.promise;
  return values;
}
async function onlyGadget(workspace: RpcStub<Overseer>) {
  const values = await workpieces(workspace);
  expect(values).toHaveLength(1);
  const value = values[0];
  if (!value?.commitId) throw new Error("Expected one committed Gadget");
  return { ...value, commitId: value.commitId };
}
async function edit(workspace: RpcStub<Overseer>, files: [string, { set: string } | { remove: true }][]) {
  const gadget = await onlyGadget(workspace);
  const chat = await workspace.newChat("Review this exact test source", null);
  await workspace.submitCodeChange(chat, {
    generation: 0, revision: 0, clientId: crypto.randomUUID(), seq: 1,
    pins: [{ gadgetId: gadget.id, baseCommit: gadget.commitId }],
    change: { [gadget.id]: files },
  });
  expect(await workspace.mergeChanges(chat)).toEqual({ outcome: "merged" });
}
function toolOutput(history: AiChatMessage[], callId: string): string {
  for (const entry of history) {
    if (entry.type !== "message") continue;
    for (const call of entry.toolCalls ?? []) {
      if (call.toolName === "upgradeGadget" && call.toolCallId === callId && call.output !== undefined) return call.output;
    }
  }
  throw new Error(`No persisted upgrade tool result for ${callId}: ${JSON.stringify(history)}`);
}
async function turn(workspace: RpcStub<Overseer>, args: Record<string, unknown>, callId: string, existingChat?: number) {
  model = scriptedChatCompletions([
    { toolCall: { id: callId, name: "upgradeGadget", arguments: args } },
    { text: `Finished ${callId}` },
  ]);
  const prompt = "Upgrade this existing gadget using the exact published blueprint versions. Preview before staging.";
  const chat = existingChat ?? await workspace.newChat(prompt, SCRIPTED_MODEL_ID);
  if (existingChat !== undefined) await workspace.sendChatMessage(chat, prompt, SCRIPTED_MODEL_ID);
  const history = await waitFor("the native upgrade agent to finish", async () => {
    const chats = await workspace.listChats();
    const metadata = chats.find(value => value.id === chat);
    const page = await workspace.getChatHistory(chat);
    return metadata && !metadata.activeAgent && page.messages.some(entry =>
      entry.type === "message" && entry.message === `Finished ${callId}`) ? page.messages : null;
  });
  expect(model.remainingSteps()).toBe(0);
  return { chat, history };
}

it("previews, refuses changed source, stages and accepts exact files through the native agent", async () => {
  using api = connect(harness.url);
  const username = nextUsernames("upgrade")[0];
  if (!username) throw new Error("No test identity");
  using user = await signUp(api, username);
  await user.addModel(SCRIPTED_MODEL_PROFILE, SCRIPTED_MODEL_CONFIG);
  await user.setQuickModel(null);
  await user.completeOnboarding();
  using source = await user.newGadget();
  using _created = await source.createGadget("Upgrade fixture", undefined, "APP");
  const sourceGadget = await onlyGadget(source);
  const server = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async remember(value) { await this.ctx.storage.put("upgrade-test", value); }
  async recall() { return await this.ctx.storage.get("upgrade-test"); }
}`;
  await edit(source, [["server.js", { set: server }], ["client.js", { set: 'document.body.textContent = "v1";' }], ["retired.txt", { set: "old" }]]);
  using publisher = await source.getGadget(sourceGadget.id);
  const blueprint = await publisher.createBlueprint("Upgrade fixture");
  using installed = await user.newGadgetFromBlueprint(blueprint.id, {});
  using customized = await user.newGadgetFromBlueprint(blueprint.id, {});
  const identity = await installed.getMetadata();
  const before = await onlyGadget(installed);
  const original = await installed.getCodeAtCommit(before.commitId);
  using app = await installed.getGadget(before.id);
  using runtime = await app.connectToGadget() as RpcStub<StoredValueGadget>;
  await runtime.remember("saved before upgrade");

  await edit(source, [["client.js", { set: 'document.body.textContent = "v2";' }], ["retired.txt", { remove: true }], ["version.txt", { set: "exact published bytes" }]]);
  await source.updateBlueprint(blueprint.id, { updateCode: true });
  await waitFor("version two publication", async () =>
    (await api.getBlueprint(blueprint.id))?.metadata.version === 2 ? true : null);
  const targetHead = await onlyGadget(source);
  const target = await source.getCodeAtCommit(targetHead.commitId);
  const args = { workpiece: "GADGET", blueprintId: blueprint.id, fromVersion: 1, toVersion: 2 };
  const preview = await turn(installed, args, "preview");
  const result = JSON.parse(toolOutput(preview.history, "preview"));
  expect(result.status).toBe("preview");
  expect(result.customizedFiles).toEqual([]);
  expect(result.added).toEqual(["version.txt"]);
  expect(result.removed).toEqual(["retired.txt"]);
  expect(result.modified).toEqual(["client.js"]);
  expect((await onlyGadget(installed)).commitId).toBe(before.commitId);
  expect(preview.history.some(entry => entry.type === "changes")).toBe(false);

  const staged = await turn(installed, { ...args, reviewToken: result.reviewToken }, "stage", preview.chat);
  expect(JSON.parse(toolOutput(staged.history, "stage")).status).toBe("staged_for_review");
  expect(staged.history.some(entry => entry.type === "changes")).toBe(true);
  expect((await onlyGadget(installed)).commitId).toBe(before.commitId);
  expect(await runtime.recall()).toBe("saved before upgrade");
  expect(await installed.mergeChanges(staged.chat)).toEqual({ outcome: "merged" });
  const after = await onlyGadget(installed);
  expect({ ...after, commitId: before.commitId }).toEqual(before);
  const metadataAfter = await installed.getMetadata();
  // Agent accounting legitimately advances; workspace identity and configuration do not.
  expect({ ...metadataAfter, totalCost: identity.totalCost }).toEqual(identity);
  expect((await installed.getCodeAtCommit(after.commitId)).files.toSorted()).toEqual(target.files.toSorted());
  expect(await installed.getCodeAtCommit(before.commitId)).toEqual(original);
  using upgradedRuntime = await app.connectToGadget() as RpcStub<StoredValueGadget>;
  expect(await upgradedRuntime.recall()).toBe("saved before upgrade");

  // Roll back source through a new review, not by assuming an accepted chat can
  // be erased or that reverting code will roll back application data.
  await upgradedRuntime.remember("written after upgrade");
  const rollbackChat = await installed.newChat("Restore the verified pre-upgrade source", null);
  const originalFiles = new Map(original.files);
  const upgradedFiles = new Map(target.files);
  const restore: [string, { set: string } | { remove: true }][] = [
    ...originalFiles.entries(),
  ].map(([path, content]) => [path, { set: content }]);
  for (const path of upgradedFiles.keys()) {
    if (!originalFiles.has(path)) restore.push([path, { remove: true }]);
  }
  await installed.submitCodeChange(rollbackChat, {
    generation: 0, revision: 0, clientId: crypto.randomUUID(), seq: 1,
    pins: [{ gadgetId: after.id, baseCommit: after.commitId }],
    change: { [after.id]: restore },
  });
  expect((await onlyGadget(installed)).commitId).toBe(after.commitId);
  expect(await installed.mergeChanges(rollbackChat)).toEqual({ outcome: "merged" });
  const restored = await onlyGadget(installed);
  expect((await installed.getCodeAtCommit(restored.commitId)).files.toSorted()).toEqual(original.files.toSorted());
  expect({ ...restored, commitId: before.commitId }).toEqual(before);
  using restoredRuntime = await app.connectToGadget() as RpcStub<StoredValueGadget>;
  expect(await restoredRuntime.recall()).toBe("written after upgrade");
  // Restoring files must preserve the prior upgrade conversation and its receipt.
  expect(toolOutput((await installed.getChatHistory(staged.chat)).messages, "stage"))
    .toBe(toolOutput(staged.history, "stage"));

  const customPreview = await turn(customized, args, "custom-preview");
  const customToken = JSON.parse(toolOutput(customPreview.history, "custom-preview")).reviewToken;
  await edit(customized, [["local.txt", { set: "Keep my customization" }]]);
  const customHead = await onlyGadget(customized);
  const refused = await turn(customized, { ...args, reviewToken: customToken }, "refuse");
  expect(refused.history.some(entry => entry.type === "changes")).toBe(false);
  expect((await onlyGadget(customized)).commitId).toBe(customHead.commitId);
  expect(JSON.stringify(refused.history)).toContain("Source changed since the upgrade preview");
  const changedPreview = await turn(customized, args, "changed-preview");
  const changed = JSON.parse(toolOutput(changedPreview.history, "changed-preview"));
  expect(changed.customizedFiles).toEqual(["local.txt"]);
  const customRefusal = await turn(customized, { ...args, reviewToken: changed.reviewToken }, "custom-refusal");
  expect(JSON.stringify(customRefusal.history)).toContain("Review customizations manually");
  expect(customRefusal.history.some(entry => entry.type === "changes")).toBe(false);
  expect((await onlyGadget(customized)).commitId).toBe(customHead.commitId);
});


it("binds UI context to saved or preview bytes without changing the saved head", async () => {
  using api = connect(harness.url);
  const username = nextUsernames("uicontext")[0];
  if (!username) throw new Error("No test identity");
  using user = await signUp(api, username);
  await user.setQuickModel(null);
  await user.completeOnboarding();
  using workspace = await user.newGadget();
  using _created = await workspace.createGadget("Context fixture", undefined, "APP");
  await edit(workspace, [["client.js", {set: 'document.body.textContent = "saved";'}]]);
  const original = await onlyGadget(workspace);
  using gadget = await workspace.getGadget(original.id);
  const saved = await gadget.getUiBundle();
  expect(saved?.context).toMatchObject({
    schema: "cfos.gadget-ui-context.v1", gadgetId: original.id, chatId: null, view: "saved",
  });
  expect(saved?.context?.workspaceId).toMatch(/^[a-f0-9]{64}$/);
  const hash = async (text: string) => Array.from(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ), byte => byte.toString(16).padStart(2, "0")).join("");
  expect(saved?.context?.clientCodeSha256).toBe(await hash(saved!.jsCode));
  const chat = await workspace.newChat("Unaccepted diagnostic preview", null);
  await workspace.submitCodeChange(chat, {
    generation: 0, revision: 0, clientId: crypto.randomUUID(), seq: 1,
    pins: [{gadgetId: original.id, baseCommit: original.commitId}],
    change: {[original.id]: [["client.js", {set: 'document.body.textContent = "preview";'}]]},
  });
  const preview = await gadget.getUiBundle(chat);
  expect(preview?.context).toMatchObject({
    workspaceId: saved?.context?.workspaceId, gadgetId: original.id, chatId: chat, view: "chat_preview",
  });
  expect(preview?.jsCode).toContain('"preview"');
  expect(preview?.context?.clientCodeSha256).toBe(await hash(preview!.jsCode));
  expect(preview?.context?.clientCodeSha256).not.toBe(saved?.context?.clientCodeSha256);
  expect((await onlyGadget(workspace)).commitId).toBe(original.commitId);
  expect(await gadget.getUiBundle()).toEqual(saved);
});
