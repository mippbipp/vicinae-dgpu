import { Effect, FileSystem, Option, Path, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DgpuConfig } from "./config.js";
import { DgpuError } from "./errors.js";
import { failWith, isFile, readText } from "./files.js";

/**
 * The dGPU entry: a copy of an app's desktop entry whose `Exec` runs on the
 * dGPU. This module owns its filename, its content, the marker that ties it to
 * its source entry, the source lookup, and the sweep of stale entries.
 */

/**
 * - `none`: the app is not assigned to the dGPU.
 * - `added`: the dGPU entry exists.
 * - `missing-source`: the app is assigned, but no source entry was found.
 * - `failed`: the app is assigned, but its dGPU entry could not be written.
 */
export type EntryStatus = "none" | "added" | "missing-source" | "failed";

type AssignedStatus = Exclude<EntryStatus, "none">;

const OFFLOAD_ENV = [
  "__NV_PRIME_RENDER_OFFLOAD=1",
  "__GLX_VENDOR_LIBRARY_NAME=nvidia",
  "__VK_LAYER_NV_optimus=NVIDIA_only",
] as const;

const MARKER_KEY = "X-Caelestia-DGPU-Source";

const ENTRY_SUFFIX = " (dGPU)";

const DESKTOP_EXT = ".desktop";

const MAIN_GROUP = "[Desktop Entry]";

const KEY_VALUE = /^(?<key>[A-Za-z0-9-]+)=(?<value>.*)$/u;

const LINE_BREAK = /\r?\n/u;

const TRAILING_LINE_BREAK = /\r?\n$/u;

const ENV_COMMAND = "env ";

const OFFLOAD_PREFIX = `${ENV_COMMAND}${OFFLOAD_ENV.join(" ")} `;

interface KeyValue {
  readonly key: string;
  readonly value: string;
}

const splitLines = (contents: string): string[] => {
  if (contents === "") {
    return [];
  }

  const lines = contents.split(LINE_BREAK);

  if (TRAILING_LINE_BREAK.test(contents)) {
    lines.pop();
  }

  return lines;
};

const parseKeyValue = (line: string): KeyValue | undefined => {
  const groups = KEY_VALUE.exec(line)?.groups;

  if (groups === undefined) {
    return undefined;
  }

  return { key: groups.key ?? "", value: groups.value ?? "" };
};

const entryFilename = (entryId: string): string => {
  const stem = entryId.endsWith(DESKTOP_EXT)
    ? entryId.slice(0, -DESKTOP_EXT.length)
    : entryId;

  return `${stem}${ENTRY_SUFFIX}${DESKTOP_EXT}`;
};

const isEntryFilename = (name: string): boolean =>
  name.endsWith(`${ENTRY_SUFFIX}${DESKTOP_EXT}`);

/**
 * Whether `entryId` names an app's own desktop entry: a desktop file id that
 * is not itself a dGPU entry and cannot escape the applications dir.
 */
export const isSourceEntryId = (entryId: string): boolean =>
  entryId.length > DESKTOP_EXT.length &&
  entryId.endsWith(DESKTOP_EXT) &&
  !isEntryFilename(entryId) &&
  !entryId.includes("/");

const addOffload = (value: string): string =>
  `${OFFLOAD_PREFIX}${value.startsWith(ENV_COMMAND) ? value.slice(ENV_COMMAND.length) : value}`;

/**
 * Rewrites one `[Desktop Entry]` line for the dGPU entry. Returns `undefined`
 * for lines the dGPU entry drops: a stale marker copied from the source.
 */
const rewriteMainGroupLine = (line: string): string | undefined => {
  const entry = parseKeyValue(line);

  if (entry === undefined) {
    return line;
  }

  switch (entry.key) {
    case "Name":
      return entry.value.endsWith(ENTRY_SUFFIX)
        ? line
        : `Name=${entry.value}${ENTRY_SUFFIX}`;
    case "Exec":
      return `Exec=${addOffload(entry.value)}`;
    case MARKER_KEY:
      return undefined;
    default:
      return line;
  }
};

/**
 * Builds a dGPU entry while leaving action groups untouched. The marker goes
 * directly under `[Desktop Entry]` so stale entries can be detected without
 * trusting the filename alone.
 */
const buildEntry = (source: string, entryId: string): string => {
  const marker = `${MARKER_KEY}=${entryId}`;
  const out: string[] = [];
  let group: string | null = null;
  let markerWritten = false;

  for (const line of splitLines(source)) {
    if (line.startsWith("[")) {
      group = line;
      out.push(line);

      if (group === MAIN_GROUP && !markerWritten) {
        out.push(marker);
        markerWritten = true;
      }
    } else if (group === MAIN_GROUP) {
      const rewritten = rewriteMainGroupLine(line);

      if (rewritten !== undefined) {
        out.push(rewritten);
      }
    } else {
      out.push(line);
    }
  }

  if (!markerWritten) {
    out.push(marker);
  }

  return `${out.join("\n")}\n`;
};

