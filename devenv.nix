{
  pkgs,
  inputs,
  ...
}:

let
  pkgs-unstable = import inputs.nixpkgs-unstable { system = pkgs.stdenv.system; };
in
{
  env.REDIS_URL = "redis://localhost:6379";
  # https://devenv.sh/languages/
  languages.rust.enable = true;
  languages.javascript = {
    enable = true;
    package = pkgs-unstable.nodejs_24;
  };

  packages = [
    pkgs.openssl
  ];

  services.redis.enable = true;

  env = {
    NUM_LISTENERS = 1000;
    NUM_POSTERS = 1000;
    NUM_DOCS = 100;
  };

  processes = {
    server.exec = "cd server && node main.ts";
    client.exec = "cd client && cargo run";
  };

  # https://devenv.sh/processes/
  # processes.cargo-watch.exec = "cargo-watch";

  # https://devenv.sh/services/
  # services.postgres.enable = true;

  # https://devenv.sh/scripts/
  # scripts.hello.exec = ''
  #   echo hello from $GREET
  # '';
  #

  # https://devenv.sh/tasks/
  # tasks = {
  #   "myproj:setup".exec = "mytool build";
  #   "devenv:enterShell".after = [ "myproj:setup" ];
  # };

  # https://devenv.sh/tests/
  enterTest = ''
    node --version
    rustc --version
  '';

  # https://devenv.sh/git-hooks/
  # git-hooks.hooks.shellcheck.enable = true;

  # See full reference at https://devenv.sh/reference/options/
}
