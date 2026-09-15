# Rehearse restoring a gadget after a reviewed blueprint upgrade

## Overview

The upgrade test proved acceptance and retained history, but did not exercise source restoration. Extend the native Workshop integration test to restore the exact previous files through a new review while preserving gadget identity, the upgrade conversation and later application data.

## Changes

- Restore removed and modified files and remove upgrade-added files through submitCodeChange and mergeChanges.
- Prove staging leaves the installed head unchanged until acceptance.
- Reconnect to the restored gadget and read data written after the upgrade.
- Document the source restoration path and distinguish it from kernel or data rollback.

## Testing

- Rebuilt integration harness; both workshop-blueprint-upgrade tests passed.
- Integration TypeScript build and full pnpm lint passed.

## Notes

Tests and documentation only; no runtime source, API, dependency or deployed pin changes. This is synthetic native runtime evidence, not production browser acceptance or older-kernel compatibility proof. Existing Concourse !110/!111 delivery does not need to wait for this test-only follow-up.
