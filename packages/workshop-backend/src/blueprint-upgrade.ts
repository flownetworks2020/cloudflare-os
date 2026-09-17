import type { FileChange } from '@gadgets/workshop-shared/code-change';

/** Exact files from one published blueprint version, never model-authored source. */
export interface BlueprintUpgradeSource {
  blueprintId: string;
  version: number;
  files: ReadonlyMap<string, string>;
}

/** Reviewable source delta. Staging still uses the chat's existing accept/revert boundary. */
export interface BlueprintUpgradePlan {
  reviewToken: string;
  currentHash: string;
  targetHash: string;
  customizedFiles: string[];
  added: string[];
  modified: string[];
  removed: string[];
  changes: [string, FileChange][];
}

// Sort entries, not object keys: prototype names and insertion order must not change identity.
async function fingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function entries(files: ReadonlyMap<string, string>): [string, string][] {
  return [...files].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/** Return whether two file trees have the same paths and exact file contents. */
export function sameBlueprintFiles(
    left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([path, content]) => right.get(path) === content);
}

/** Compare the installed tree to its claimed published base and prepare an exact target delta. */
export async function planBlueprintUpgrade(
    current: ReadonlyMap<string, string>, base: BlueprintUpgradeSource,
    target: BlueprintUpgradeSource, gadgetId: number): Promise<BlueprintUpgradePlan> {
  if (base.blueprintId !== target.blueprintId || !Number.isSafeInteger(base.version) ||
      !Number.isSafeInteger(target.version) || base.version < 1 || target.version <= base.version) {
    throw new Error('Choose two increasing published versions of the same blueprint.');
  }
  if (base.files.size === 0 || target.files.size === 0) {
    throw new Error('An empty published archive cannot prove an upgrade.');
  }
  const paths = [...new Set([...current.keys(), ...target.files.keys()])].toSorted();
  const customizedFiles = [...new Set([...current.keys(), ...base.files.keys()])]
    .filter(path => current.get(path) !== base.files.get(path)).toSorted();
  const added: string[] = [], modified: string[] = [], removed: string[] = [];
  const changes: [string, FileChange][] = [];
  for (const path of paths) {
    const before = current.get(path), after = target.files.get(path);
    if (before === after) continue;
    if (after === undefined) {
      removed.push(path);
      changes.push([path, {remove: true}]);
    } else {
      (before === undefined ? added : modified).push(path);
      changes.push([path, {set: after}]);
    }
  }
  const currentHash = await fingerprint(entries(current));
  const targetHash = await fingerprint(entries(target.files));
  const reviewToken = await fingerprint({
    schema: 'blueprint-upgrade.v1', gadgetId, blueprintId: base.blueprintId,
    fromVersion: base.version, toVersion: target.version,
    baseHash: await fingerprint(entries(base.files)), currentHash, targetHash,
  });
  return {reviewToken, currentHash, targetHash, customizedFiles, added, modified, removed, changes};
}

/** Fail closed when either source changed after preview or installed customizations would be lost. */
export function assertBlueprintUpgradeReviewed(plan: BlueprintUpgradePlan, reviewToken: string): void {
  if (plan.reviewToken !== reviewToken) {
    throw new Error('Source changed since the upgrade preview. Inspect the upgrade again.');
  }
  if (plan.customizedFiles.length > 0) {
    throw new Error('Installed files differ from the published base. Review customizations manually.');
  }
}
