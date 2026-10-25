{
  lib,
  stdenvNoCC,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm,
  nodejs,
  makeWrapper,
}:
let
  version = "1.0.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../apps
      ../packages
    ];
  };

  # Only the shipped packages and their dependencies. The root package holds
  # dev tooling (oxlint, turbo, lefthook) that the build never runs.
  pnpmWorkspaces = [
    "dgpu..."
    "@vicinae-dgpu/cli..."
    "@vicinae-dgpu/core..."
  ];

  pnpmDeps = fetchPnpmDeps {
    pname = "vicinae-dgpu";
    inherit version src pnpmWorkspaces;
    fetcherVersion = 4;
    hash = "sha256-Kn1W/yPfT11ZqeGm9rZ5kn6cMPUBE7af2c/VbwLQa4A=";
  };

  cli = stdenvNoCC.mkDerivation {
    pname = "dgpu";
    inherit
      version
      src
      pnpmDeps
      pnpmWorkspaces
      ;

    nativeBuildInputs = [
      nodejs
      pnpm
      pnpmConfigHook
      makeWrapper
    ];

    buildPhase = ''
      runHook preBuild
      pnpm --filter @vicinae-dgpu/cli run build
      runHook postBuild
    '';

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      pnpm --filter @vicinae-dgpu/core run test
      runHook postCheck
    '';

    installPhase = ''
      runHook preInstall
      install -Dm644 apps/cli/dist/cli.cjs $out/lib/dgpu/cli.cjs
      makeWrapper ${lib.getExe nodejs} $out/bin/dgpu \
        --add-flags $out/lib/dgpu/cli.cjs
      runHook postInstall
    '';

    meta = {
      description = "Create and reconcile per-app dGPU wrapper desktop entries";
      homepage = "https://github.com/mippbipp/vicinae-dgpu";
      license = lib.licenses.mit;
      mainProgram = "dgpu";
      platforms = lib.platforms.linux;
    };
  };

  extension = stdenvNoCC.mkDerivation {
    # Vicinae's Home Manager module links each extension at
    # vicinae/extensions/<derivation name>, so the name carries no version.
    name = "dgpu";
    inherit
      version
      src
      pnpmDeps
      pnpmWorkspaces
      ;

    nativeBuildInputs = [
      nodejs
      pnpm
      pnpmConfigHook
    ];

    buildPhase = ''
      runHook preBuild
      cd apps/extension
      pnpm exec vici build --out "$out"
      runHook postBuild
    '';

    dontInstall = true;

    meta = {
      description = "Vicinae command that toggles per-app dGPU launch entries";
      homepage = "https://github.com/mippbipp/vicinae-dgpu";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
    };
  };
in
{
  inherit cli extension;
}
