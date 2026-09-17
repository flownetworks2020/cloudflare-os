import {describe, expect, it} from 'vitest';
import {publishedBlueprintVersions} from '../src/blueprint-archive';
import {assertBlueprintUpgradeReviewed, planBlueprintUpgrade, sameBlueprintFiles} from '../src/blueprint-upgrade';

const files = (rows: Record<string, string>) => new Map(Object.entries(rows));
const base = {blueprintId: 'flow.workroom', version: 5, files: files({'client.js': 'old', 'old.js': 'retired'})};
const target = {blueprintId: 'flow.workroom', version: 9, files: files({'client.js': 'new', 'feedback.js': 'module'})};

describe('reviewed blueprint upgrades', () => {
  it('discovers only ledger-backed historical archives when publication versions have gaps', () => {
    const record = {
      metadata: {version: 8},
      versions: [{version: 1}, {version: 3}, {version: 8}, {version: 3}, {version: 99}],
    } as any;
    expect(publishedBlueprintVersions(record)).toEqual([1, 3, 8]);
    expect(publishedBlueprintVersions({metadata: {version: 3}} as any)).toEqual([1, 2, 3]);
  });

  it('recognizes only identical file trees as an inferred base', () => {
    expect(sameBlueprintFiles(base.files, files({'old.js': 'retired', 'client.js': 'old'}))).toBe(true);
    expect(sameBlueprintFiles(base.files, files({'client.js': 'old'}))).toBe(false);
    expect(sameBlueprintFiles(base.files, files({'client.js': 'changed', 'old.js': 'retired'}))).toBe(false);
  });

  it('copies exact published bytes and explicitly records additions and removals', async () => {
    const plan = await planBlueprintUpgrade(base.files, base, target, 1);
    expect(plan.added).toEqual(['feedback.js']);
    expect(plan.modified).toEqual(['client.js']);
    expect(plan.removed).toEqual(['old.js']);
    expect(plan.changes).toEqual([
      ['client.js', {set: 'new'}], ['feedback.js', {set: 'module'}], ['old.js', {remove: true}],
    ]);
    expect(() => assertBlueprintUpgradeReviewed(plan, plan.reviewToken)).not.toThrow();
    expect(base.files.get('client.js')).toBe('old');
  });

  it('detects additions, edits and deletions relative to the installed base', async () => {
    const customized = files({'client.js': 'mine', 'extra.js': 'keep'});
    const plan = await planBlueprintUpgrade(customized, base, target, 1);
    expect(plan.customizedFiles).toEqual(['client.js', 'extra.js', 'old.js']);
    expect(() => assertBlueprintUpgradeReviewed(plan, plan.reviewToken)).toThrow(/customizations/);
  });

  it('invalidates a preview if the current tree or either published archive changes', async () => {
    const preview = await planBlueprintUpgrade(base.files, base, target, 1);
    for (const changed of [
      await planBlueprintUpgrade(base.files, base, target, 2),
      await planBlueprintUpgrade(files({'client.js': 'concurrent'}), base, target, 1),
      await planBlueprintUpgrade(base.files, {...base, files: files({'client.js': 'other'})}, target, 1),
      await planBlueprintUpgrade(base.files, base, {...target, files: files({'client.js': 'other'})}, 1),
    ]) {
      expect(() => assertBlueprintUpgradeReviewed(changed, preview.reviewToken)).toThrow(/changed/);
    }
  });

  it('hashes insertion order consistently and treats prototype-looking filenames as data', async () => {
    const odd = new Map([['__proto__', 'data'], ['client.js', 'old']]);
    const oddBase = {...base, files: odd};
    const a = await planBlueprintUpgrade(odd, oddBase, target, 1);
    const b = await planBlueprintUpgrade(new Map([...odd].toReversed()), oddBase, target, 1);
    expect(a.reviewToken).toBe(b.reviewToken);
    expect(a.removed).toContain('__proto__');
  });

  it('refuses empty, mixed-blueprint and non-increasing sources', async () => {
    await expect(planBlueprintUpgrade(base.files, base, {...target, version: 5}, 1)).rejects.toThrow(/increasing/);
    await expect(planBlueprintUpgrade(base.files, base, {...target, blueprintId: 'other'}, 1)).rejects.toThrow(/same blueprint/);
    await expect(planBlueprintUpgrade(base.files, base, {...target, files: new Map()}, 1)).rejects.toThrow(/empty/);
  });
});
