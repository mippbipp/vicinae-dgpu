import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { DgpuConfig } from "@vicinae-dgpu/core/config";
import { Dgpu } from "@vicinae-dgpu/core/dgpu";
import { Console, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

const commonFlags = {
  registry: Flag.String("registry").pipe(
    Flag.withDescription("Registry file to read and write"),
    Flag.optional
  ),
  applicationsDir: Flag.String("applications-dir").pipe(
    Flag.withDescription("Directory that receives generated (dGPU) entries"),
    Flag.optional
  ),
  sourceDirs: Flag.String("source-dirs").pipe(
    Flag.withDescription("Colon-separated application directories to search"),
    Flag.optional
  ),
};

interface CommonFlags {
  readonly registry: Option.Option<string>;
  readonly applicationsDir: Option.Option<string>;
  readonly sourceDirs: Option.Option<string>;
}

const splitDirs = (dirs: string): string[] =>
  dirs.split(":").filter((dir) => dir.length > 0);

const dgpuFromFlags = (flags: CommonFlags) => {
  const config = DgpuConfig.layerWith({
    registry: Option.getOrUndefined(flags.registry),
    applicationsDir: Option.getOrUndefined(flags.applicationsDir),
    sourceDirs: flags.sourceDirs.pipe(
      Option.map(splitDirs),
      Option.getOrUndefined
    ),
  });

  return Dgpu.layer.pipe(Layer.provide(config));
};

const setCommand = Command.make(
  "set",
  {
    ...commonFlags,
    entryId: Argument.String("entry-id").pipe(
      Argument.withDescription("Desktop entry id, including .desktop")
    ),
    value: Argument.Literals("value", ["on", "off"]),
  },
  Effect.fn(function* ({ entryId, value }) {
    const dgpu = yield* Dgpu;
    const status = yield* dgpu.set(entryId, value === "on");

    if (status === "missing-source") {
      yield* Console.error(
        `dgpu: assigned ${entryId}, but found no desktop file for it; its dGPU entry appears once the file exists`
      );
    }
  })
).pipe(Command.provide((input) => dgpuFromFlags(input)));

const root = Command.make(
  "dgpu",
  commonFlags,
  Effect.fn(function* () {
    const dgpu = yield* Dgpu;

    yield* dgpu.reconcile;
  })
).pipe(
  Command.provide(dgpuFromFlags),
  Command.withDescription(
    "Reconcile dGPU wrapper desktop entries, or toggle one app with `dgpu set <id> on|off`."
  ),
  Command.withSubcommands([setCommand])
);

const main = root.pipe(
  Command.run({ version: "1.0.0" }),
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- process entry point
  Effect.provide(NodeServices.layer)
);

NodeRuntime.runMain(main);
