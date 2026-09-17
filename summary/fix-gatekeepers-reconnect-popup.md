# CFOS: preserve the Flow Workgraph reconnect handoff

## Overview

An expired gatekeeper account can leave the operator on Gatekeepers after clicking Reconnect: the UI waits for an RPC response before opening the OAuth tab, so the browser may no longer treat it as a user-initiated popup. Reserve the tab during the click and navigate it when the URL arrives. If an embedded browser blocks the tab, continue the handoff in the current tab.

## Changes

### Gatekeepers
- Reserve a blank tab before awaiting `reconnectAccount`, clear its opener, and navigate it to the returned URL.
- Use same-tab navigation when the browser blocks the popup; close a reserved tab if the RPC fails and retain the existing error toast.
- Cover delayed RPC completion, blocked popup fallback, and RPC failure.

## Testing

- Frontend Vitest suite: 286 tests passed with Node experimental web storage disabled for this repo's test environment.
- Frontend TypeScript check, scoped lint, and production frontend build passed.

## Notes

This PR targets the Flow Networks fork only. Production reconnect acceptance requires merging, deploying the fork release, and completing the expired-account journey in the built-in browser. No credentials or gatekeeper permissions change in this patch.
