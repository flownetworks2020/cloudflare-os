// Apply and reject are declarative here; revert is not. Reject's variance lives inside a handler
// body, which dispatch absorbs; revert's variance lives in record lifecycle, which it cannot -- five
// gatekeepers have five incompatible revert/retention behaviours today, so revert is a facet seam
// whose body is ordinary consumer TypeScript.

import { createLogger } from "@gadgets/backend-utils/logger";
import type { RpcStub } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ApprovalQueue,
} from "@gadgets/workshop-shared/gatekeeper";
import type { SimulationRecord } from "./simulation";
import { SerialTaskQueue } from "./serial-queue";

const logger = createLogger<{ outcome: ResolveOutcome; vendorId: string }>(
  { component: "gatekeeper.actions" });

/** The Durable Object KV surface used by the action journal. */
export type ActionJournalKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
};

/** Storage keys, overridable so a port keeps reading the records it already wrote. */
export type JournalKeys = {
  nextIdKey?: string;
  /** Must not contain `nextIdKey`, which would then be scanned as a record. */
  recordPrefix?: string;
};

/**
 * Where a record sits. `"applied"` exists only in the retained tier; `"claimed"` means a dispatch
 * is in flight against the provider, and `"failed"` that one ended terminally.
 */
type JournalState = "staged" | "pending" | "claimed" | "failed" | "applied";

/** A stored action and where it sits. `error` is present only on a `"failed"` record. */
export type JournalRecord<A> = { state: JournalState; action: A; error?: string };

/** The states `listPending` projects: an in-flight dispatch is still part of the pending world a
 *  read simulates, while `staged` is not yet the overseer's and `failed` must stop projecting. */
const AWAITING_DECISION: readonly JournalState[] = ["pending", "claimed"];

/**
 * Marks a record this journal wrote. What this resource stored before adopting the journal is
 * `{ action, state }` too, with its own discriminants (github's actions key on `type`, not `kind`),
 * so shape alone cannot tell them apart — an unmarked record goes to `upgradeRecord` instead of
 * being trusted as current.
 */
const JOURNAL_VERSION = 1;

type StoredJournalRecord<A> = JournalRecord<A> & { v: typeof JOURNAL_VERSION };

export type ActionJournalOptions<A> = JournalKeys & {
  /** Reads a record written before this gatekeeper adopted the journal. */
  upgradeRecord?(raw: unknown): A;
  /**
   * How many unresolved actions this resource may hold, enforced by `allocate`. Failed records do
   * not count: rejecting one is how it is cleared, so counting them would wedge the queue for a
   * user with nothing left to approve. They are instead bounded by the same number, oldest dropped
   * first, so terminal failures cannot grow the scanned prefix without limit.
   */
  maxPending?: number;
};

/**
 * Durable record of the actions this resource has queued.
 *
 * Two tiers: staged and pending records live under `recordPrefix`, and a retained applied record
 * moves to a sibling prefix, so `listPending()`'s scan stays bounded by genuinely pending records
 * however many applied ones accumulate (the shape github already uses). Lookups check both.
 * Retiring the retained tier is consumer policy -- retention is unbounded and caps are per-vendor.
 */
export class ActionJournal<A> {
  readonly #kv: ActionJournalKv;
  readonly #nextIdKey: string;
  readonly #prefix: string;
  readonly #retainedPrefix: string;
  readonly #upgradeRecord?: (raw: unknown) => A;
  readonly #maxPending?: number;

