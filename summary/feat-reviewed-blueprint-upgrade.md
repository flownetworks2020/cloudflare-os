# Stage exact blueprint upgrades through existing gadget change review

## Overview

Publishing a new blueprint leaves existing gadgets on their old code. Add a native agent tool that previews and stages exact published files on the existing gadget through CFOS's established change-review flow.

## Changes

- Compare installed files against an exact published base and target; disclose added, modified, removed and customized files.
- Bind preview fingerprints to the gadget and every source tree. Refuse staging after drift or when customizations would be overwritten.
- Stage one atomic code change with the existing commit pin, step barrier and accept/revert behavior. Preserve gadget identity and bindings without migrating application storage.
- Record the tool result for history replay without fetching mutable external source again; reuse existing tool-summary UI.

## Testing

- Backend build and frontend build passed.
- Backend suite: 840 tests passed; integration suite: 3 passed, 4 skipped.
- Focused upgrade and real durable change-review tests: 50 passed.
- Repaired two inherited test-only lint errors: an unused import and an untyped mock. Workspace lint passed. The two affected test files passed (2 tests each); frontend jsdom verification used NODE_OPTIONS=--no-experimental-webstorage to avoid Node 26 shadowing its localStorage.

- Native agent/WebSocket integration now also passes: publishes real v1/v2 archives, previews without staging, resumes the same chat to stage, accepts exact additions/modifications/deletions, retains original commit/history and persisted gadget data, and refuses stale tokens and locally customized source. The model is scripted; this verifies runtime behavior, not model judgment.

## Notes

Stacked against the currently deployed integration branch `feat/fco-hx1fa-cloudflare-os` at 2d41699, preserving Flow's existing managed-agent changes. This is not an upstream-main migration. Native browser verification and downstream Concourse pin deployment remain pending. Missing historical archives fail closed; customized instances require a separately reviewed merge. Code rollback preserves history but cannot undo later application data writes.
