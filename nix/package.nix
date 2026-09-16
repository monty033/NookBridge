{ lib
, buildNpmPackage
, gnumake
, makeWrapper
, nodejs_22
, openssl
, pkg-config
, python3
, zlib
}:

buildNpmPackage rec {
  pname = "nookbridge";
  version = "0.0.0-stage.0";

  src = ../.;
  nodejs = nodejs_22;

  # Keep this in lock-step with package-lock.json. Native dependencies are
  # rebuilt against the package's pinned Node 22 toolchain below.
  npmDepsHash = "sha256-1cff91fgAnESE6Jh3BD0peaJKN2msjy8DEsSkPxOaeg=";
  npmRebuildFlags = [ "--ignore-scripts" ];

  preBuild = ''
    substituteInPlace node_modules/better-sqlite3-multiple-ciphers/src/better_sqlite3.hpp \
      --replace-fail '#include <sqlite3.h>' '#include "../deps/sqlite3/sqlite3.h"'
    npm rebuild better-sqlite3-multiple-ciphers --build-from-source
  '';

  nativeBuildInputs = [
    gnumake
    makeWrapper
    nodejs_22
    pkg-config
    python3
  ];

  buildInputs = [
    openssl.dev
    zlib.dev
  ];

  dontNpmBuild = true;
  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save
    mkdir -p "$out/libexec/nookbridge"
    cp -r dist "$out/libexec/nookbridge/"
    cp -r node_modules "$out/libexec/nookbridge/"
    install -Dm644 package.json "$out/libexec/nookbridge/package.json"
    install -Dm644 LICENSE "$out/share/licenses/nookbridge/LICENSE"

    makeWrapper ${nodejs_22}/bin/node "$out/bin/nookd" \
      --add-flags "$out/libexec/nookbridge/dist/nookd.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/nook-mcp" \
      --add-flags "$out/libexec/nookbridge/dist/mcp/cli.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/nookctl" \
      --set NOOKBRIDGE_SERVICE_CONFIG /etc/nookbridge/service.json \
      --set NOOKBRIDGE_SETTINGS_PATH /etc/nookbridge/settings.json \
      --add-flags "$out/libexec/nookbridge/dist/cli.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/nookbridge-provision-cli" \
      --add-flags "$out/libexec/nookbridge/dist/provision.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/nookbridge-sync-cli" \
      --add-flags "$out/libexec/nookbridge/dist/sync.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/nookbridge-runtime-check" \
      --add-flags "$out/libexec/nookbridge/dist/runtime-check.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/nookbridge-health" \
      --add-flags "$out/libexec/nookbridge/dist/health.js"

    runHook postInstall
  '';

  meta = {
    description = "NookBridge Notesnook Unix-socket service";
    homepage = "https://git.montycasa.net/patrick/NookBridge";
    license = lib.licenses.gpl3Plus;
    mainProgram = "nookd";
    platforms = lib.platforms.linux;
  };
}
