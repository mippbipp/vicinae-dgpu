import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DgpuConfig } from "../src/config.js";
import { Dgpu } from "../src/dgpu.js";

const FIXTURES = new URL("fixtures/", import.meta.url);

const OFFLOAD_PREFIX =
  "env __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia __VK_LAYER_NV_optimus=NVIDIA_only";

const JsonDocument = Schema.fromJsonString(Schema.JsonObject);

interface HarnessOptions {
  readonly registryFixture?: string | undefined;
  readonly registrySubpath?: string | undefined;
  readonly launchExitCode?: number | undefined;
}

/** A spawner that records each command and exits with `exitCode`. */
const recordingSpawner = (exitCode: number) => {
  const commands: (readonly string[])[] = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        commands.push([command.command, ...command.args]);
      }

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    })
  );

  return {
    commands,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
};

const buildService = <I, S, E, R>(
  tag: Context.Key<I, S>,
  serviceLayer: Layer.Layer<I, E, R>
) =>
  Layer.build(serviceLayer).pipe(
    Effect.map((built) => Context.get(built, tag))
  );

const makeHarness = Effect.fn("makeHarness")(function* (
  options: HarnessOptions = {}
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtures = yield* path.fromFileUrl(FIXTURES);
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "dgpu-test-" });
  const applicationsDir = path.join(root, "applications");
  const sourceDir = path.join(root, "source");
  const registryPath = path.join(root, options.registrySubpath ?? "dgpu.json");

  const fixture = (group: string, name: string) =>
    path.join(fixtures, group, name);

  yield* fs.makeDirectory(applicationsDir, { recursive: true });
  yield* fs.makeDirectory(sourceDir, { recursive: true });

  for (const name of yield* fs.readDirectory(path.join(fixtures, "source"))) {
    yield* fs.copyFile(fixture("source", name), path.join(sourceDir, name));
  }

  if (options.registryFixture !== undefined) {
    yield* fs.copyFile(
      fixture("registry", options.registryFixture),
      registryPath
    );
  }

  const configLayer = DgpuConfig.layerWith({
    registry: registryPath,
    applicationsDir,
    sourceDirs: [sourceDir],
  });

  const launcher = recordingSpawner(options.launchExitCode ?? 0);
  const services = Layer.merge(configLayer, launcher.layer);

  const dgpu = yield* buildService(
    Dgpu,
    Dgpu.layer.pipe(Layer.provide(services))
  );

  return {
    fs,
    path,
    root,
    applicationsDir,
    sourceDir,
    registryPath,
    fixture,
    dgpu,
    launched: launcher.commands,
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** The dGPU entry for `com.foo.desktop` is `com.foo (dGPU).desktop`. */
const wrapperPath = (harness: Harness, entryId: string): string =>
  harness.path.join(
    harness.applicationsDir,
    entryId.replace(/\.desktop$/u, " (dGPU).desktop")
  );

const readText = (harness: Harness, filePath: string) =>
  harness.fs.readFileString(filePath);

const readRegistryJson = (harness: Harness) =>
  readText(harness, harness.registryPath).pipe(
    Effect.flatMap(Schema.decodeEffect(JsonDocument))
  );

const failureMessage = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<string, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error.message,
      onSuccess: () => "",
    })
  );

const directoryEntries = (harness: Harness, directory: string) =>
  harness.fs
    .readDirectory(directory)
    .pipe(Effect.map((names) => names.toSorted()));

const directoryText = (harness: Harness, directory: string) =>
  Effect.gen(function* () {
    const names = yield* directoryEntries(harness, directory);
    const entries: Record<string, string> = {};

    for (const name of names) {
      entries[name] = yield* readText(
        harness,
        harness.path.join(directory, name)
      );
    }

    return entries;
  });

const resolveConfig = (env: Record<string, string>) => {
  const provider = ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

  return buildService(
    DgpuConfig,
    DgpuConfig.layer.pipe(Layer.provide(provider))
  );
};

