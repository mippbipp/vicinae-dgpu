# vicinae-dgpu

Per-app dGPU launch wrappers for NixOS. The Vicinae command adds or removes a dGPU launch entry for one app at a time. The `dgpu` CLI and the Vicinae extension come from the same flake.

The wrappers are ordinary XDG desktop entries, so any launcher can read them. Vicinae is optional for the CLI.

## What it does

- Reads the registry at `~/.config/caelestia/dgpu.json`.
- Writes `<app> (dGPU).desktop` into `~/.local/share/applications`.
- Runs the app with `__NV_PRIME_RENDER_OFFLOAD=1`, `__GLX_VENDOR_LIBRARY_NAME=nvidia`, and `__VK_LAYER_NV_optimus=NVIDIA_only`.
- Marks wrappers with `X-Caelestia-DGPU-Source` so stale entries are removed when the source disappears or the entry is removed.
- Reconciles when the Vicinae command opens and whenever the CLI runs.

The registry shape is:

```json
{
  "apps": {
    "com.visualstudio.code.desktop": "dGPU"
  }
}
```

Other keys in the registry are preserved. The registry is a sidecar file. Caelestia shell does not need to read it.

Vicinae does not let an extension add actions to the built-in Applications results, so this ships a separate command. The command lists installed desktop entries and adds or removes their dGPU entries.

## Install with Home Manager

Add the flake input:

```nix
vicinae-dgpu = {
  url = "github:mippbipp/vicinae-dgpu";
  inputs.nixpkgs.follows = "nixpkgs";
  inputs.vicinae.follows = "vicinae";
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

The last command reconciles from the registry. Flags that override paths:

```sh
dgpu set <desktop-id> on \
  --registry /path/to/dgpu.json \
  --applications-dir /path/to/applications \
  --source-dirs /a/applications:/b/applications
```

The source search order is the user applications directory, then `XDG_DATA_DIRS`, then `/usr/local/share/applications` and `/usr/share/applications`. The user applications directory wins, so a local override in `~/.local/share/applications` shadows a system entry.

## Development

```sh
cd app
npm ci
npm test
npm run typecheck
npm run build
```

Then build both Nix outputs from the repo root:

```sh
nix build .#cli
nix build .#extension
```

`npm run build` uses `vici build` for the Vicinae extension. The CLI derivation runs the Vitest suite during `nix build`.

`vici build` emits a CommonJS bundle. Do not add `"type": "module"` to `app/package.json`, or the Vicinae extension worker will fail at load time.

## License

MIT