  constructor(kv: ActionJournalKv, options: ActionJournalOptions<A> = {}) {
    this.#kv = kv;
    this.#nextIdKey = options.nextIdKey ?? "pending:nextActionId";
    this.#prefix = options.recordPrefix ?? "pending:action:";
    // Outside the pending prefix, not beneath it: a retained record must fall out of that scan.
    this.#retainedPrefix = `retained:${this.#prefix}`;
    this.#upgradeRecord = options.upgradeRecord;
    this.#maxPending = options.maxPending;

    // Only ports pass these, and a silent overlap corrupts the keyspace: a counter under the record
    // prefix is scanned as a record, and a record prefix under the retained one un-tiers the scan.
    if (!this.#prefix) throw new Error("recordPrefix must not be empty.");
    if (this.#nextIdKey.startsWith(this.#prefix) || this.#prefix.startsWith(this.#nextIdKey)
      || this.#nextIdKey.startsWith(this.#retainedPrefix)) {
      throw new Error(`nextIdKey "${this.#nextIdKey}" overlaps a record prefix.`);
    }
    if (this.#retainedPrefix.startsWith(this.#prefix)) {
      throw new Error(`recordPrefix "${this.#prefix}" would contain its own retained tier.`);
    }
  }

  /** Reserve the next id and stage the action against it. */
  allocate(action: A): number {
    this.#requireCapacity();
    const id = this.#kv.get<number>(this.#nextIdKey) ?? 1;
    this.#kv.put(this.#nextIdKey, id + 1);
    this.#write(`${this.#prefix}${id}`, { state: "staged", action });
    return id;
  }

  /**
   * The overseer has the action; it is now awaiting a decision. Only a record still staged in the
   * pending tier moves: an auto-approval can apply and retain the record while `submitAction` is
   * still in flight, and stamping "pending" over that would contradict a completed apply.
   */
  markSubmitted(id: number): void {
    this.#transition(id, ["staged"], "pending");
  }

  /** A dispatch is in flight against the provider. Durable, so a later activation can tell an
   *  interrupted apply from one that never started. */
  markClaimed(id: number): void {
    this.#transition(id, ["staged", "pending"], "claimed");
  }

  /** The claimed dispatch failed in a way the user can retry, so the record awaits a decision again. */
  restorePending(id: number): void {
    this.#transition(id, ["claimed"], "pending");
  }

  /**
   * The action failed terminally: it stops projecting into simulation, and `error` becomes the
   * answer every later resolution attempt sees. Only rejecting it clears the record.
   */
  markFailed(id: number, error: string): void {
    this.#transition(id, ["staged", "pending", "claimed"], "failed", error);
  }

  /** Submission failed, so the action was never queued -- unless it was already resolved. */
  rollbackSubmission(id: number): void {
    if (this.#isStaged(id)) this.remove(id);
  }

  /**
   * The record behind an id, in any state, preferring the retained tier. A lookup must never filter
   * by state: the output gate commits the staged record before the `submitAction` RPC can leave, so
   * a record still marked "staged" may already be pending for the overseer. It must prefer the
   * retained copy, because an interrupted `retain` leaves the id in both tiers and the applied
   * record is the true one -- it carries the apply-time artifacts a revert hook reads back.
   */
  get(id: number): JournalRecord<A> | undefined {
    return this.#read(`${this.#retainedPrefix}${id}`) ?? this.#read(`${this.#prefix}${id}`);
  }

  /**
   * Move the record to the retained tier as "applied", optionally replacing the action with one
   * carrying apply-time artifacts. This is the whole post-apply write: one writer, one record.
   *
   * Retained record first, then the delete: a throw does not roll back the implicit transaction
   * (see `credentials.ts`), and this runs just after a provider effect. Losing the record would
   * leave nothing to revert from; a failed delete leaves the id in both tiers, which `get` and
   * `listPending` both resolve in the retained tier's favour, so it still reads as applied
   * everywhere.
   */
  retain(id: number, action?: A): void {
    const record = this.get(id);
    if (!record) return;
    this.#write(`${this.#retainedPrefix}${id}`, {
      state: "applied",
      action: action ?? record.action,
    });
    this.#kv.delete(`${this.#prefix}${id}`);
  }

