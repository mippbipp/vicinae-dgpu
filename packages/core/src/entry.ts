import { Effect, FileSystem, Option, Path } from "effect";

import { DgpuConfig } from "./config.js";
import { failWith, isFile, readText } from "./files.js";

/**
 * The dGPU entry: a copy of an app's desktop entry whose `Exec` runs on the
 * dGPU. This module owns its filename, its content, the marker that ties it to
 * its source entry, the source lookup, and the sweep of stale entries.
 */

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

export const entryFilename = (entryId: string): string => {
  const stem = entryId.endsWith(DESKTOP_EXT)
    ? entryId.slice(0, -DESKTOP_EXT.length)
    : entryId;

  return `${stem}${ENTRY_SUFFIX}${DESKTOP_EXT}`;
};

const isEntryFilename = (name: string): boolean =>
  name.endsWith(`${ENTRY_SUFFIX}${DESKTOP_EXT}`);

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

const writeEntry = Effect.fn("writeEntry")(function* (
  entryId: string,
  source: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* DgpuConfig;
  const target = path.join(config.applicationsDir, entryFilename(entryId));
  const contents = buildEntry(yield* readText(source), entryId);
  const current = (yield* isFile(target)) ? yield* readText(target) : undefined;

  if (current !== contents) {
    yield* fs
      .writeFileString(target, contents)
      .pipe(Effect.mapError(failWith(`cannot write ${target}`)));
  }
});

/** Removes a dGPU entry whose source is no longer assigned or present. */
const removeIfStale = Effect.fn("removeIfStale")(function* (
  target: string,
  sources: ReadonlyMap<string, string>
) {
  const fs = yield* FileSystem.FileSystem;

  if (yield* isFile(target)) {
    const sourceId = markedSourceId(yield* readText(target));

    if (sourceId !== undefined && !sources.has(sourceId)) {
      yield* fs
        .remove(target, { force: true })
        .pipe(Effect.mapError(failWith(`cannot remove ${target}`)));
    }
  }
});

/**
 * Writes a dGPU entry for every assigned id whose source entry exists, then
 * removes the dGPU entries this tool owns that no longer have one.
 */
export const reconcileEntries = Effect.fn("reconcileEntries")(function* (
  assigned: ReadonlySet<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { applicationsDir } = yield* DgpuConfig;
  const sources = new Map<string, string>();

  for (const entryId of assigned) {
    const source = yield* findSource(entryId);

    if (Option.isSome(source)) {
      sources.set(entryId, source.value);
    }
  }

  yield* fs
    .makeDirectory(applicationsDir, { recursive: true })
    .pipe(Effect.mapError(failWith(`cannot create ${applicationsDir}`)));

  for (const [entryId, source] of sources) {
    yield* writeEntry(entryId, source);
  }

  const names = yield* fs
    .readDirectory(applicationsDir)
    .pipe(Effect.mapError(failWith(`cannot list ${applicationsDir}`)));

  for (const name of names) {
    if (isEntryFilename(name)) {
      yield* removeIfStale(path.join(applicationsDir, name), sources);
    }
  }
});
