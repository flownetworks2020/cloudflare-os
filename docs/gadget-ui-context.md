# Gadget UI context for feedback

CFOS supplies a read-only `globalThis.CFOS_CONTEXT` object before running gadget client code. Older servers supply `null`; gadgets must keep metadata unavailable rather than infer it from an iframe URL.

The v1 object contains `workspaceId`, `gadgetId`, nullable `chatId`, `view` (`saved` or `chat_preview`), and `clientCodeSha256`. The hash covers the exact UTF-8 client code returned in that UI bundle, not a later workspace head, server code, deployment revision or proof of blueprint adoption. Context stays with the displayed bundle until it reloads. A chat-scoped view is conservatively labelled preview even when no edits are pending.

The shell transports context inside the sandbox's encoded script, without adding a network capability or copying parent URLs, query strings, credentials, user identity or bindings. Existing gadget-use authorization still controls bundle access. Context describes what was rendered; it grants no permissions. If a gadget forwards it to a feedback service, that service must treat it as a client-reported diagnostic claim, separate from independently verified actor, packet and access provenance. A read-only JavaScript property is not a cryptographic attestation.

Feedback consumers should retain these fields alongside element bounds, component IDs, reproduction steps and an immutable feedback receipt. Missing context must remain explicit. Wider shell annotation, authenticated delivery routing, deployment revision and product-agent acceptance are separate capabilities.

## View navigation and tab-local preferences

The host also supplies `globalThis.CFOS_UI_STATE` with `initial`, `save(state, replace = false)` and `subscribe(callback)`. The subscription returns an unsubscribe function. Consumers validate restored state against their own supported views and control values, and handle an absent API on older hosts.

Use this only for navigation and non-secret UI preferences—not form submissions, credentials, ledger state or execution receipts. The host copies at most 4,096 JSON characters and accepts messages only from the current opaque-origin frame with its matching workspace/gadget/chat key. Saved gadgets and chat previews have separate keys. State remains in this browser tab's session storage and history; it is not a server-side or cross-device preference.

A view slug (`[a-z][a-z0-9-]{0,31}`) becomes the scoped `gadgetView` search parameter, preserving the rest of the host URL. Other control state stays out of the URL. Call `save` with `replace = true` for typing, and false for deliberate view/page transitions. Back/Forward restores the historical entry through the callback. Reload uses that entry or the tab-local state; an explicit scoped view URL takes precedence over the stored view. The API grants no navigation outside the current host page and no direct browser-storage access to the sandbox.

Verified locally with the actual GadgetUI component and compiled Workroom v15: selecting Estate updates the host URL and survives reload; returning from Work to Attention with Back restores its search text. Provider RPCs in this verification used an explicit local fixture. Full deployed-workspace verification remains required.

## JSON exports from a sandboxed gadget

`CFOS_DOWNLOAD.json(filename, value)` asks the trusted host to initiate a JSON
file download. Call it directly from an Export button's click handler and await
the returned promise. The host checks the current iframe window and opaque
origin, requires active browser user activation, accepts a plain `.json` filename,
and rejects invalid JSON or content over 2 MB (UTF-8). No URL is fetched and the
iframe sandbox retains its existing restrictions. A resolved promise means the
browser download was initiated, not that the user saved a file to disk. A missing
API or rejected promise must produce visible feedback rather than a silent button.

The host's source check also prevents another gadget from borrowing this frame's
export path. Metadata is not added by the download API: the caller must export its
recorded context, including unavailable fields, without inventing provenance.
