import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";

const MODEL_ID = "claude-sonnet-5";

function makeUser(config?: AiModelConfig): UserDurableObject {
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_PROVIDERS: "anthropic",
    },
    storage: {
      profile: {get: () => ({type: "user", id: "user-123", name: "User"})},
      aiModels: {
        get: (id: string) => id === MODEL_ID && config
          ? {profile: {type: "agent", id, name: "Claude"}, config}
          : undefined,
      },
    },
  });
  return user;
}

describe("UserDurableObject Anthropic credential resolution", () => {
  it("selects a stored user key before the company gateway", async () => {
    const context = await makeUser({
      provider: "anthropic", model: MODEL_ID, apiToken: "user-anthropic-key",
    }).getChatContext(MODEL_ID);

    expect(context.aiModel?.config).toMatchObject({
      provider: "anthropic", apiToken: "user-anthropic-key", credentialClass: "user",
    });
  });

  it("falls back to the company gateway when no user key is stored", async () => {
    const context = await makeUser().getChatContext(MODEL_ID);

    expect(context.aiModel?.config).toMatchObject({
      provider: "anthropic", apiToken: "",
    });
    expect(context.aiModel?.config.credentialClass).toBeUndefined();
  });
});
