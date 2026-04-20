{ config, lib, pkgs, ... }:

let
  cfg = config.services.ted;
in {
  options.services.ted = {
    enable = lib.mkEnableOption "Ted: durable Claude chat over Temporal";

    source = lib.mkOption {
      type = lib.types.path;
      description = "Path to the Ted source checkout (must contain package.json and node_modules).";
      example = "/home/robert/ted";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "robert";
      description = "User to run services as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "users";
      description = "Group to run services as.";
    };

    temporalAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:7233";
      description = "Temporal frontend address.";
    };

    temporalUiPort = lib.mkOption {
      type = lib.types.port;
      default = 8233;
    };

    taskQueue = lib.mkOption {
      type = lib.types.str;
      default = "chat";
    };

    webhookPort = lib.mkOption {
      type = lib.types.port;
      default = 8787;
    };

    awsRegion = lib.mkOption {
      type = lib.types.str;
      default = "us-east-1";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
      description = "Bedrock inference profile ID.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a systemd EnvironmentFile containing AWS credentials
        (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, optionally AWS_SESSION_TOKEN).
        If null, the service inherits no AWS credentials — typically only useful
        when the host already provides them via IMDS/SSO.
      '';
      example = "/run/secrets/ted-aws";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the webhook port in the firewall.";
    };

    enableWeb = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Enable the Next.js web UI and Keycloak identity provider.";
    };

    webPort = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port the Next.js UI listens on (bind is always 127.0.0.1).";
    };

    webBaseUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:3000";
      description = "External base URL for the web UI (NEXTAUTH_URL).";
    };

    webEnvironmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        systemd EnvironmentFile for the web service. Must contain:
          NEXTAUTH_SECRET, AUTH_KEYCLOAK_ID, AUTH_KEYCLOAK_SECRET.
      '';
      example = "/etc/ted/web.env";
    };

    keycloakPort = lib.mkOption {
      type = lib.types.port;
      default = 8080;
    };

    keycloakBaseUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8080";
      description = "External base URL of Keycloak (used to form the issuer).";
    };

    keycloakRealm = lib.mkOption {
      type = lib.types.str;
      default = "ted";
      description = "Keycloak realm used for the web UI.";
    };

    keycloakDbPasswordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        File containing the Postgres password for the Keycloak DB user.
        Required when enableWeb = true.
      '';
      example = "/etc/ted/keycloak-db.pass";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ pkgs.temporal-cli pkgs.nodejs_22 ];

    networking.firewall.allowedTCPPorts =
      lib.mkIf cfg.openFirewall [ cfg.webhookPort ];

    # --- Redis (streaming fan-out) ---
    services.redis.servers.ted = {
      enable = true;
      port = 6379;
      bind = "127.0.0.1";
    };

    # --- Postgres (durable message history) ---
    # Unix-socket + peer auth. The service OS user (cfg.user) maps to a
    # superuser Postgres role for this single-machine dev setup; that keeps us
    # out of `ensureDBOwnership`'s same-name constraint so we can use a `chat`
    # database with an arbitrarily-named OS user.
    services.postgresql = {
      enable = true;
      ensureDatabases = [ "chat" ];
      ensureUsers = [
        {
          name = cfg.user;
          ensureClauses.superuser = true;
        }
      ];
    };

    # --- Temporal dev server ---
    systemd.services.ted-temporal = {
      description = "Temporal dev server for Ted";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.temporal-cli}/bin/temporal"
          "server start-dev"
          "--ip 127.0.0.1"
          "--port ${toString (lib.toInt (lib.last (lib.splitString ":" cfg.temporalAddress)))}"
          "--ui-port ${toString cfg.temporalUiPort}"
          "--log-level warn"
        ];
        Restart = "always";
        RestartSec = 2;
      };
    };

    # --- Ted worker ---
    systemd.services.ted-worker = {
      description = "Ted Temporal worker (Claude streaming activity)";
      after = [ "ted-temporal.service" "network.target" "postgresql.service" "redis-ted.service" ];
      requires = [ "ted-temporal.service" "postgresql.service" "redis-ted.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.nodejs_22 pkgs.coreutils ];
      environment = {
        TEMPORAL_ADDRESS = cfg.temporalAddress;
        TEMPORAL_NAMESPACE = "default";
        TASK_QUEUE = cfg.taskQueue;
        AWS_REGION = cfg.awsRegion;
        CLAUDE_CODE_USE_BEDROCK = "1";
        ANTHROPIC_MODEL = cfg.model;
        REDIS_URL = "redis://127.0.0.1:6379";
        DATABASE_URL = "postgresql:///chat?host=/run/postgresql";
      };
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.source;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        ExecStart = "${pkgs.nodejs_22}/bin/node --loader ts-node/esm ${cfg.source}/src/worker.ts";
        Restart = "always";
        RestartSec = 3;
      };
    };

    # --- Keycloak (identity provider) ---
    # Enabled with enableWeb. Uses the existing services.postgresql with a
    # dedicated `keycloak` DB + role. Listens on 127.0.0.1:keycloakPort;
    # expose publicly via nginx or SSH tunnel.
    services.keycloak = lib.mkIf cfg.enableWeb {
      enable = true;
      database = {
        type = "postgresql";
        createLocally = false;
        host = "127.0.0.1";
        port = 5432;
        name = "keycloak";
        username = "keycloak";
        passwordFile = cfg.keycloakDbPasswordFile;
        useSSL = false;
      };
      settings = {
        hostname = "127.0.0.1";
        hostname-strict = false;
        http-enabled = true;
        http-host = "127.0.0.1";
        http-port = cfg.keycloakPort;
        proxy-headers = "xforwarded";
      };
    };

    # Ensure Postgres listens on TCP so Keycloak (JDBC) can connect; peer
    # auth still works over the socket for ted's own services.
    services.postgresql.enableTCPIP = lib.mkIf cfg.enableWeb true;
    services.postgresql.authentication = lib.mkIf cfg.enableWeb (lib.mkOverride 10 ''
      # Allow Keycloak to connect to its own database over TCP with a password.
      host    keycloak  keycloak  127.0.0.1/32  md5
      host    keycloak  keycloak  ::1/128       md5
      # Local socket peer auth for everything else (defaults).
      local   all       all                     peer
      host    all       all       127.0.0.1/32  trust
      host    all       all       ::1/128       trust
    '');

    # Create the `keycloak` role + db with the supplied password. Using a
    # systemd-oneshot after postgresql.service comes up so we can templated
    # the password into SQL at runtime without committing it.
    systemd.services.ted-keycloak-db-setup = lib.mkIf cfg.enableWeb {
      description = "Provision Keycloak Postgres role + database";
      after = [ "postgresql.service" ];
      requires = [ "postgresql.service" ];
      wantedBy = [ "multi-user.target" ];
      before = [ "keycloak.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "root";
      };
      path = [ config.services.postgresql.package pkgs.util-linux pkgs.coreutils ];
      script = ''
        pw="$(cat ${cfg.keycloakDbPasswordFile})"
        run() { runuser -u postgres -- psql "$@"; }
        run -tAc "SELECT 1 FROM pg_roles WHERE rolname='keycloak'" | grep -q 1 \
          || run -c "CREATE ROLE keycloak LOGIN PASSWORD '$pw'"
        run -c "ALTER ROLE keycloak WITH PASSWORD '$pw'"
        run -tAc "SELECT 1 FROM pg_database WHERE datname='keycloak'" | grep -q 1 \
          || run -c "CREATE DATABASE keycloak OWNER keycloak"
      '';
    };

    # The lxc-container module sets a global `LoadCredential=` reset on every
    # service, which wipes Keycloak's LoadCredential for its DB password and
    # causes the start script to blow up on `$CREDENTIALS_DIRECTORY` being
    # unset. Work around by staging the password into /run ourselves before
    # start and pointing CREDENTIALS_DIRECTORY at that path.
    systemd.services.keycloak = lib.mkIf cfg.enableWeb {
      environment = {
        CREDENTIALS_DIRECTORY = "/run/keycloak-creds";
        # Keycloak 26.x: bootstrap a temporary admin so we can log in.
        # Change this password immediately after first login.
        KC_BOOTSTRAP_ADMIN_USERNAME = "admin";
        KC_BOOTSTRAP_ADMIN_PASSWORD = "admin";
      };
      serviceConfig = {
        ExecStartPre = [
          ("+${pkgs.bash}/bin/bash -c '"
            + "install -d -m 0755 /run/keycloak-creds && "
            + "install -m 0444 ${cfg.keycloakDbPasswordFile} "
            + "/run/keycloak-creds/keycloak-db.pass'")
        ];
      };
    };

    # --- Ted web (Next.js UI) ---
    systemd.services.ted-web = lib.mkIf cfg.enableWeb {
      description = "Ted web UI (Next.js)";
      after = [ "ted-webhook.service" "keycloak.service" ];
      requires = [ "ted-webhook.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.nodejs_22 pkgs.coreutils pkgs.bashInteractive ];
      environment = {
        NODE_ENV = "production";
        PORT = toString cfg.webPort;
        HOSTNAME = "127.0.0.1";
        TED_URL = "http://127.0.0.1:${toString cfg.webhookPort}";
        NEXTAUTH_URL = cfg.webBaseUrl;
        AUTH_TRUST_HOST = "true";
        AUTH_KEYCLOAK_ISSUER = "${cfg.keycloakBaseUrl}/realms/${cfg.keycloakRealm}";
      };
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = "${cfg.source}/web";
        EnvironmentFile = lib.mkIf (cfg.webEnvironmentFile != null) cfg.webEnvironmentFile;
        # next-start directly to avoid npm+sh dependency; Node is enough.
        ExecStart = "${pkgs.nodejs_22}/bin/node ${cfg.source}/web/node_modules/next/dist/bin/next start -p ${toString cfg.webPort} -H 127.0.0.1";
        Restart = "always";
        RestartSec = 3;
      };
    };

    # --- Ted webhook ---
    systemd.services.ted-webhook = {
      description = "Ted webhook (HTTP -> Temporal signalWithStart)";
      after = [ "ted-temporal.service" "network.target" "postgresql.service" "redis-ted.service" ];
      requires = [ "ted-temporal.service" "postgresql.service" "redis-ted.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.nodejs_22 pkgs.coreutils ];
      environment = {
        TEMPORAL_ADDRESS = cfg.temporalAddress;
        TEMPORAL_NAMESPACE = "default";
        TASK_QUEUE = cfg.taskQueue;
        WEBHOOK_PORT = toString cfg.webhookPort;
        REDIS_URL = "redis://127.0.0.1:6379";
        DATABASE_URL = "postgresql:///chat?host=/run/postgresql";
      };
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.source;
        ExecStart = "${pkgs.nodejs_22}/bin/node --loader ts-node/esm ${cfg.source}/src/webhook.ts";
        Restart = "always";
        RestartSec = 3;
      };
    };
  };
}
