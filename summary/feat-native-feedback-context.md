# Expose exact gadget UI context for feedback

Feedback inside an isolated gadget cannot identify its enclosing workspace, gadget or chat from its URL. Return diagnostic context with the exact UI bundle and expose it as read-only globalThis.CFOS_CONTEXT before client code runs. Include workspace/gadget IDs, nullable chat ID, saved versus chat-preview scope and SHA-256 of the returned client bytes. Older servers remain explicitly unknown.

The hash is not a deployment revision, server-code hash or proof of saved blueprint adoption. No new capabilities, parent URL/query capture, credentials, bindings or user identity are exposed. Forwarded context is a client-reported diagnostic claim, separate from authenticated feedback provenance.

Validation: 12 GadgetUI integration tests pass; rebuilt native Worker integration tests pass for saved/preview context and the existing reviewed upgrade flow (2 tests); integration type check and full lint/build pass. The native test proves differing preview bytes/hash without changing the saved head. Browser production adoption and full feedback routing remain pending.

Stacked on feat/reviewed-blueprint-upgrade (fork PR #1). This PR contains only native context transport and tests/docs. The downstream Concourse feedback consumer is maintained in GitLab !110; its rollout still needs a reviewed CFOS pin update after this dependency lands.

CI follow-up: corrected the frontend fixture to use CFOS numeric WorkpieceId (zero is valid). Explicit workshop-frontend tsc --noEmit and all 12 GadgetUI tests pass. The initial remote build caught this test-type mismatch; production acceptance remains pending.
