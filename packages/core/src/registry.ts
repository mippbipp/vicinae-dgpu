import { Effect, FileSystem, Schema } from "effect";

import { DgpuConfig } from "./config.js";
import { DgpuError } from "./errors.js";
import { failWith, writeTextAtomically } from "./files.js";

/** The registry value that assigns an app to the dGPU. */
const DGPU = "dGPU";

/**
 * The sidecar registry document. `apps` maps desktop entry ids to a GPU name;
 * every other key, and every non-dGPU value, is preserved verbatim.
 */
export interface Registry extends Schema.JsonObject {
  readonly apps: Schema.JsonObject;
}

export interface RegistryChange {
  readonly registry: Registry;
  readonly changed: boolean;
}

const RegistryJson = Schema.fromJsonString(Schema.JsonObject, { space: 2 });

const isJsonObject = Schema.is(Schema.JsonObject);

export const assignedDgpuIds = (registry: Registry): ReadonlySet<string> =>
  new Set(
    Object.entries(registry.apps).flatMap(([entryId, gpu]) =>
      gpu === DGPU ? [entryId] : []
    )
  );

export const setAssignment = (
  registry: Registry,
  entryId: string,
  on: boolean
): RegistryChange => {
  if (on) {
    if (registry.apps[entryId] === DGPU) {
      return { registry, changed: false };
    }

    return {
      registry: {
        ...registry,
        apps: Object.fromEntries([
          ...Object.entries(registry.apps),
          [entryId, DGPU],
        ]),
      },
      changed: true,
    };
  }

  if (!Object.hasOwn(registry.apps, entryId)) {
    return { registry, changed: false };
  }

  const apps = Object.fromEntries(
    Object.entries(registry.apps).filter(([id]) => id !== entryId)
  );

  return { registry: { ...registry, apps }, changed: true };
};

export const readRegistry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { registryPath } = yield* DgpuConfig;
  const fail = failWith(`cannot read registry ${registryPath}`);
  const exists = yield* fs.exists(registryPath).pipe(Effect.mapError(fail));

  if (!exists) {
    const empty: Registry = { apps: {} };

    return empty;
  }

  const text = yield* fs
    .readFileString(registryPath)
    .pipe(Effect.mapError(fail));

  const raw = yield* Schema.decodeEffect(RegistryJson)(text).pipe(
    Effect.mapError(fail)
  );

  const apps = raw.apps ?? {};

  if (!isJsonObject(apps)) {
    return yield* DgpuError.make({
      message: "registry key 'apps' must be an object",
    });
  }

  const registry: Registry = { ...raw, apps };

  return registry;
}).pipe(Effect.withSpan("readRegistry"));

export const writeRegistry = Effect.fn("writeRegistry")(function* (
  registry: Registry
) {
  const { registryPath } = yield* DgpuConfig;

  const encoded = yield* Schema.encodeEffect(RegistryJson)(registry).pipe(
    Effect.mapError(failWith(`cannot write registry ${registryPath}`))
  );

  yield* writeTextAtomically(registryPath, `${encoded}\n`);
});
