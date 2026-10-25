import { homedir } from "node:os";

import { Config, Context, Effect, Layer, Option, Path } from "effect";

import { DgpuError } from "./errors.js";

export interface DgpuConfigService {
  readonly registryPath: string;
  readonly applicationsDir: string;
  readonly sourceDirs: readonly string[];
}

export interface DgpuConfigOverrides {
  readonly registry?: string | undefined;
  readonly applicationsDir?: string | undefined;
  readonly sourceDirs?: readonly string[] | undefined;
}

const SYSTEM_DATA_DIRS = ["/usr/local/share", "/usr/share"];

// The XDG base directory spec treats an empty variable the same as an unset one.
const xdgVariable = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value.length > 0))
  );

const Environment = Config.all({
  home: xdgVariable("HOME"),
  configHome: xdgVariable("XDG_CONFIG_HOME"),
  dataHome: xdgVariable("XDG_DATA_HOME"),
  dataDirs: xdgVariable("XDG_DATA_DIRS"),
});

/**
 * Resolves the registry and XDG application directories. The generator keeps
 * the same defaults as the Python implementation so existing registries and
 * wrapper entries keep working.
 */
const resolve = Effect.fn("DgpuConfig.resolve")(function* (
  overrides: DgpuConfigOverrides
) {
  const path = yield* Path.Path;

  const env = yield* Environment.pipe(
    Effect.mapError((cause) =>
      DgpuError.make({
        message: `cannot read environment: ${cause.message}`,
        cause,
      })
    )
  );

  const home = Option.getOrElse(env.home, homedir);

  const configHome = Option.getOrElse(env.configHome, () =>
    path.join(home, ".config")
  );

  const dataHome = Option.getOrElse(env.dataHome, () =>
    path.join(home, ".local", "share")
  );

  const dataDirs = Option.match(env.dataDirs, {
    onNone: () => [],
    onSome: (dirs) => dirs.split(":").filter((dir) => dir.length > 0),
  });

  const sourceDirs =
    overrides.sourceDirs ??
    [...new Set([...dataDirs, ...SYSTEM_DATA_DIRS])].map((dir) =>
      path.join(dir, "applications")
    );

  return DgpuConfig.of({
    registryPath:
      overrides.registry ?? path.join(configHome, "caelestia", "dgpu.json"),
    applicationsDir:
      overrides.applicationsDir ?? path.join(dataHome, "applications"),
    sourceDirs,
  });
});

export class DgpuConfig extends Context.Service<
  DgpuConfig,
  DgpuConfigService
>()("@vicinae-dgpu/core/config/DgpuConfig") {
  /** Defaults come from HOME and the XDG variables; each override wins. */
  public static readonly layerWith = (overrides: DgpuConfigOverrides) =>
    Layer.effect(DgpuConfig, resolve(overrides));

  public static readonly layer = DgpuConfig.layerWith({});
}
