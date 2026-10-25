{
  description = "Per-app dGPU launch wrappers for Vicinae and NixOS";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});

      mkDgpu = pkgs: pkgs.callPackage ./nix/package.nix { };
      homeManagerModule = ./nix/hm.nix;
    in
    {
      packages = forAllSystems (
        system: pkgs:
        let
          dgpu = mkDgpu pkgs;
        in
        {
          default = dgpu.cli;
          inherit (dgpu) cli extension;
        }
      );

      checks = forAllSystems (
        system: pkgs:
        let
          dgpu = mkDgpu pkgs;
        in
        {
          inherit (dgpu) cli extension;
        }
      );

      devShells = forAllSystems (
        system: pkgs: {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              pnpm
            ];
          };
        }
      );

      formatter = forAllSystems (system: pkgs: pkgs.nixfmt-tree);

      homeManagerModules.default = homeManagerModule;
      homeModules.default = homeManagerModule;
    };
}
