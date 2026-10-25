import type { FileSystem, Path } from "effect";
import { Context, Effect, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import type { DgpuConfig } from "./config.js";
import { isSourceEntryId, launchEntry, reconcileEntries } from "./entry.js";
import type { EntryStatus, Reconciled } from "./entry.js";
import { DgpuError } from "./errors.js";
import {
  assignedDgpuIds,
  readRegistry,
  setAssignment,
  writeRegistry,
} from "./registry.js";

export type { EntryStatus } from "./entry.js";

export interface Snapshot {
  /** The status of each source entry id that was asked about, in order. */
  readonly statuses: ReadonlyMap<string, EntryStatus>;
  /** Entries the reconcile before the snapshot could not update. */
  readonly failures: readonly DgpuError[];
}

export interface DgpuService {
  /**
   * Reconciles, then reports the status of each id in `entryIds` that names a
   * source entry. Other ids, such as dGPU entries themselves, are left out.
   */
  readonly snapshot: (
    entryIds: readonly string[]
  ) => Effect.Effect<Snapshot, DgpuError>;
  /** Reconciles, and fails if any dGPU entry could not be updated. */
  readonly reconcile: Effect.Effect<void, DgpuError>;
  /** Assigns or unassigns one app, reconciles, and returns its status. */
  readonly set: (
    entryId: string,
    on: boolean
  ) => Effect.Effect<EntryStatus, DgpuError>;
  /** Starts the app from its dGPU entry. Fails if it has none. */
  readonly launch: (entryId: string) => Effect.Effect<void, DgpuError>;
}

const failOnFailures = (reconciled: Reconciled) =>
  reconciled.failures.length === 0
    ? Effect.void
    : Effect.fail(
        DgpuError.make({
          message: reconciled.failures.map((error) => error.message).join("; "),
          cause: reconciled.failures,
        })
      );

/**
 * Filesystem-backed dGPU domain service. The Vicinae command and the CLI both
 * use this service, so there is one implementation of the registry and dGPU
 * entry rules.
 */
export class Dgpu extends Context.Service<Dgpu, DgpuService>()(
  "@vicinae-dgpu/core/dgpu"
) {
  public static readonly layer = Layer.effect(
    Dgpu,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        | DgpuConfig
        | FileSystem.FileSystem
        | Path.Path
        | ChildProcessSpawner.ChildProcessSpawner
      >();

      const reconcileRegistry = readRegistry.pipe(
        Effect.map(assignedDgpuIds),
        Effect.flatMap(reconcileEntries)
      );

      const snapshot = Effect.fn("Dgpu.snapshot")(function* (
        entryIds: readonly string[]
      ) {
        const reconciled = yield* reconcileRegistry;
        const statuses = new Map<string, EntryStatus>();

        for (const entryId of entryIds) {
          if (isSourceEntryId(entryId)) {
            statuses.set(entryId, reconciled.statuses.get(entryId) ?? "none");
          }
        }

        const result: Snapshot = { statuses, failures: reconciled.failures };

        return result;
      }, Effect.provideContext(context));

      const reconcile = reconcileRegistry.pipe(
        Effect.flatMap(failOnFailures),
        Effect.withSpan("Dgpu.reconcile"),
        Effect.provideContext(context)
      );

      const set = Effect.fn("Dgpu.set")(function* (
        entryId: string,
        on: boolean
      ) {
        if (on && !isSourceEntryId(entryId)) {
          return yield* DgpuError.make({
            message: `${entryId} is not a source desktop entry id`,
          });
        }

        const next = setAssignment(yield* readRegistry, entryId, on);

        if (next.changed) {
          yield* writeRegistry(next.registry);
        }

        const reconciled = yield* reconcileEntries(
          assignedDgpuIds(next.registry)
        );

        yield* failOnFailures(reconciled);

        const status: EntryStatus = reconciled.statuses.get(entryId) ?? "none";

        return status;
      }, Effect.provideContext(context));

      return Dgpu.of({
        snapshot,
        reconcile,
        set,
        launch: (entryId) =>
          launchEntry(entryId).pipe(
            Effect.withSpan("Dgpu.launch"),
            Effect.provideContext(context)
          ),
      });
    })
  );
}
