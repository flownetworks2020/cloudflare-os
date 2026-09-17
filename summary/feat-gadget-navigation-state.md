# Preserve gadget navigation and complete Microsoft reconnect handoffs

## Overview

Sandboxed gadgets cannot preserve the host workspace's navigation by changing their own srcdoc URL. This adds a bounded, frame-scoped host API for selected views and tab-local UI preferences, with a shareable view parameter and Back/Forward restoration.

## Changes

- Supply CFOS_UI_STATE initial state, save and subscription methods beside existing diagnostic context.
- Accept messages only from the current opaque frame and matching workspace/gadget/chat key.
- Keep search and other control values in tab session/history state; only bounded view slugs enter the URL.
- Preserve existing host history fields and query parameters.
- Repair the integration base’s Microsoft reconnect contract: stage grants until the Workshop commits the exact owner-confirmed stage, then return the standard handoff page. Preserve the existing principal check and credential mutex; reject expired, superseded and revoked stages.

## Testing

- Five state tests and thirteen GadgetUI integration tests passed, including wrong-frame/origin/key rejection.
- Frontend type checking and scoped lint passed (one non-blocking test scoping warning).
- The original CI build failed on the inherited Microsoft connector missing commitReconnect. The repair passes all 173 connector tests and its TypeScript check, including inert-before-commit, wrong principal, superseded/expired/revoked stages and browser handoff ticket tests. Required root pnpm lint (including type/build checks) passed.
- Built-in browser verified the actual GadgetUI component with compiled Workroom v15: Estate selection survives reload; Back restores Attention and its search. Provider calls used a local fixture.

## Notes

This targets the Flow-owned fork, not Cloudflare upstream. Workroom consumption and the downstream pinned deployment are separate delivery gates. This change is independent of the v14 production loading repair in Concourse !121. Server-side preferences, cross-device sync, and production acceptance are not claimed.
