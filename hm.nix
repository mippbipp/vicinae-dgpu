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
      description = "The Vicinae extension package.";
    };

    vicinae.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the Vicinae command when the Vicinae Home Manager module is imported.";
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.packages = [ cfg.package ];

      systemd.user.services.dgpu-reconcile = {
        Unit.Description = "Reconcile dGPU wrapper desktop entries";
        Service = {
          Type = "oneshot";
          ExecStart = lib.getExe cfg.package;
        };
        Install.WantedBy = [ "default.target" ];
      };
    }

    (lib.mkIf (cfg.vicinae.enable && config.programs ? vicinae) {
      programs.vicinae.extensions = [ cfg.extension ];
    })
  ]);
}
