{ inputs }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.dgpu;
  dgpu = pkgs.callPackage ./package.nix { inherit inputs; };
in
{
  options.services.dgpu = {
    enable = lib.mkEnableOption "per-app dGPU launch wrappers";

    package = lib.mkOption {
      type = lib.types.package;
      default = dgpu.cli;
      defaultText = lib.literalMD "the dgpu CLI package";
      description = "The CLI package that writes and reconciles wrapper entries.";
    };

    extension = lib.mkOption {
      type = lib.types.package;
      default = dgpu.extension;
      defaultText = lib.literalMD "the dgpu Vicinae extension package";
      description = "The Vicinae extension package. Add it to programs.vicinae.extensions.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