  /**
   * Forget the id in both tiers. The kit calls this for a rejection and a rolled-back submission;
   * a consumer's own use is retiring its retained tier, which is consumer policy (above).
   */
  remove(id: number): void {
    this.#kv.delete(`${this.#prefix}${id}`);
    this.#kv.delete(`${this.#retainedPrefix}${id}`);
  }

  /**
   * True when this id has been applied and retained. Reads through the same coercion as every other
   * lookup: a value this journal would refuse to return from `get()` must not be reported as a
   * retained record either, or the two answers disagree about whether the action exists.
   */
  isRetained(id: number): boolean {
    return this.#read(`${this.#retainedPrefix}${id}`) !== undefined;
  }

  /** Actions awaiting a decision, ascending — the input `createSimulationView` expects. */
  listPending(): SimulationRecord<A>[] {
    const pending: SimulationRecord<A>[] = [];
    for (const [key, raw] of this.#kv.list<unknown>({ prefix: this.#prefix })) {
      const record = this.#coerce(raw);
      if (record === undefined || !AWAITING_DECISION.includes(record.state)) continue;
      const id = this.#idFrom(key);
      // A record left behind by an interrupted `retain` is applied, not pending: projecting it
      // would simulate an effect the provider has already made real.
      if (id === undefined || this.isRetained(id)) continue;
      pending.push({ id, action: record.action });
    }
    return pending.toSorted((a, b) => a.id - b.id);
  }

  /**
   * Enforce `maxPending` before an allocation, and bound the terminal failures sitting beside the
   * unresolved records. One scan does both, and the scan is bounded by what it enforces.
   *
   * Failed records deliberately do not count against the cap -- rejecting one is how it is cleared,
   * and counting them would wedge the queue for a user with nothing left to approve -- but they do
   * live under the scanned prefix, so left alone a run of terminal failures would grow every future
   * scan without limit. Past the same bound the oldest are dropped: the newest failure is the one
   * the user still has on screen.
   */
  #requireCapacity(): void {
    const max = this.#maxPending;
    if (max === undefined) return;

    let unresolved = 0;
    const failed: number[] = [];
    for (const [key, raw] of this.#kv.list<unknown>({ prefix: this.#prefix })) {
      const state = this.#coerce(raw)?.state;
      if (state === undefined) continue;
      const id = this.#idFrom(key);
      if (state === "failed") {
        if (id !== undefined) failed.push(id);
      } else if (id === undefined || !this.isRetained(id)) {
        // An interrupted `retain` leaves an applied record here too, and the retained tier decides
        // as it does for `get` and `listPending`. Counted, it would hold a slot for good.
        unresolved += 1;
      }
    }
    if (unresolved >= max) {
      throw new Error(
        "Too many pending actions; approve or reject some in the approval queue first.");
    }
    // Guarded, because a negative end counts back from the array's own length: under the bound,
    // `slice(0, -n)` would drop the oldest failures the user is still owed an answer for.
    const excess = failed.length - max;
    if (excess > 0) {
      for (const id of failed.toSorted((a, b) => a - b).slice(0, excess)) this.remove(id);
    }
  }

  /** The id a scanned record key names, or undefined when the key is not one this journal wrote. */
  #idFrom(key: string): number | undefined {
    const id = Number(key.slice(this.#prefix.length));
    return Number.isInteger(id) ? id : undefined;
  }

  /**
   * Rewrite a pending-tier record that is in one of `from`. A record in any other state is left
   * alone, which is what keeps a resolved or terminally failed one from being revived.
   */
  #transition(id: number, from: JournalState[], next: JournalState, error?: string): void {
    const key = `${this.#prefix}${id}`;
    const record = this.#read(key);
    if (record === undefined || !from.includes(record.state)) return;
    const { action } = record;
    this.#write(key, error === undefined ? { state: next, action } : { state: next, action, error });
  }

  #isStaged(id: number): boolean {
    return this.#read(`${this.#prefix}${id}`)?.state === "staged";
  }

  #write(key: string, record: JournalRecord<A>): void {
    this.#kv.put<StoredJournalRecord<A>>(key, { ...record, v: JOURNAL_VERSION });
  }

  #read(key: string): JournalRecord<A> | undefined {
    return this.#coerce(this.#kv.get<unknown>(key));
  }

  #coerce(raw: unknown): JournalRecord<A> | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    if ("v" in raw && raw.v === JOURNAL_VERSION) {
      // The marker is storage detail; callers see the record only.
      const { state, action, error } = raw as StoredJournalRecord<A>;
      return error === undefined ? { state, action } : { state, action, error };
    }
    // Anything else was written by whatever this gatekeeper stored before adopting the journal,
    // and since it only kept records awaiting approval, it was pending.
    const upgraded = this.#upgradeRecord?.(raw);
    return upgraded === undefined ? undefined : { state: "pending", action: upgraded };
  }
}

