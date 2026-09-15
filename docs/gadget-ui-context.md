# Gadget UI context for feedback

CFOS supplies a read-only `globalThis.CFOS_CONTEXT` object before running gadget client code. Older servers supply `null`; gadgets must keep metadata unavailable rather than infer it from an iframe URL.

The v1 object contains `workspaceId`, `gadgetId`, nullable `chatId`, `view` (`saved` or `chat_preview`), and `clientCodeSha256`. The hash covers the exact UTF-8 client code returned in that UI bundle, not a later workspace head, server code, deployment revision or proof of blueprint adoption. Context stays with the displayed bundle until it reloads. A chat-scoped view is conservatively labelled preview even when no edits are pending.

The shell transports context inside the sandbox's encoded script, without adding a network capability or copying parent URLs, query strings, credentials, user identity or bindings. Existing gadget-use authorization still controls bundle access. Context describes what was rendered; it grants no permissions. If a gadget forwards it to a feedback service, that service must treat it as a client-reported diagnostic claim, separate from independently verified actor, packet and access provenance. A read-only JavaScript property is not a cryptographic attestation.

Feedback consumers should retain these fields alongside element bounds, component IDs, reproduction steps and an immutable feedback receipt. Missing context must remain explicit. Wider shell annotation, authenticated delivery routing, deployment revision and product-agent acceptance are separate capabilities.