/** The source entry id a dGPU entry was built from, read from its marker. */
const markedSourceId = (contents: string): string | undefined => {
  let group: string | null = null;

  for (const line of splitLines(contents)) {
    if (line.startsWith("[")) {
      group = line;
    } else if (group === MAIN_GROUP) {
      const entry = parseKeyValue(line);

      if (entry?.key === MARKER_KEY) {
        return entry.value;
      }
    }
  }

  return undefined;
};

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

/** Writes the dGPU entry for one assigned id, if its source entry exists. */
const syncEntry = Effect.fn("syncEntry")(function* (
  entryId: string
): Effect.fn.Return<
  AssignedStatus,
  DgpuError,
  DgpuConfig | FileSystem.FileSystem | Path.Path
> {
  if (!isSourceEntryId(entryId)) {
    return yield* DgpuError.make({
      message: `the registry assigns ${entryId}, which is not a source desktop entry id`,
    });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* DgpuConfig;
  const source = yield* findSource(entryId);

  if (Option.isNone(source)) {
    return "missing-source";
  }

  const target = path.join(config.applicationsDir, entryFilename(entryId));
  const contents = buildEntry(yield* readText(source.value), entryId);
  const current = (yield* isFile(target)) ? yield* readText(target) : undefined;

  if (current !== contents) {
    yield* fs
      .writeFileString(target, contents)
      .pipe(Effect.mapError(failWith(`cannot write ${target}`)));
  }

  return "added";
});

/** Removes a dGPU entry whose source entry is not in `keep`. */
const removeIfStale = Effect.fn("removeIfStale")(function* (
  target: string,
  keep: ReadonlySet<string>
) {
  const fs = yield* FileSystem.FileSystem;

  if (yield* isFile(target)) {
    const sourceId = markedSourceId(yield* readText(target));

    if (sourceId !== undefined && !keep.has(sourceId)) {
      yield* fs
        .remove(target, { force: true })
        .pipe(Effect.mapError(failWith(`cannot remove ${target}`)));
    }
  }
});

export interface Reconciled {
  /** The status of every assigned id. */
  readonly statuses: ReadonlyMap<string, AssignedStatus>;
  /** Entries that could not be written, read or removed. */
  readonly failures: readonly DgpuError[];
}

/**
 * Writes a dGPU entry for every assigned id whose source entry exists, then
 * removes the dGPU entries this tool owns that no longer have one. A failure
 * on one entry does not stop the others or the sweep; it is reported in
 * `failures`. Only a failure on the applications dir itself fails the run.
 */
export const reconcileEntries = Effect.fn("reconcileEntries")(function* (
  assigned: ReadonlySet<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { applicationsDir } = yield* DgpuConfig;
  const statuses = new Map<string, AssignedStatus>();
  const failures: DgpuError[] = [];

  yield* fs
    .makeDirectory(applicationsDir, { recursive: true })
    .pipe(Effect.mapError(failWith(`cannot create ${applicationsDir}`)));

  for (const entryId of assigned) {
    const result = yield* Effect.result(syncEntry(entryId));

    if (Result.isSuccess(result)) {
      statuses.set(entryId, result.success);
    } else {
      statuses.set(entryId, "failed");
      failures.push(result.failure);
    }
  }

  // A failed write may leave last run's entry in place, which still launches.
  const keep = new Set(
    [...statuses].flatMap(([entryId, status]) =>
      status === "missing-source" ? [] : [entryId]
    )
  );

  const names = yield* fs
    .readDirectory(applicationsDir)
    .pipe(Effect.mapError(failWith(`cannot list ${applicationsDir}`)));

  for (const name of names) {
    if (isEntryFilename(name)) {
      const result = yield* Effect.result(
        removeIfStale(path.join(applicationsDir, name), keep)
      );

      if (Result.isFailure(result)) {
        failures.push(result.failure);
      }
    }
  }

  const reconciled: Reconciled = { statuses, failures };

  return reconciled;
});

/**
 * Starts the app from its dGPU entry with `gio launch`, which expands the Exec
 * field codes the way a launcher does.
 */
export const launchEntry = Effect.fn("launchEntry")(function* (
  entryId: string
) {
  const path = yield* Path.Path;
  const config = yield* DgpuConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const target = path.join(config.applicationsDir, entryFilename(entryId));

  if (!isSourceEntryId(entryId) || !(yield* isFile(target))) {
    return yield* DgpuError.make({ message: `${entryId} has no dGPU entry` });
  }

  return yield* spawner
    .exitCode(ChildProcess.make("gio", ["launch", target]))
    .pipe(
      Effect.mapError((cause) =>
        DgpuError.make({ message: `cannot run gio: ${cause.message}`, cause })
      ),
      Effect.filterOrFail(
        (exitCode) => exitCode === ChildProcessSpawner.ExitCode(0),
        (exitCode) =>
          DgpuError.make({ message: `gio launch exited with code ${exitCode}` })
      ),
      Effect.asVoid
    );
});
