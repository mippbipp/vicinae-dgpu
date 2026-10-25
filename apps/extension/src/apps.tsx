import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { DgpuConfig } from "@vicinae-dgpu/core/config";
import { Dgpu } from "@vicinae-dgpu/core/dgpu";
import { DgpuError } from "@vicinae-dgpu/core/errors";
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  closeMainWindow,
  getApplications,
  showToast,
} from "@vicinae/api";
import type { Application } from "@vicinae/api";
import { Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { useEffect, useState } from "react";

type AppServices = Dgpu | ChildProcessSpawner.ChildProcessSpawner;

interface ViewState {
  readonly apps: readonly Application[];
  readonly assigned: ReadonlySet<string>;
  readonly loading: boolean;
  readonly error: string | null;
}

type SetView = (update: (view: ViewState) => ViewState) => void;

const INITIAL_VIEW: ViewState = {
  apps: [],
  assigned: new Set(),
  loading: true,
  error: null,
};

const NodeDgpu = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
);

const DgpuLive = Dgpu.layer.pipe(
  Layer.provide(DgpuConfig.layer),
  Layer.provideMerge(NodeDgpu)
);

/**
 * Runs one UI action on its own fiber. Each action is an entry point, so the
 * layers are provided here and every DgpuError, including one raised while
 * building them, reaches `onFailure`.
 */
const runAction = (
  action: Effect.Effect<void, DgpuError, AppServices>,
  onFailure: (error: DgpuError) => Effect.Effect<void>
): void => {
  Effect.runFork(
    action.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- UI action entry point
      Effect.provide(DgpuLive),
      Effect.catch(onFailure)
    )
  );
};

const toast = (options: Toast.Options) =>
  Effect.promise(() => showToast(options));

const isSourceApp = (app: Application): boolean =>
  app.id.endsWith(".desktop") && !app.id.endsWith(" (dGPU).desktop");

/** Desktop entries that can get a dGPU entry, first occurrence per id. */
const sourceApps = (installed: readonly Application[]): Application[] => {
  const byId = new Map<string, Application>();

  for (const app of installed) {
    if (isSourceApp(app) && !byId.has(app.id)) {
      byId.set(app.id, app);
    }
  }

  return [...byId.values()].toSorted((a, b) => a.name.localeCompare(b.name));
};

const installedApps = Effect.tryPromise({
  try: () => getApplications(),
  catch: (cause) =>
    DgpuError.make({
      message: `cannot list applications: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    }),
}).pipe(Effect.map(sourceApps));

/** Reconciles, then reads assignments. A reconcile failure is shown, not fatal. */
const assignments = Effect.gen(function* () {
  const dgpu = yield* Dgpu;

  const reconcileError = yield* dgpu.reconcile.pipe(
    Effect.match({
      onFailure: (error) => error.message,
      onSuccess: () => null,
    })
  );

  const assigned = yield* dgpu.assigned;

  return { assigned, reconcileError };
});

const loadView = (setView: SetView) =>
  Effect.all([assignments, installedApps], { concurrency: "unbounded" }).pipe(
    Effect.flatMap(([{ assigned, reconcileError }, apps]) =>
      Effect.sync(() => {
        setView(() => ({
          apps,
          assigned,
          loading: false,
          error: reconcileError,
        }));
      })
    )
  );

const toggleEntry = (app: Application, enabled: boolean, setView: SetView) =>
  Effect.gen(function* () {
    const dgpu = yield* Dgpu;

    yield* dgpu.set(app.id, enabled);

    const assigned = yield* dgpu.assigned;

    yield* Effect.sync(() => {
      setView((view) => ({ ...view, assigned }));
    });

    yield* toast({
      style: Toast.Style.Success,
      title: enabled
        ? `Added dGPU entry for ${app.name}`
        : `Removed dGPU entry for ${app.name}`,
    });
  });

const launchOnDgpu = (app: Application) =>
  Effect.gen(function* () {
    const dgpu = yield* Dgpu;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    yield* spawner
      .exitCode(ChildProcess.make("gio", ["launch", dgpu.wrapperPath(app.id)]))
      .pipe(
        Effect.mapError((cause) =>
          DgpuError.make({ message: `cannot run gio: ${cause.message}`, cause })
        ),
        Effect.filterOrFail(
          (exitCode) => exitCode === ChildProcessSpawner.ExitCode(0),
          (exitCode) =>
            DgpuError.make({
              message: `gio launch exited with code ${exitCode}`,
            })
        )
      );

    yield* Effect.promise(() => closeMainWindow());
  });

const failureToast = (title: string) => (error: DgpuError) =>
  toast({ style: Toast.Style.Failure, title, message: error.message }).pipe(
    Effect.asVoid
  );

const launch = (app: Application) => {
  runAction(launchOnDgpu(app), failureToast(`Could not launch ${app.name}`));
};

export default function DgpuApps() {
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);

  useEffect(() => {
    runAction(loadView(setView), (error) =>
      Effect.sync(() => {
        setView((current) => ({
          ...current,
          loading: false,
          error: error.message,
        }));
      })
    );
  }, []);

  const toggle = (app: Application, enabled: boolean) => {
    runAction(
      toggleEntry(app, enabled, setView),
      failureToast("Could not change dGPU entry")
    );
  };

  const enabledCount = view.apps.filter((app) =>
    view.assigned.has(app.id)
  ).length;

  return (
    <List
      isLoading={view.loading}
      searchBarPlaceholder="Search applications..."
      navigationTitle="dGPU Apps"
    >
      <List.Section
        title="Applications"
        subtitle={`${enabledCount} dGPU ${enabledCount === 1 ? "entry" : "entries"}`}
      >
        {view.apps.map((app) => {
          const enabled = view.assigned.has(app.id);

          return (
            <List.Item
              key={app.id}
              title={app.name}
              subtitle={enabled ? "dGPU entry added" : "No dGPU entry"}
              icon={
                app.icon === undefined || app.icon === ""
                  ? Icon.AppWindow
                  : { source: app.icon }
              }
              accessories={
                enabled
                  ? [{ icon: Icon.CheckCircle, tooltip: "dGPU entry added" }]
                  : []
              }
              actions={
                <ActionPanel>
                  <Action
                    title={enabled ? "Remove entry" : "Add entry"}
                    icon={enabled ? Icon.Trash : Icon.PlusCircle}
                    onAction={() => {
                      toggle(app, !enabled);
                    }}
                  />
                  {enabled && (
                    <Action
                      title="Launch on dGPU"
                      icon={Icon.Bolt}
                      onAction={() => {
                        launch(app);
                      }}
                    />
                  )}
                  <Action.CopyToClipboard
                    title="Copy desktop entry ID"
                    content={app.id}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
      <List.EmptyView
        title={
          view.error === null
            ? "No applications found"
            : "Could not load dGPU apps"
        }
        description={
          view.error ?? "No desktop entries with an application ID were found."
        }
        icon={view.error === null ? Icon.AppWindow : Icon.XMarkCircle}
      />
    </List>
  );
}
