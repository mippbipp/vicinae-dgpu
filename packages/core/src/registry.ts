import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { DgpuConfig } from "./config.js";
import {
  DGPU,
  DESKTOP_EXT,
  WRAPPER_SUFFIX,
  buildWrapper,
  wrapperFilename,
  wrapperSourceId,
} from "./desktop.js";
import { DgpuError } from "./errors.js";

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

const failWith =
  (context: string) =>
  (cause: { readonly message: string }): DgpuError =>
    DgpuError.make({ message: `${context}: ${cause.message}`, cause });

export const emptyRegistry = (): Registry => ({ apps: {} });

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
    return emptyRegistry();
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { registryPath } = yield* DgpuConfig;
  const fail = failWith(`cannot write registry ${registryPath}`);

  const encoded = yield* Schema.encodeEffect(RegistryJson)(registry).pipe(
    Effect.mapError(fail)
  );

  const text = `${encoded}\n`;
  const exists = yield* fs.exists(registryPath).pipe(Effect.mapError(fail));

  const current = exists
    ? yield* fs.readFileString(registryPath).pipe(Effect.mapError(fail))
    : undefined;

  if (current !== text) {
    const temporary = `${registryPath}.tmp`;

    yield* fs
      .makeDirectory(path.dirname(registryPath), { recursive: true })
      .pipe(Effect.mapError(fail));

    yield* fs.writeFileString(temporary, text).pipe(Effect.mapError(fail));
    yield* fs.rename(temporary, registryPath).pipe(Effect.mapError(fail));
  }
});

const isFile = Effect.fn("isFile")(function* (candidate: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.stat(candidate).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed(false)
    ),
    Effect.mapError(failWith(`cannot inspect ${candidate}`))
  );
});

const readText = Effect.fn("readText")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs
    .readFileString(filePath)
    .pipe(Effect.mapError(failWith(`cannot read ${filePath}`)));
});

/** Finds the first source entry, searching the user applications dir first. */
const findSource = Effect.fn("findSource")(function* (entryId: string) {
  const path = yield* Path.Path;
  const config = yield* DgpuConfig;

  for (const base of [config.applicationsDir, ...config.sourceDirs]) {
    const candidate = path.join(base, entryId);

    if (yield* isFile(candidate)) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

const writeWrapper = Effect.fn("writeWrapper")(function* (
  entryId: string,
  source: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* DgpuConfig;
  const target = path.join(config.applicationsDir, wrapperFilename(entryId));
  const contents = buildWrapper(yield* readText(source), entryId);

  const exists = yield* fs
    .exists(target)
    .pipe(Effect.mapError(failWith(`cannot inspect ${target}`)));

  const current = exists ? yield* readText(target) : undefined;

  if (current !== contents) {
    yield* fs
      .writeFileString(target, contents)
      .pipe(Effect.mapError(failWith(`cannot write ${target}`)));
  }
});

/** Removes a wrapper we own whose source is no longer assigned or present. */
const removeIfStale = Effect.fn("removeIfStale")(function* (
  target: string,
  sources: ReadonlyMap<string, string>
) {
  const fs = yield* FileSystem.FileSystem;

  if (yield* isFile(target)) {
    const sourceId = wrapperSourceId(yield* readText(target));

    if (sourceId !== undefined && !sources.has(sourceId)) {
      yield* fs
        .remove(target, { force: true })
        .pipe(Effect.mapError(failWith(`cannot remove ${target}`)));
    }
  }
});

export const applyRegistry = Effect.fn("applyRegistry")(function* (
  registry: Registry
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { applicationsDir } = yield* DgpuConfig;
  const sources = new Map<string, string>();

  for (const entryId of assignedDgpuIds(registry)) {
    const source = yield* findSource(entryId);

    if (Option.isSome(source)) {
      sources.set(entryId, source.value);
    }
  }

  yield* fs
    .makeDirectory(applicationsDir, { recursive: true })
    .pipe(Effect.mapError(failWith(`cannot create ${applicationsDir}`)));

  for (const [entryId, source] of sources) {
    yield* writeWrapper(entryId, source);
  }

  const names = yield* fs
    .readDirectory(applicationsDir)
    .pipe(Effect.mapError(failWith(`cannot list ${applicationsDir}`)));

  for (const name of names) {
    if (name.endsWith(`${WRAPPER_SUFFIX}${DESKTOP_EXT}`)) {
      yield* removeIfStale(path.join(applicationsDir, name), sources);
    }
  }
});
