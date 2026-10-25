import type { FileSystem } from "effect";
import { Context, Effect, Layer, Path } from "effect";

import { DgpuConfig } from "./config.js";
import { entryFilename, reconcileEntries } from "./entry.js";
import type { DgpuError } from "./errors.js";
import {
  assignedDgpuIds,
  readRegistry,
  setAssignment,
  writeRegistry,
} from "./registry.js";

export interface DgpuService {
  readonly assigned: Effect.Effect<ReadonlySet<string>, DgpuError>;
  readonly reconcile: Effect.Effect<void, DgpuError>;
  readonly set: (
    entryId: string,
    on: boolean
  ) => Effect.Effect<void, DgpuError>;
  readonly wrapperPath: (entryId: string) => string;
}

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
        DgpuConfig | FileSystem.FileSystem | Path.Path
      >();

      const config = yield* DgpuConfig;
      const path = yield* Path.Path;

      const assigned = readRegistry.pipe(
        Effect.map(assignedDgpuIds),
        Effect.withSpan("Dgpu.assigned"),
        Effect.provideContext(context)
      );

      const reconcile = readRegistry.pipe(
        Effect.map(assignedDgpuIds),
        Effect.flatMap(reconcileEntries),
        Effect.withSpan("Dgpu.reconcile"),
        Effect.provideContext(context)
      );

      const set = Effect.fn("Dgpu.set")(function* (
        entryId: string,
        on: boolean
      ) {
        const next = setAssignment(yield* readRegistry, entryId, on);

        if (next.changed) {
          yield* writeRegistry(next.registry);
        }

        yield* reconcileEntries(assignedDgpuIds(next.registry));
      }, Effect.provideContext(context));

      return Dgpu.of({
        assigned,
        reconcile,
        set,
        wrapperPath: (entryId) =>
          path.join(config.applicationsDir, entryFilename(entryId)),
      });
    })
  );
}
