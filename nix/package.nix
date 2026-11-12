{
  lib,
  stdenvNoCC,
  bun2nix,
  bun,
  makeWrapper,
}:
let
  version = "1.0.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../bunfig.toml
      ../apps
      ../packages
    ];
  };

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../bun.nix;
  };

  # Lifecycle scripts would run `effect-tsgo patch` and `bun2nix`, which the
  # build needs neither of.
  bunAttrs = {
    inherit version src bunDeps;
    nativeBuildInputs = [ bun2nix.hook ];
    dontRunLifecycleScripts = true;
    dontUseBunPatch = true;
  };

  cli = stdenvNoCC.mkDerivation (
    bunAttrs
    // {
      pname = "dgpu";

      nativeBuildInputs = bunAttrs.nativeBuildInputs ++ [ makeWrapper ];

      buildPhase = ''
        runHook preBuild
        bun run --cwd apps/cli build
        runHook postBuild
      '';

      doCheck = true;
      checkPhase = ''
        runHook preCheck
        bun run --cwd packages/core test
        runHook postCheck
      '';

      installPhase = ''
        runHook preInstall
        install -Dm644 apps/cli/dist/cli.js $out/lib/dgpu/cli.js
        makeWrapper ${lib.getExe bun} $out/bin/dgpu \
          --add-flags $out/lib/dgpu/cli.js
        runHook postInstall
      '';

      meta = {
        description = "Create and reconcile per-app dGPU wrapper desktop entries";
        homepage = "https://github.com/mippbipp/vicinae-dgpu";
        license = lib.licenses.mit;
        mainProgram = "dgpu";
        platforms = lib.platforms.linux;
      };
    }
  );

  extension = stdenvNoCC.mkDerivation (
    bunAttrs
    // {
      # Vicinae's Home Manager module links each extension at
      # vicinae/extensions/<derivation name>, so the name carries no version.
      name = "dgpu";

      # Bun builds the bundle, but Vicinae loads it into its own Node worker,
      # so the extension code stays on @effect/platform-node.
      buildPhase = ''
        runHook preBuild
        cd apps/extension
        bun --bun vici build --out "$out"
        runHook postBuild
      '';

      dontInstall = true;

      meta = {
        description = "Vicinae command that toggles per-app dGPU launch entries";
        homepage = "https://github.com/mippbipp/vicinae-dgpu";
        license = lib.licenses.mit;
        platforms = lib.platforms.linux;
      };
    }
  );
in
{
  inherit cli extension;
}