layer(NodeServices.layer)("dGPU", (it) => {
  it.effect("creates wrappers with the offload exec for assigned apps", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      yield* harness.dgpu.reconcile;

      assert.strictEqual(
        yield* readText(
          harness,
          wrapperPath(harness, "com.visualstudio.code.desktop")
        ),
        yield* readText(
          harness,
          harness.fixture("expected", "com.visualstudio.code (dGPU).desktop")
        )
      );
      assert.strictEqual(
        yield* readText(
          harness,
          wrapperPath(harness, "com.valvesoftware.Steam.desktop")
        ),
        yield* readText(
          harness,
          harness.fixture("expected", "com.valvesoftware.Steam (dGPU).desktop")
        )
      );
    })
  );

  it.effect("matches the golden wrapper content", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.dgpu.reconcile;

      const golden = yield* readText(
        harness,
        harness.fixture("expected", "com.visualstudio.code (dGPU).desktop")
      );

      assert.strictEqual(
        yield* readText(
          harness,
          wrapperPath(harness, "com.visualstudio.code.desktop")
        ),
        golden
      );
      assert.include(golden, `Exec=${OFFLOAD_PREFIX} code %U`);
      assert.include(golden, "Name=Visual Studio Code (dGPU)");
      assert.include(
        golden,
        "X-Caelestia-DGPU-Source=com.visualstudio.code.desktop"
      );
    })
  );

  it.effect("leaves desktop action groups untouched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      yield* harness.dgpu.reconcile;

      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.valvesoftware.Steam.desktop")
      );

      assert.include(content, "Name=Store");
      assert.include(content, "Exec=steam steam://store");
      assert.notInclude(content, "Store (dGPU)");
    })
  );

  it.effect("is idempotent on a rerun", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      yield* harness.dgpu.reconcile;

      const before = yield* directoryText(harness, harness.applicationsDir);

      yield* harness.dgpu.reconcile;

      const after = yield* directoryText(harness, harness.applicationsDir);

      assert.deepStrictEqual(after, before);
    })
  );

  it.effect("replaces a changed dGPU entry instead of writing in place", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });
      const entry = wrapperPath(harness, "com.visualstudio.code.desktop");
      const link = harness.path.join(harness.root, "linked.desktop");

      yield* harness.dgpu.reconcile;
      yield* harness.fs.link(entry, link);

      const before = yield* readText(harness, link);

      yield* harness.fs.writeFileString(
        harness.path.join(harness.sourceDir, "com.visualstudio.code.desktop"),
        "[Desktop Entry]\nName=Code\nExec=code-insiders %U\n"
      );
      yield* harness.dgpu.reconcile;

      // A rename gives the entry a new inode, so the old hard link keeps the
      // old content. An in-place write would change both.
      assert.strictEqual(yield* readText(harness, link), before);
      assert.include(yield* readText(harness, entry), "code-insiders");
      assert.deepStrictEqual(
        yield* directoryEntries(harness, harness.applicationsDir),
        ["com.visualstudio.code (dGPU).desktop"]
      );
    })
  );

  it.effect("removes a wrapper when its app is no longer assigned", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      yield* harness.dgpu.reconcile;

      yield* harness.fs.copyFile(
        harness.fixture("registry", "one-app.json"),
        harness.registryPath
      );

      yield* harness.dgpu.reconcile;

      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop")
        )
      );
      assert.isFalse(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.valvesoftware.Steam.desktop")
        )
      );
    })
  );

  it.effect("leaves unrelated desktop entries untouched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      const unrelated = harness.path.join(
        harness.applicationsDir,
        "org.gimp.GIMP.desktop"
      );

      const original = "[Desktop Entry]\nName=GIMP\nExec=gimp %U\n";

      yield* harness.fs.writeFileString(unrelated, original);
      yield* harness.dgpu.reconcile;

      assert.strictEqual(yield* readText(harness, unrelated), original);
    })
  );

  it.effect("does nothing when the registry is missing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.dgpu.reconcile;

      assert.deepStrictEqual(
        yield* directoryEntries(harness, harness.applicationsDir),
        []
      );
    })
  );

  it.effect("reports an invalid registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "invalid.json" });
      const message = yield* failureMessage(harness.dgpu.reconcile);

      assert.include(message, "cannot read registry");
    })
  );

  it.effect("removes a stale wrapper when the source disappears", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "none.json" });
      const stale = wrapperPath(harness, "com.visualstudio.code.desktop");

      yield* harness.fs.writeFileString(
        stale,
        "[Desktop Entry]\nX-Caelestia-DGPU-Source=com.visualstudio.code.desktop\nName=Code\n"
      );

      yield* harness.dgpu.reconcile;

      assert.isFalse(yield* harness.fs.exists(stale));
    })
  );

  it.effect("keeps an env prefix with options whole", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.fs.writeFileString(
        harness.path.join(harness.sourceDir, "com.visualstudio.code.desktop"),
        "[Desktop Entry]\nName=Code\nExec=env -u WAYLAND_DISPLAY code %U\n"
      );

      yield* harness.dgpu.reconcile;

      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.visualstudio.code.desktop")
      );

      assert.include(
        content,
        `Exec=${OFFLOAD_PREFIX} env -u WAYLAND_DISPLAY code %U\n`
      );
    })
  );

  it.effect("finds source entries in subdirectories", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const kde = harness.path.join(harness.sourceDir, "kde");

      yield* harness.fs.makeDirectory(kde);
      yield* harness.fs.writeFileString(
        harness.path.join(kde, "konsole.desktop"),
        "[Desktop Entry]\nName=Konsole\nExec=konsole\n"
      );

      // The desktop entry spec joins with "-", Vicinae with ".".
      for (const entryId of ["kde-konsole.desktop", "kde.konsole.desktop"]) {
        assert.strictEqual(yield* harness.dgpu.set(entryId, true), "added");
        assert.include(
          yield* readText(harness, wrapperPath(harness, entryId)),
          `Exec=${OFFLOAD_PREFIX} konsole\n`
        );
      }
    })
  );

  it.effect("prefers the user applications directory over XDG sources", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.fs.writeFileString(
        harness.path.join(
          harness.applicationsDir,
          "com.visualstudio.code.desktop"
        ),
        "[Desktop Entry]\nName=Code\nExec=/opt/code/code %U\n"
      );

      yield* harness.dgpu.reconcile;

      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.visualstudio.code.desktop")
      );

      assert.include(content, `Exec=${OFFLOAD_PREFIX} /opt/code/code %U`);
    })
  );

  it.effect("suffixes localized names and reads spaces around =", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.fs.writeFileString(
        harness.path.join(harness.sourceDir, "com.visualstudio.code.desktop"),
        "[Desktop Entry]\nName = Code\nName[de]=Code DE\nExec = code %U\n"
      );

      yield* harness.dgpu.reconcile;

      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.visualstudio.code.desktop")
      );

      assert.include(content, "Name=Code (dGPU)\n");
      assert.include(content, "Name[de]=Code DE (dGPU)\n");
      assert.include(content, `Exec=${OFFLOAD_PREFIX} code %U\n`);
    })
  );

  it.effect("drops DBusActivatable so launchers run Exec", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.fs.writeFileString(
        harness.path.join(harness.sourceDir, "com.visualstudio.code.desktop"),
        "[Desktop Entry]\nName=Code\nExec=code %U\nDBusActivatable=true\n"
      );

      yield* harness.dgpu.reconcile;

      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.visualstudio.code.desktop")
      );

      assert.notInclude(content, "DBusActivatable");
      assert.include(content, `Exec=${OFFLOAD_PREFIX} code %U\n`);
    })
  );

  it.effect("does not double-wrap an existing env prefix", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.fs.writeFileString(
        harness.path.join(harness.sourceDir, "com.visualstudio.code.desktop"),
        "[Desktop Entry]\nName=Code\nExec=env FOO=1 code %U\n"
      );

      yield* harness.dgpu.reconcile;

      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.visualstudio.code.desktop")
      );

      assert.include(content, `Exec=${OFFLOAD_PREFIX} FOO=1 code %U`);
      assert.strictEqual(content.split("env ").length - 1, 1);
    })
  );

  it.effect("set rejects ids that are not source entry ids", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      for (const entryId of [
        "myapp",
        "com.visualstudio.code (dGPU).desktop",
        "../escape.desktop",
      ]) {
        const message = yield* failureMessage(harness.dgpu.set(entryId, true));

        assert.include(message, "is not a source desktop entry id");
      }

      assert.isFalse(yield* harness.fs.exists(harness.registryPath));
    })
  );

  it.effect("ignores registry ids that are not source entry ids", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      // A stray key like this one broke every toggle on a real registry.
      yield* harness.fs.writeFileString(
        harness.registryPath,
        '{"apps": {"set": "dGPU", "com.visualstudio.code (dGPU).desktop": "dGPU"}}'
      );

      yield* harness.dgpu.reconcile;

      assert.strictEqual(
        yield* harness.dgpu.set("org.mozilla.firefox.desktop", true),
        "added"
      );
      assert.deepStrictEqual(
        yield* directoryEntries(harness, harness.applicationsDir),
        ["org.mozilla.firefox (dGPU).desktop"]
      );

      yield* harness.dgpu.set("set", false);

      assert.deepStrictEqual((yield* readRegistryJson(harness)).apps, {
        "com.visualstudio.code (dGPU).desktop": "dGPU",
        "org.mozilla.firefox.desktop": "dGPU",
      });
    })
  );

  it.effect("set succeeds while another dGPU entry is broken", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      // A directory where the file should go makes the write fail.
      yield* harness.fs.makeDirectory(
        wrapperPath(harness, "com.visualstudio.code.desktop")
      );

      assert.strictEqual(
        yield* harness.dgpu.set("org.mozilla.firefox.desktop", true),
        "added"
      );
      assert.strictEqual(
        yield* harness.dgpu.set("org.mozilla.firefox.desktop", false),
        "none"
      );
      assert.isFalse(
        yield* harness.fs.exists(
          wrapperPath(harness, "org.mozilla.firefox.desktop")
        )
      );
    })
  );

  it.effect("set fails when its own dGPU entry cannot be written", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.fs.makeDirectory(
        wrapperPath(harness, "org.mozilla.firefox.desktop")
      );

      const message = yield* failureMessage(
        harness.dgpu.set("org.mozilla.firefox.desktop", true)
      );

      assert.include(message, "cannot write");
    })
  );

  it.effect("snapshot reports the status of each source entry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.fs.writeFileString(
        harness.registryPath,
        '{"apps": {"com.visualstudio.code.desktop": "dGPU", "org.only.ghost.desktop": "dGPU"}}'
      );

      const snapshot = yield* harness.dgpu.snapshot([
        "com.visualstudio.code.desktop",
        "org.mozilla.firefox.desktop",
        "com.visualstudio.code (dGPU).desktop",
        "org.only.ghost.desktop",
        "not-a-desktop-id",
      ]);

      assert.deepStrictEqual(
        [...snapshot.statuses],
        [
          ["com.visualstudio.code.desktop", "added"],
          ["org.mozilla.firefox.desktop", "none"],
          ["org.only.ghost.desktop", "missing-source"],
        ]
      );
      assert.deepStrictEqual(snapshot.failures, []);
    })
  );

  it.effect("snapshot reports an entry it could not write", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      const stale = wrapperPath(harness, "org.mozilla.firefox.desktop");

      // A directory where the file should go makes the write fail.
      yield* harness.fs.makeDirectory(
        wrapperPath(harness, "com.visualstudio.code.desktop")
      );
      yield* harness.fs.writeFileString(
        stale,
        "[Desktop Entry]\nX-Caelestia-DGPU-Source=org.mozilla.firefox.desktop\n"
      );

      const snapshot = yield* harness.dgpu.snapshot([
        "com.visualstudio.code.desktop",
        "com.valvesoftware.Steam.desktop",
      ]);

      assert.deepStrictEqual(
        [...snapshot.statuses],
        [
          ["com.visualstudio.code.desktop", "failed"],
          ["com.valvesoftware.Steam.desktop", "added"],
        ]
      );
      assert.lengthOf(snapshot.failures, 1);
      assert.include(snapshot.failures[0]?.message, "cannot write");
      assert.isFalse(yield* harness.fs.exists(stale));
      assert.include(
        yield* failureMessage(harness.dgpu.reconcile),
        "cannot write"
      );
    })
  );

  it.effect("removes a marked entry with the wrong filename", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      const misnamed = harness.path.join(
        harness.applicationsDir,
        "Code (dGPU).desktop"
      );

      yield* harness.fs.writeFileString(
        misnamed,
        "[Desktop Entry]\nX-Caelestia-DGPU-Source=com.visualstudio.code.desktop\nName=Code\n"
      );

      yield* harness.dgpu.reconcile;

      assert.deepStrictEqual(
        yield* directoryEntries(harness, harness.applicationsDir),
        ["com.visualstudio.code (dGPU).desktop"]
      );
    })
  );

  it.effect("only owns markers in the main desktop group", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "none.json" });

      const foreign = harness.path.join(
        harness.applicationsDir,
        "Other (dGPU).desktop"
      );

      yield* harness.fs.writeFileString(
        foreign,
        "[Desktop Entry]\nName=Other\nExec=other\n\n[Desktop Action X]\nX-Caelestia-DGPU-Source=com.visualstudio.code.desktop\n"
      );

      yield* harness.dgpu.reconcile;

      assert.isTrue(yield* harness.fs.exists(foreign));
    })
  );

  it.effect("ignores non-dGPU assignments", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.fs.writeFileString(
        harness.registryPath,
        '{"apps": {"com.visualstudio.code.desktop": "iGPU"}}'
      );

      yield* harness.dgpu.reconcile;

      assert.deepStrictEqual(
        yield* directoryEntries(harness, harness.applicationsDir),
        []
      );
    })
  );

  it.effect("set on writes the registry and creates the wrapper", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      assert.strictEqual(
        yield* harness.dgpu.set("org.mozilla.firefox.desktop", true),
        "added"
      );

      const data = yield* readRegistryJson(harness);

      assert.deepStrictEqual(data.apps, {
        "com.visualstudio.code.desktop": "dGPU",
        "com.valvesoftware.Steam.desktop": "dGPU",
        "org.mozilla.firefox.desktop": "dGPU",
      });
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "org.mozilla.firefox.desktop")
        )
      );
    })
  );

  it.effect("set on is idempotent and does not rewrite the registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      yield* harness.dgpu.set("org.mozilla.firefox.desktop", true);

      const contentBefore = yield* readText(harness, harness.registryPath);
      const statBefore = yield* harness.fs.stat(harness.registryPath);

      yield* harness.dgpu.set("org.mozilla.firefox.desktop", true);

      const contentAfter = yield* readText(harness, harness.registryPath);
      const statAfter = yield* harness.fs.stat(harness.registryPath);

      assert.strictEqual(contentAfter, contentBefore);
      assert.strictEqual(
        Option.getOrThrow(statAfter.ino),
        Option.getOrThrow(statBefore.ino)
      );
      assert.strictEqual(
        Option.getOrThrow(statAfter.mtime).getTime(),
        Option.getOrThrow(statBefore.mtime).getTime()
      );
    })
  );

  it.effect("set off removes the assignment and the wrapper", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });

      assert.strictEqual(
        yield* harness.dgpu.set("com.valvesoftware.Steam.desktop", false),
        "none"
      );

      const data = yield* readRegistryJson(harness);

      assert.deepStrictEqual(data.apps, {
        "com.visualstudio.code.desktop": "dGPU",
      });
      assert.isFalse(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.valvesoftware.Steam.desktop")
        )
      );
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop")
        )
      );
    })
  );

  it.effect("set off for an unassigned app is a no-op", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });
      const before = yield* readText(harness, harness.registryPath);

      yield* harness.dgpu.set("com.valvesoftware.Steam.desktop", false);

      assert.strictEqual(
        yield* readText(harness, harness.registryPath),
        before
      );
    })
  );

  it.effect("set on creates a missing registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.dgpu.set("com.visualstudio.code.desktop", true);

      const data = yield* readRegistryJson(harness);

      assert.deepStrictEqual(data.apps, {
        "com.visualstudio.code.desktop": "dGPU",
      });
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop")
        )
      );
    })
  );

  it.effect("set on creates missing registry parent directories", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        registrySubpath: "config/caelestia/dgpu.json",
      });

      yield* harness.dgpu.set("com.visualstudio.code.desktop", true);

      const data = yield* readRegistryJson(harness);

      assert.deepStrictEqual(data.apps, {
        "com.visualstudio.code.desktop": "dGPU",
      });
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop")
        )
      );
    })
  );

  it.effect("set preserves other entries and extra keys", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      const initial = yield* readRegistryJson(harness);

      const withGpus = yield* Schema.encodeEffect(JsonDocument)({
        ...initial,
        gpus: { primary: "iGPU" },
      });

      yield* harness.fs.writeFileString(harness.registryPath, withGpus);
      yield* harness.dgpu.set("org.mozilla.firefox.desktop", true);

      const after = yield* readRegistryJson(harness);

      assert.deepStrictEqual(after.gpus, { primary: "iGPU" });
      assert.deepStrictEqual(after.apps, {
        "com.visualstudio.code.desktop": "dGPU",
        "com.valvesoftware.Steam.desktop": "dGPU",
        "org.mozilla.firefox.desktop": "dGPU",
      });
    })
  );

  it.effect("set reports an invalid registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "invalid.json" });

      const message = yield* failureMessage(
        harness.dgpu.set("org.mozilla.firefox.desktop", true)
      );

      assert.include(message, "cannot read registry");
    })
  );

  it.effect("set rejects a registry whose apps value is not an object", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.fs.writeFileString(harness.registryPath, '{"apps": 42}');

      const message = yield* failureMessage(
        harness.dgpu.set("org.mozilla.firefox.desktop", true)
      );

      assert.include(message, "'apps' must be an object");
    })
  );

  it.effect("set on an unresolvable source writes the registry only", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      assert.strictEqual(
        yield* harness.dgpu.set("org.only.ghost.desktop", true),
        "missing-source"
      );

      const data = yield* readRegistryJson(harness);

      assert.deepStrictEqual(data.apps, {
        "org.only.ghost.desktop": "dGPU",
      });
      assert.isFalse(
        yield* harness.fs.exists(wrapperPath(harness, "org.only.ghost.desktop"))
      );
    })
  );

  it.effect("set writes indented JSON with a trailing newline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.dgpu.set("org.mozilla.firefox.desktop", true);

      const text = yield* readText(harness, harness.registryPath);

      assert.isTrue(text.endsWith("\n"));
      assert.include(text, '\n  "apps": {');
    })
  );

  it.effect("set handles a registry without an apps key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.fs.writeFileString(
        harness.registryPath,
        '{"gpus": {"primary": "iGPU"}}'
      );

      yield* harness.dgpu.set("com.visualstudio.code.desktop", true);

      const data = yield* readRegistryJson(harness);

      assert.deepStrictEqual(data.gpus, { primary: "iGPU" });
      assert.deepStrictEqual(data.apps, {
        "com.visualstudio.code.desktop": "dGPU",
      });
    })
  );

  it.effect("resolves paths from HOME and XDG_DATA_DIRS", () =>
    Effect.gen(function* () {
      const config = yield* resolveConfig({
        HOME: "/home/user",
        XDG_DATA_DIRS: "/nix/share::/usr/share",
      });

      assert.strictEqual(
        config.registryPath,
        "/home/user/.config/caelestia/dgpu.json"
      );
      assert.strictEqual(
        config.applicationsDir,
        "/home/user/.local/share/applications"
      );
      assert.deepStrictEqual(config.sourceDirs, [
        "/nix/share/applications",
        "/usr/share/applications",
        "/usr/local/share/applications",
      ]);
    })
  );

  it.effect("treats empty XDG variables as unset", () =>
    Effect.gen(function* () {
      const config = yield* resolveConfig({
        HOME: "/home/user",
        XDG_CONFIG_HOME: "",
        XDG_DATA_HOME: "/data",
        XDG_DATA_DIRS: "",
      });

      assert.strictEqual(
        config.registryPath,
        "/home/user/.config/caelestia/dgpu.json"
      );
      assert.strictEqual(config.applicationsDir, "/data/applications");
      assert.deepStrictEqual(config.sourceDirs, [
        "/usr/local/share/applications",
        "/usr/share/applications",
      ]);
    })
  );
  it.effect("launch runs gio on the dGPU entry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.dgpu.reconcile;
      yield* harness.dgpu.launch("com.visualstudio.code.desktop");

      assert.deepStrictEqual(harness.launched, [
        [
          "gio",
          "launch",
          wrapperPath(harness, "com.visualstudio.code.desktop"),
        ],
      ]);
    })
  );

  it.effect("launch fails for an app without a dGPU entry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });

      yield* harness.dgpu.reconcile;

      const message = yield* failureMessage(
        harness.dgpu.launch("org.mozilla.firefox.desktop")
      );

      assert.include(message, "has no dGPU entry");
      assert.deepStrictEqual(harness.launched, []);
    })
  );

  it.effect("launch reports a non-zero gio exit code", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        registryFixture: "one-app.json",
        launchExitCode: 2,
      });

      yield* harness.dgpu.reconcile;

      const message = yield* failureMessage(
        harness.dgpu.launch("com.visualstudio.code.desktop")
      );

      assert.include(message, "gio launch exited with code 2");
    })
  );
});
