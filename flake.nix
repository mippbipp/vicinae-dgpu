{
  description = "Per-app dGPU launch wrappers for Vicinae and NixOS";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    vicinae = {
      url = "github:vicinaehq/vicinae";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, ... }@inputs:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});

      mkDgpu = pkgs: pkgs.callPackage ./package.nix { inherit inputs; };

      homeManagerModule = import ./hm.nix { inherit inputs; };
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
          cli = dgpu.cli;
          extension = dgpu.extension;
        }
      );

      devShells = forAllSystems (
        system: pkgs: {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs ];
          };
        }
      );

      formatter = forAllSystems (system: pkgs: pkgs.nixfmt-tree);

      homeManagerModules.default = homeManagerModule;
      homeModules.default = homeManagerModule;
    };
}
