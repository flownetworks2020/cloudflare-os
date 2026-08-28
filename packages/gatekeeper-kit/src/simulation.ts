/** One action journal entry visible to simulation. */
export type SimulationRecord<Action> = {
  readonly id: number;
  readonly action: Action;
};

/** An immutable, chronologically ordered view of simulation records. */
export type SimulationView<Action, Target> = {
  /** Every visible record in action ID order. */
  readonly all: () => readonly SimulationRecord<Action>[];
  /** Records affecting `target` in action ID order. */
  readonly forTarget: (target: Target) => readonly SimulationRecord<Action>[];
};

/**
 * Sort a journal snapshot once and index each action under every target it affects. The caller owns
 * target extraction and canonicalization, including provisional-to-provider ID resolution.
 *
 * The returned arrays are frozen, but the records in them are the caller's: this indexes them, it
 * does not copy them. Feed it a fresh snapshot (`journal.listPending()` mints one per call) and do
 * not mutate records afterwards, or the order and target index stop describing them. Nested action
 * values stay consumer-owned throughout.
 */
export function createSimulationView<Action, Target>(
  records: readonly SimulationRecord<Action>[],
  targets: (action: Action) => Iterable<Target>,
): SimulationView<Action, Target> {
  const all = Object.freeze(records.toSorted((a, b) => a.id - b.id));
  const byTarget = new Map<Target, SimulationRecord<Action>[]>();

  for (const record of all) {
    const seen = new Set<Target>();
    for (const target of targets(record.action)) {
      if (seen.has(target)) continue;
      seen.add(target);
      const indexed = byTarget.get(target);
      if (indexed) indexed.push(record);
      else byTarget.set(target, [record]);
    }
  }

  for (const recordsForTarget of byTarget.values()) Object.freeze(recordsForTarget);
  const empty: readonly SimulationRecord<Action>[] = Object.freeze([]);
  return Object.freeze({
    all: () => all,
    forTarget: (target: Target) => byTarget.get(target) ?? empty,
  });
}

/** The outcome of projecting one relevant action onto a simulated value. */
export type SimulationStep<State> =
  | { kind: "applied"; value: State }
  | { kind: "known-no-effect" }
  | { kind: "unsupported"; reason: string };

/** The complete or explicitly incomplete result of ordered action replay. */
export type SimulationResult<State, Action> =
  | { kind: "complete"; value: State; appliedCount: number }
  | {
      kind: "incomplete";
      value: State;
      appliedCount: number;
      unsupported: SimulationRecord<Action>;
      reason: string;
    };

/**
 * Replay relevant actions in order. A known non-effect is skipped; an unsupported effect stops
 * replay so later actions are never projected onto a state already known to be wrong.
 *
 * `apply` must return the next value rather than mutate the one it was handed: `appliedCount` and
 * the `incomplete` result describe how far the fold got, and an in-place reducer makes both lie.
 */
export function replaySimulation<State, Action>(
  base: State,
  records: readonly SimulationRecord<Action>[],
  apply: (state: State, record: SimulationRecord<Action>) => SimulationStep<State>,
): SimulationResult<State, Action> {
  let value = base;
  let appliedCount = 0;
  for (const record of records) {
    const step = apply(value, record);
    if (step.kind === "unsupported") {
      return { kind: "incomplete", value, appliedCount, unsupported: record, reason: step.reason };
    }
    if (step.kind === "applied") {
      value = step.value;
      appliedCount += 1;
    }
  }
  return { kind: "complete", value, appliedCount };
}

/** The synchronous Durable Object KV surface used by provisional IDs. */
export type SimulationKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

/** Allocates durable provisional IDs and retains their provider-ID bindings. */
export class ProvisionalIds<Id extends string> {
  readonly #kv: SimulationKv;
  readonly #namespace: string;
  readonly #isProvisional?: (id: Id) => boolean;

  constructor(
    kv: SimulationKv,
    options: { namespace: string; isProvisional?(id: Id): boolean },
  ) {
    this.#kv = kv;
    this.#namespace = options.namespace;
    this.#isProvisional = options.isProvisional;
  }

