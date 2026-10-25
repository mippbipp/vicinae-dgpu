{ inputs }:
{ pkgs, ... }:
{
  home.packages = [
    (pkgs.callPackage ./package.nix { inherit inputs; }).cli
  ];
}
