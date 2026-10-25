# vicinae-dgpu

Per-app dGPU launch wrappers for NixOS. The Vicinae command adds or removes a dGPU launch entry for one app at a time. The `dgpu` CLI and the Vicinae extension come from the same flake.

The wrappers are ordinary XDG desktop entries, so any launcher can read them. Vicinae is optional for the CLI.

## What it does

- Reads the registry at `~/.config/caelestia/dgpu.json`.
- Writes `<app> (dGPU).desktop` into `~/.local/share/applications`, through a temporary file and a rename.
- Runs the app with `__NV_PRIME_RENDER_OFFLOAD=1`, `__GLX_VENDOR_LIBRARY_NAME=nvidia`, and `__VK_LAYER_NV_optimus=NVIDIA_only`.
- Adds ` (dGPU)` to every `Name`, localized ones included, and drops `DBusActivatable`, which would let a launcher skip `Exec`. Desktop actions keep their original `Exec`.
- Marks wrappers with `X-Caelestia-DGPU-Source`. A marked file is removed when its source disappears, its app is unassigned, or its filename does not match its source.
- Reconciles when the Vicinae command opens and whenever the CLI runs. A failure on one entry does not stop the others.

The registry shape is:

```json
{
  "apps": {
    "com.visualstudio.code.desktop": "dGPU"
  }
}
```

Other keys in the registry are preserved. The registry is a sidecar file. Caelestia shell does not need to read it.

Vicinae does not let an extension add actions to the built-in Applications results, so this ships a separate command. The command lists installed desktop entries and adds or removes their dGPU entries. Each row shows one of four states: no dGPU entry, dGPU entry added, desktop file not found, or dGPU entry not written. `Launch on dGPU` runs the dGPU entry with `gio launch`, so `gio` from glib has to be on Vicinae's `PATH`.

## Install with Home Manager

Add the flake input:

```nix
vicinae-dgpu = {
  url = "github:mippbipp/vicinae-dgpu";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Import the dgpu module and add the extension package to the Vicinae module's `extensions` option:

```nix
{ pkgs, ... }:
{
  imports = [ inputs.vicinae-dgpu.homeManagerModules.default ];
  programs.vicinae.extensions = [
    inputs.vicinae-dgpu.packages.${pkgs.stdenv.hostPlatform.system}.extension
  ];
}
```

The `programs.vicinae` module comes from Vicinae's Home Manager module. The dgpu module installs the `dgpu` CLI. The extension is the flake's `packages.<system>.extension` output.

If your Vicinae configuration lives in its own Home Manager module, add the package there instead.

The module does not install Vicinae itself.

## Use the CLI

```sh
dgpu set com.visualstudio.code.desktop on
dgpu set com.visualstudio.code.desktop off
dgpu
```

The last command reconciles from the registry and exits non-zero if any dGPU entry could not be written or removed. `set ... on` takes a source desktop entry id and refuses a dGPU entry's own id. If it cannot find the app's desktop file, it still records the assignment and prints a warning.

Flags that override paths:

```sh
dgpu set <desktop-id> on \
  --registry /path/to/dgpu.json \
  --applications-dir /path/to/applications \
  --source-dirs /a/applications:/b/applications
```

The source search order is the user applications directory, then `XDG_DATA_DIRS`, then `/usr/local/share/applications` and `/usr/share/applications`. The user applications directory wins, so a local override in `~/.local/share/applications` shadows a system entry. A file in a subdirectory, such as `kde/foo.desktop`, is found under `kde-foo.desktop` and under `kde.foo.desktop`, the name Vicinae gives it.

## Development

Nix users: run `direnv allow` once so `.envrc` loads the flake's Node and pnpm.

```sh
pnpm install
pnpm test
pnpm ox
pnpm build
```

- `pnpm test` runs the Vitest suite in `packages/core`.
- `pnpm ox` runs type-aware oxlint, the oxfmt check, and `tsc --noEmit` for each package and the root config files, all through Turbo. `pnpm ox:fix` applies lint fixes, then format fixes, and runs the same typecheck alongside. The lefthook pre-commit hook runs `pnpm ox:fix` when a commit stages TypeScript, JavaScript or JSON files, then re-stages the files it fixed.
- `pnpm build` writes the CLI bundle to `apps/cli/dist/cli.cjs` and the extension to `apps/extension/dist`. It does not touch your installed Vicinae extensions.
- `pnpm --filter dgpu dev` runs `vici develop` for a live extension session.

Then build both Nix outputs from the repo root:

```sh
nix build .#cli
nix build .#extension
```

The CLI derivation runs the Vitest suite during `nix build`. Both derivations share one `fetchPnpmDeps` output, so a lockfile change needs a new `pnpmDeps` hash in `nix/package.nix`: set it to `""`, build, and copy the `got:` hash from the error.

`vici build` emits a CommonJS bundle and typechecks the extension with its own TypeScript 5.9. Do not add `"type": "module"` to `apps/extension/package.json`, or the Vicinae extension worker will fail at load time.

## Project structure

```txt
vicinae-dgpu/
├── apps/
│   ├── extension/   # Vicinae command (manifest, assets, src/apps.tsx)
│   └── cli/         # dgpu CLI (effect/cli)
├── packages/
│   ├── core/        # registry, dGPU entries, reconcile, launch; shared by both apps
│   └── config/      # shared tsconfig.base.json
├── tools/
│   └── oxlint/      # vendored anti-slop oxlint plugins
└── nix/             # package.nix (both outputs) and the Home Manager module
```

## License

MIT