  /**
   * Allocate the next monotonic provisional ID using the provider's formatter.
   *
   * When `isProvisional` is supplied it is enforced here, at the one point where a provisional ID
   * enters the system: a formatter whose output the classifier does not recognise mints IDs
   * indistinguishable from real provider ones, and `resolve()` would then hand an unbound
   * provisional ID straight to the provider as if it were ready. Cheaper to reject the formatter
   * than to diagnose that.
   *
   * `kind` records the logical entity type so later references can reject cross-kind mistakes
   * before they reach the provider.
   */
  allocate(format: (sequence: number) => Id, options?: { kind?: string }): Id {
    const key = `${this.#namespace}seq:provisional`;
    const sequence = this.#kv.get<number>(key) ?? 1;
    const id = format(sequence);
    if (this.#isProvisional?.(id) === false) {
      throw new Error(
        `Formatter produced ${id}, which isProvisional does not classify as provisional.`);
    }
    this.#kv.put(key, sequence + 1);
    if (options?.kind !== undefined) {
      this.#kv.put(`${this.#namespace}kind:${id}`, options.kind);
    }
    return id;
  }

  /**
   * Persist the provider ID assigned when a provisional creation is applied.
   *
   * The pair is checked in both directions where a classifier exists: binding a real ID as the key
   * would shadow a provider ID for every later `resolve()`, and binding a provisional ID as the
   * value would resolve one provisional to another and defeat `requireResolved`.
   *
   * Rebinding to a different provider ID throws, because apply is at-least-once: a create whose
   * journal write was lost is re-applied, and the provider answers with a *second* entity. Silently
   * taking the newer one would retarget every queued action that resolves this provisional and
   * orphan the entity the earlier apply created -- a duplicate the user can see and delete beats a
   * mutation aimed at the wrong resource. Rebinding the same ID is that retry's ordinary path and
   * stays a no-op.
   */
  bind(provisional: Id, real: Id): void {
    if (this.#isProvisional !== undefined) {
      if (!this.#isProvisional(provisional)) {
        throw new Error(`Cannot bind ${provisional}: it is not a provisional ID.`);
      }
      if (this.#isProvisional(real)) {
        throw new Error(`Cannot bind ${provisional} to ${real}: the target is also provisional.`);
      }
    }
    const key = `${this.#namespace}prov:${provisional}`;
    const bound = this.#kv.get<Id>(key);
    if (bound !== undefined) {
      if (bound === real) return;
      throw new Error(`${provisional} is already bound to ${bound}, not ${real}.`);
    }
    this.#kv.put(key, real);
  }

  /** Resolve a bound provisional ID; return any unbound or provider ID unchanged. */
  resolve(id: Id): Id {
    return this.#kv.get<Id>(`${this.#namespace}prov:${id}`) ?? id;
  }

  /** Whether this ID has a persisted provisional-to-provider binding. */
  isResolved(id: Id): boolean {
    return this.#kv.get<Id>(`${this.#namespace}prov:${id}`) !== undefined;
  }

  /** Reads the durable kind so callers can stop cross-kind references before provider I/O. */
  kindOf(id: Id): string | undefined {
    return this.#kv.get<string>(`${this.#namespace}kind:${id}`);
  }

  /**
   * The provider ID for `id`, or a throw when it names a creation the provider has not applied yet.
   * `resolve` cannot distinguish an unbound provisional from a real ID, so anything about to be
   * sent to the provider goes through here — which needs `isProvisional` to tell them apart.
   *
   * `expectedKind` rejects a tagged ID of the wrong logical type before resolution, keeping a
   * mistyped reference from becoming an inexplicable provider error. Untagged IDs skip this guard.
   */
  requireResolved(id: Id, options?: { expectedKind?: string }): Id {
    if (options?.expectedKind !== undefined) {
      const actual = this.kindOf(id);
      if (actual !== undefined && actual !== options.expectedKind) {
        throw new Error(`${id} is a ${actual}, not a ${options.expectedKind}.`);
      }
    }
    const bound = this.#kv.get<Id>(`${this.#namespace}prov:${id}`);
    if (bound !== undefined) return bound;
    if (this.#isProvisional === undefined) {
      throw new Error("requireResolved needs an isProvisional predicate to classify unbound IDs.");
    }
    if (this.#isProvisional(id)) {
      throw new Error(`${id} has not been created yet, so it cannot be used against the provider.`);
    }
    return id;
  }
}
