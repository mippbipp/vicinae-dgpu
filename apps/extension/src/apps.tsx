import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { DgpuConfig } from "@vicinae-dgpu/core/config";
import { Dgpu } from "@vicinae-dgpu/core/dgpu";
import type { EntryStatus } from "@vicinae-dgpu/core/dgpu";
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
import { Effect, Layer, Match } from "effect";
import { useEffect, useState } from "react";

interface ViewState {
  readonly apps: readonly Application[];
  readonly statuses: ReadonlyMap<string, EntryStatus>;
  readonly loading: boolean;
  readonly error: string | null;
}

type SetView = (update: (view: ViewState) => ViewState) => void;

interface StatusRow {
  readonly subtitle: string;
  readonly accessory: List.Item.Accessory | null;
}

const INITIAL_VIEW: ViewState = {
  apps: [],
  statuses: new Map(),
  loading: true,
  error: null,
};

const STATUS_ROWS: Readonly<Record<EntryStatus, StatusRow>> = {
  none: { subtitle: "No dGPU entry", accessory: null },
  added: {
    subtitle: "dGPU entry added",
    accessory: { icon: Icon.CheckCircle, tooltip: "dGPU entry added" },
  },
  "missing-source": {
    subtitle: "Desktop file not found",
    accessory: {
      icon: Icon.Warning,
      tooltip:
        "Assigned to the dGPU, but dgpu could not find this app's desktop file",
    },
  },
  failed: {
    subtitle: "dGPU entry not written",
    accessory: {
      icon: Icon.XMarkCircle,
      tooltip: "Assigned to the dGPU, but writing its dGPU entry failed",
    },
  },
};

const NodeDgpu = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
);

const DgpuLive = Dgpu.layer.pipe(
  Layer.provide(DgpuConfig.layer),
  Layer.provide(NodeDgpu)
);

/**
 * Runs one UI action on its own fiber. Each action is an entry point, so the
 * layers are provided here and every DgpuError, including one raised while
 * building them, reaches `onFailure`.
 */
const runAction = (
  action: Effect.Effect<void, DgpuError, Dgpu>,
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

const failureToast = (title: string) => (error: DgpuError) =>
  toast({ style: Toast.Style.Failure, title, message: error.message }).pipe(
    Effect.asVoid
  );

/** First occurrence per id, sorted by name. */
const uniqueApps = (installed: readonly Application[]): Application[] => {
  const byId = new Map<string, Application>();

  for (const app of installed) {
    if (!byId.has(app.id)) {
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
}).pipe(Effect.map(uniqueApps));

const showLoadError = (setView: SetView) => (error: DgpuError) =>
  Effect.sync(() => {
    setView(() => ({ ...INITIAL_VIEW, loading: false, error: error.message }));
  });

/**
 * Lists the installed apps that have a source entry, with their status. A
 * failure on single entries is shown as a toast; the list still renders.
 */
const refreshView = (setView: SetView) =>
  Effect.gen(function* () {
    const dgpu = yield* Dgpu;
    const installed = yield* installedApps;
    const snapshot = yield* dgpu.snapshot(installed.map((app) => app.id));

    yield* Effect.sync(() => {
      setView(() => ({
        apps: installed.filter((app) => snapshot.statuses.has(app.id)),
        statuses: snapshot.statuses,
        loading: false,
        error: null,
      }));
    });

    if (snapshot.failures.length > 0) {
      yield* toast({
        style: Toast.Style.Failure,
        title: "Some dGPU entries could not be updated",
        message: snapshot.failures.map((error) => error.message).join("; "),
      });
    }
  }).pipe(Effect.catch(showLoadError(setView)));

const statusToast = (app: Application, status: EntryStatus): Toast.Options =>
  Match.value(status).pipe(
    Match.when("none", () => ({
      style: Toast.Style.Success,
      title: `Removed dGPU entry for ${app.name}`,
    })),
    Match.when("added", () => ({
      style: Toast.Style.Success,
      title: `Added dGPU entry for ${app.name}`,
    })),
    Match.when("missing-source", () => ({
      style: Toast.Style.Failure,
      title: `Could not find the desktop file for ${app.name}`,
      message:
        "The app is assigned to the dGPU. Its dGPU entry appears once dgpu finds the file.",
    })),
    Match.when("failed", () => ({
      style: Toast.Style.Failure,
      title: `Could not write the dGPU entry for ${app.name}`,
    })),
    Match.exhaustive
  );

const toggleEntry = (app: Application, on: boolean, setView: SetView) =>
  Effect.gen(function* () {
    const dgpu = yield* Dgpu;
    const status = yield* dgpu.set(app.id, on);

    yield* toast(statusToast(app, status));
  }).pipe(Effect.ensuring(refreshView(setView)));

const launchOnDgpu = (app: Application) =>
  Effect.gen(function* () {
    const dgpu = yield* Dgpu;

    yield* dgpu.launch(app.id);
    yield* Effect.promise(() => closeMainWindow());
  });

const launch = (app: Application) => {
  runAction(launchOnDgpu(app), failureToast(`Could not launch ${app.name}`));
};

export default function DgpuApps() {
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);

  useEffect(() => {
    runAction(refreshView(setView), showLoadError(setView));
  }, []);

  const toggle = (app: Application, on: boolean) => {
    runAction(
      toggleEntry(app, on, setView),
      failureToast("Could not change dGPU entry")
    );
  };

  const assignedCount = view.apps.filter(
    (app) => (view.statuses.get(app.id) ?? "none") !== "none"
  ).length;

  return (
    <List
      isLoading={view.loading}
      searchBarPlaceholder="Search applications..."
      navigationTitle="dGPU Apps"
    >
      <List.Section
        title="Applications"
        subtitle={`${assignedCount} dGPU ${assignedCount === 1 ? "entry" : "entries"}`}
      >
        {view.apps.map((app) => {
          const status = view.statuses.get(app.id) ?? "none";
          const row = STATUS_ROWS[status];
          const assigned = status !== "none";

          return (
            <List.Item
              key={app.id}
              title={app.name}
              subtitle={row.subtitle}
              icon={
                app.icon === undefined || app.icon === ""
                  ? Icon.AppWindow
                  : { source: app.icon }
              }
              accessories={row.accessory === null ? [] : [row.accessory]}
              actions={
                <ActionPanel>
                  <Action
                    title={assigned ? "Remove entry" : "Add entry"}
                    icon={assigned ? Icon.Trash : Icon.PlusCircle}
                    onAction={() => {
                      toggle(app, !assigned);
                    }}
                  />
                  {status === "added" && (
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
