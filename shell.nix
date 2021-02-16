{ pkgs ? import ./nix/nivpkgs.nix {} }:

with pkgs;

mkShell {
  buildInputs = [
    niv
    nodejs
    nodePackages.npm
  ];
}
