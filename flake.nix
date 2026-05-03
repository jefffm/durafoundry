{
  description = "DuraFoundry Temporal development environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
  };

  outputs = {
    nixpkgs,
    ...
  }: let
    forAllSystems = nixpkgs.lib.genAttrs [
      "x86_64-linux"
    ];
  in {
    devShells = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          git
          jq
          just
          nodejs_22
          ripgrep
          temporal-cli
        ];

        shellHook = ''
          echo "durafoundry dev shell"
          echo "  just --list"
          echo "  just smoke-temporal-cli"
          echo "  just validate"
        '';
      };
    });

    formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.alejandra);
  };
}
