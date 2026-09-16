# NookBridge Stage 0 reproducible Nix flake.
#
# Pins everything that the Stage -1 native-runtime spike proved necessary
# on the reference NixOS host (NixOS 26.05.20260820.5880666):
#
#   - nodejs_22 (matches better-sqlite3-multiple-ciphers 11.x peer range
#     and the Node 22.23.2 the Stage -1 harness validated against);
#   - gcc/g++/GNU make/python3/pkg-config for node-gyp native builds;
#   - zlib/openssl headers for native compilation;
#   - cacert so npm install's TLS lookup finds a complete CA bundle
#     (NixOS-shipped Node bundles don't include every npm-registry intermediate).
#
# Nixpkgs is pinned to a specific revision (5880666fd9eb563038431edb35c2d0aa595884e6)
# so the devShell and any future flake outputs are byte-reproducible from this
# commit. Do NOT replace this with `nixpkgs/<branch>`.
#
# The flake exposes a Linux package for non-NixOS systemd hosts as well as
# the pinned development shell. The package does not install or configure a
# service by itself; use `scripts/install-systemd.sh` for that boundary.
{
  description = "NookBridge — reproducible development baseline (Stage 0)";

  inputs.nixpkgs = {
    url = "github:NixOS/nixpkgs/5880666fd9eb563038431edb35c2d0aa595884e6";
    # Pinned to the exact revision the Stage -1 spike validated against.
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in {
      packages = forAllSystems (system:
      let
        pkgs = pkgsFor system;
        nookbridge = pkgs.callPackage ./nix/package.nix { };
      in {
        inherit nookbridge;
        default = nookbridge;
      });

    devShells = forAllSystems (system:
        let pkgs = pkgsFor system; in {
          default = pkgs.mkShell {
            name = "nookbridge-stage-0";
            buildInputs = with pkgs; [
              nodejs_22
              just
              gcc
              gnumake
              pkg-config
              python3
              zlib.dev
              openssl.dev
              cacert
            ];

            # NixOS ships Node 22 with a CA bundle that does not include the
            # npm registry's intermediate certs. Point Node's TLS lookup at
            # the system CA bundle so `npm install` works without disabling
            # verification. Same workaround the Stage -1 shell used.
            NODE_EXTRA_CA_CERTS = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

            shellHook = ''
              echo "==> NookBridge Stage 0 devShell ready (system: ${system})"
              echo "    node:  $(node --version)"
              echo "    npm:   $(npm --version)"
              echo "    gcc:   $(gcc --version | head -1)"
              echo "    make:  $(make --version | head -1)"
              echo "    nixpkgs: $(cat ${nixpkgs}/.version 2>/dev/null || echo unknown)"
              echo "    CA bundle: $NODE_EXTRA_CA_CERTS"
            '';
          };
        });
    };
}