/**
 * Queue an action for approval: stage it, submit it, and mark it pending. A failed submission is
 * rolled back, so a rejected submission leaves nothing behind for simulation to overlay.
 */
export async function stageAction<A>(
  journal: ActionJournal<A>,
  queue: RpcStub<ApprovalQueue>,
  action: A,
  description: ActionDescription,
): Promise<number> {
  const id = journal.allocate(action);
  try {
    await queue.submitAction(id, description);
  } catch (error) {
    journal.rollbackSubmission(id);
    throw error;
  }
  journal.markSubmitted(id);
  return id;
}

/**
 * Thrown from an `apply` handler to record a terminal, non-replayable failure. The message is
 * display-safe and becomes the stored answer every later resolution attempt sees, and the record
 * stops projecting into simulation; an ordinary throw leaves the action retryable instead.
 *
 * From a `reject` handler it carries no special meaning: reject handlers do no irreversible
 * provider writes, so they have nothing to declare terminal.
 */
export class ActionApplyError extends Error {
  /** What the provider is known to have done, for the consumer composing the user-visible text. */
  readonly effect: "unknown" | "partial" | "none";

  constructor(
    message: string,
    options?: { effect?: "unknown" | "partial" | "none"; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.effect = options?.effect ?? "unknown";
  }
}

/** The stored answer for a claim an activation died holding: the call went out, and nothing here
 *  can say whether the provider ran it. */
export const APPLY_OUTCOME_UNKNOWN_MESSAGE = "This action was interrupted after it was dispatched, "
  + "so it may or may not have taken effect. Check the provider before submitting it again.";

/**
 * What a reject handler reports back to the overseer. `restart: true` asks it to re-run the agent
 * turn that submitted the action, which is how a gatekeeper says "the decision changed the state
 * the agent was reasoning about".
 */
export type RejectResult = void | { restart?: boolean };

/** How one kind of action is described to the approver and carried out once approved. */
export type ActionDefinition<Payload, Host> = {
  kind?: ActionKind;
  /** Whether this kind may ever be auto-applied. The binding per-action verdict stays on each
   *  submitted `ActionDescription`. */
  autoApprovable?: boolean;
  /**
   * Claim the record durably before the handler runs; opt in for an irreversible provider call. A
   * plain thrown error then means the handler classified the failure retryable and the claim is
   * rolled back, an `ActionApplyError` means terminal, and a crash mid-handler leaves a claim a
   * later activation converts into a terminal unknown-outcome failure rather than re-running it.
   */
  claimBeforeApply?: boolean;
  /** Returns `{ action }` to persist apply-time artifacts (created entity ids and the like). */
  apply(payload: Payload, host: Host): Promise<void | { action?: Payload }>;
  reject?(payload: Payload, host: Host): Promise<RejectResult>;
};

/** How a resolution ended, for cache invalidation. */
export type ResolveOutcome = "applied" | "rejected" | "failed" | "reverted";

/** Cross-cutting policy for a whole action set, as opposed to one kind's behavior. */
export type ActionSetOptions<Host> = {
  /** Keep the applied record so a revert can read it back. The facet derives this from its own
   *  revert hook; set it explicitly only to retain without one. */
  retainApplied?: boolean;
  /**
   * Fires once per resolution, so cache invalidation lives in one place instead of every branch.
   * Advisory: a failure here is logged and dropped, never surfaced to the overseer.
   */
  afterResolve?(host: Host, outcome: ResolveOutcome): void | Promise<void>;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/** A journal entry tagged with the kind that knows how to resolve it. */
export type TaggedAction<M> = { [K in keyof M]: { kind: K; payload: M[K] } }[keyof M];

/** The action set bound to one resource's journal and host. */
export type BoundActionSet<M extends Record<string, unknown>> = {
  submit<K extends keyof M>(
    queue: RpcStub<ApprovalQueue>,
    kind: K,
    payload: M[K],
    description: ActionDescription,
  ): Promise<number>;
  /**
   * Resolution is serialized: the overseer can deliver two callbacks for one id concurrently, since
   * it validates that a record is still pending and then awaits before dispatching, with the Durable
   * Object's input gate open across that await (`overseer.ts:9485-9495`, and its own comment on
   * `applyPendingAction` says the caller is responsible for the check). Without this the journal
   * check would be a time-of-check/time-of-use window around a provider call, i.e. a double effect.
   *
   * Resolves without effect for an already-applied id, so the overseer's retry in a later
   * activation settles instead of reporting a failure the user cannot act on.
   */
  apply(id: number): Promise<void>;
  reject(id: number): Promise<RejectResult>;
  autoApprovableKinds(): ActionKind[];
  /** The retention flag in force, which the facet base's revert-hook assert reads. */
  readonly retainsApplied: boolean;
  /** Reports an outcome the facet resolved itself, so `afterResolve` still covers every site. */
  resolved(outcome: ResolveOutcome): Promise<void>;
  /**
   * The queue `apply` and `reject` run on, exposed because revert is a facet seam (§5.9) and must
   * be mutually exclusive with them — a second queue beside this one would serialize each pair but
   * leave apply-vs-revert interleaved, which is the pair that reads back what the other rewrote.
   *
   * Run a revert hook as `actions.queue.run(hook)`. Never call `apply`/`reject` from inside a
   * `run` callback: they claim this same queue and would wait on their own predecessor.
   */
  readonly queue: SerialTaskQueue;
};

/**
 * A declared action set, still unbound: the declarations are module-scoped while the journal and
 * host belong to one resource facet, so `bind` is what a per-instance facet calls to get the
 * submission and resolution surface for its own storage.
 */
export type ActionSet<Host, M extends Record<string, unknown>> = {
  bind(journal: ActionJournal<TaggedAction<M>>, host: Host): BoundActionSet<M>;
};

/**
 * Declare a resource's actions once; the returned set owns submission and the overseer's
 * apply/reject callbacks, leaving each definition to describe only its own effect.
 *
 * Apply is at-least-once by default: the provider call can succeed and the process crash before the
 * journal write, and the overseer's retry then re-applies. A definition that sets
 * `claimBeforeApply` gets at-most-once instead — the claim is durable, so the retry reports an
 * unknown outcome rather than repeating an irreversible call.
 */
export function defineActions<Host, M extends Record<string, unknown>>(
  definitions: { [K in keyof M]: ActionDefinition<M[K], Host> },
  options: ActionSetOptions<Host> = {},
): ActionSet<Host, M> {
  const labelByTag = new Map<string, string>();
  for (const [name, definition] of Object.entries(definitions) as [string, ActionDefinition<unknown, Host>][]) {
    // Without a declared kind the action carries a caller-supplied tag, so it could ride an opt-in
    // the user granted a sibling sharing that tag — while never appearing in the reported set.
    if (definition.autoApprovable === true && !definition.kind) {
      throw new Error(`Action "${name}" declares autoApprovable without a kind.`);
    }
    if (definition.kind === undefined) continue;

    // Siblings may share a tag to be governed as one group, but then the label has to describe the
    // group: the catalog advertises one label per tag, so a second spelling would put a name in the
    // approval UI that does not cover everything enabling that tag authorizes.
    const { tag, label } = definition.kind;
    const declared = labelByTag.get(tag);
    if (declared === undefined) labelByTag.set(tag, label);
    else if (declared !== label) {
      throw new Error(`Action tag "${tag}" is declared with two labels, "${declared}" and "${label}".`);
    }
  }

  return {
    bind(journal, host) {
      // TypeScript cannot correlate a tagged union's payload with its definition, so the dispatcher
      // is the one place that erases the payload type.
      const definitionFor = (entry: TaggedAction<M>) =>
        definitions[entry.kind] as ActionDefinition<unknown, Host>;

      /**
       * Ids this instance applied, for a non-retaining set where the journal keeps no trace.
       *
       * The overseer can deliver approve and reject for one id concurrently (`overseer.ts:9622`),
       * and a reject finding no record would report success for an action the provider ran. In
       * memory because the other reject-on-missing case -- the overseer's retry after crashing
       * before its own state write -- must still no-op, and that retry is a later activation while
       * this race needs both calls in flight in one.
       */
      const appliedHere = new Set<number>();

      /**
       * Ids this activation claimed. A claimed record missing from here was orphaned by an
       * activation that died mid-dispatch: the provider call went out and its outcome is unknowable,
       * so no verb may run a handler over it. In memory for the same reason as `appliedHere`.
       */
      const claimedHere = new Set<number>();

      /**
       * The record behind an id when the overseer may still decide on it, or undefined when none
       * exists. An id this instance applied is refused as decided rather than reported unknown: for
       * a set that keeps no record it is the only trace that the provider ran.
       */
      const pendingRecord = (id: number): JournalRecord<TaggedAction<M>> | undefined => {
        const record = journal.get(id);
        if (record === undefined && appliedHere.has(id)) {
          throw new Error(`Action ${id} is no longer pending.`);
        }
        return record;
      };

      // One queue per bound resource, covering every resolution of it -- and the facet's revert
      // hook, which joins through the exposed `queue` field. `submit` deliberately stays off it:
      // submission is not a resolution, and queueing it behind a slow apply would stall the agent
      // for the length of a provider call.
      const resolutionQueue = new SerialTaskQueue();

      /**
       * Fire the invalidation hook. Awaited, so a read after this resolution sees fresh caches --
       * but its failure never escapes: the hook is advisory, and letting it throw would either
       * replace a provider's display-safe error or report a completed action as failed.
       */
      const attributed = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
      const resolved = async (outcome: ResolveOutcome) => {
        try {
          await options.afterResolve?.(host, outcome);
        } catch (error) {
          attributed.error("afterResolve hook failed", {
            event: "actions.afterResolve.failed",
            outcome,
            error,
          });
        }
      };

      /** Convert an orphaned claim into a terminal failure. Both verbs refuse it the same way: a
       *  quiet remove would hide from the user that the effect may already have happened. */
      const failOrphanedClaim = async (id: number): Promise<never> => {
        journal.markFailed(id, APPLY_OUTCOME_UNKNOWN_MESSAGE);
        await resolved("failed");
        throw new Error(APPLY_OUTCOME_UNKNOWN_MESSAGE);
      };

      return {
        submit: (queue, kind, payload, description) => stageAction(
          journal,
          queue,
          { kind, payload } as TaggedAction<M>,
          {
            ...description,
            // Declaration wins on `autoApprovable`, which is the AND of both, so a call-site verdict
            // may only narrow what the kind declared -- siblings may share a tag, and an opt-in the
            // user granted one kind must not carry another. `actionKind` falls back to the call
            // site when the definition declares none, which is safe only because `defineActions`
            // rejects `autoApprovable` without a `kind`: a kindless definition is always forced to
            // false above, so a caller-supplied tag can never ride an opt-in.
            actionKind: definitions[kind].kind ?? description.actionKind,
            autoApprovable: definitions[kind].autoApprovable === true
              && description.autoApprovable === true,
          },
        ),

        apply: id => resolutionQueue.run(async () => {
          // Idempotent for the overseer's retry in a later activation: the effect and the journal
          // write both happened, so there is nothing left to do and nothing to invalidate.
          if (journal.isRetained(id)) return;

          const record = pendingRecord(id);
          if (record === undefined) throw new Error(`Unknown pending action: ${id}`);
          // A terminal failure answers every later attempt with the same message, no provider call.
          if (record.state === "failed") {
            throw new Error(record.error ?? "This action already failed and cannot be retried.");
          }
          if (record.state === "claimed" && !claimedHere.has(id)) return failOrphanedClaim(id);

          const action = record.action;
          const definition = definitionFor(action);
          try {
            let result: void | { action?: unknown };
            try {
              if (definition.claimBeforeApply) {
                journal.markClaimed(id);
                claimedHere.add(id);
              }
              result = await definition.apply(action.payload, host);
            } catch (error) {
              // Only the handler is caught. Caches are at their stalest here either way: the
              // provider may have applied part of the effect. A terminal failure stores its own
              // message; anything else is left retryable, and rolling the claim back is what lets
              // a second dispatch reach the provider.
              if (error instanceof ActionApplyError) journal.markFailed(id, error.message);
              else journal.restorePending(id);
              await resolved("failed");
              throw error;
            }

            // One write: the artifacts the handler returned, merged with the state transition. A
            // failure here is deliberately outside the catch above: the provider effect has landed,
            // so restoring `pending` would offer the user a second irreversible apply. The claim
            // stays, and the next attempt reports the unknown outcome.
            const applied = result?.action === undefined
              ? undefined
              : { kind: action.kind, payload: result.action } as TaggedAction<M>;
            if (options.retainApplied) journal.retain(id, applied);
            else journal.remove(id);
            appliedHere.add(id);
            await resolved("applied");
          } finally {
            claimedHere.delete(id);
          }
        }),

        reject: id => resolutionQueue.run(async () => {
          // The retained record is what a revert hook reads back, so a stray reject must not take
          // it: unlike apply, this one has no idempotent reading.
          if (journal.isRetained(id)) throw new Error(`Action ${id} is no longer pending.`);

          const record = pendingRecord(id);
          if (record === undefined) return;
          if (record.state === "failed") {
            // Nothing to undo, so rejecting a terminal failure is the user clearing the record.
            journal.remove(id);
            await resolved("rejected");
            return;
          }
          if (record.state === "claimed" && !claimedHere.has(id)) return failOrphanedClaim(id);

          const action = record.action;
          let result: RejectResult;
          try {
            result = await definitionFor(action).reject?.(action.payload, host);
          } catch (error) {
            // Same reasoning as a failed apply: the handler may have half-changed simulation state.
            await resolved("failed");
            throw error;
          }
          journal.remove(id);
          await resolved("rejected");
          return result;
        }),

        autoApprovableKinds: () => {
          // One entry per tag. Which sibling supplies it does not matter: `defineActions` rejected
          // a tag whose siblings disagreed about the label.
          const byTag = new Map<string, ActionKind>();
          for (const definition of Object.values(definitions)) {
            if (definition.autoApprovable === true && definition.kind) {
              byTag.set(definition.kind.tag, definition.kind);
            }
          }
          return [...byTag.values()];
        },

        retainsApplied: options.retainApplied === true,

        resolved,

        queue: resolutionQueue,
      };
    },
  };
}
