packages:
{ pkgs, ... }:
{
  home.packages = [
    packages.${pkgs.stdenv.hostPlatform.system}.cli
  ];
}
