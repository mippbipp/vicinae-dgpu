export const OFFLOAD_ENV = [
  "__NV_PRIME_RENDER_OFFLOAD=1",
  "__GLX_VENDOR_LIBRARY_NAME=nvidia",
  "__VK_LAYER_NV_optimus=NVIDIA_only",
] as const;

export const MARKER_KEY = "X-Caelestia-DGPU-Source";

export const WRAPPER_SUFFIX = " (dGPU)";

export const DESKTOP_EXT = ".desktop";

export const MAIN_GROUP = "[Desktop Entry]";

export const DGPU = "dGPU";

const KEY_VALUE = /^(?<key>[A-Za-z0-9-]+)=(?<value>.*)$/u;

const LINE_BREAK = /\r?\n/u;

const TRAILING_LINE_BREAK = /\r?\n$/u;

const ENV_COMMAND = "env ";

const OFFLOAD_PREFIX = `${ENV_COMMAND}${OFFLOAD_ENV.join(" ")} `;

export interface DesktopGroupEntry {
  readonly group: string;
  readonly key: string;
  readonly value: string;
}

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

/**
 * Parses `(group, key, value)` tuples in file order. Group headers and
 * comments are not returned.
 */
export const desktopGroups = (
  contents: string
): readonly DesktopGroupEntry[] => {
  const entries: DesktopGroupEntry[] = [];
  let group: string | null = null;

  for (const line of splitLines(contents)) {
    if (line.startsWith("[")) {
      group = line;
    } else {
      const entry = parseKeyValue(line);

      if (entry !== undefined && group !== null) {
        entries.push({ group, ...entry });
      }
    }
  }

  return entries;
};

export const wrapperFilename = (entryId: string): string => {
  const stem = entryId.endsWith(DESKTOP_EXT)
    ? entryId.slice(0, -DESKTOP_EXT.length)
    : entryId;

  return `${stem}${WRAPPER_SUFFIX}${DESKTOP_EXT}`;
};

const addOffload = (value: string): string =>
  `${OFFLOAD_PREFIX}${value.startsWith(ENV_COMMAND) ? value.slice(ENV_COMMAND.length) : value}`;

/**
 * Rewrites one `[Desktop Entry]` line for the wrapper. Returns `undefined`
 * for lines the wrapper drops: a stale marker copied from the source.
 */
const rewriteMainGroupLine = (line: string): string | undefined => {
  const entry = parseKeyValue(line);

  if (entry === undefined) {
    return line;
  }

  switch (entry.key) {
    case "Name":
      return entry.value.endsWith(WRAPPER_SUFFIX)
        ? line
        : `Name=${entry.value}${WRAPPER_SUFFIX}`;
    case "Exec":
      return `Exec=${addOffload(entry.value)}`;
    case MARKER_KEY:
      return undefined;
    default:
      return line;
  }
};

/**
 * Builds a wrapper entry while leaving action groups untouched. The marker is
 * inserted directly under `[Desktop Entry]` so stale wrappers can be detected
 * without trusting the filename alone.
 */
export const buildWrapper = (source: string, entryId: string): string => {
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

export const wrapperSourceId = (contents: string): string | undefined =>
  desktopGroups(contents).find(
    (entry) => entry.group === MAIN_GROUP && entry.key === MARKER_KEY
  )?.value;
