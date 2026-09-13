"use strict";

// The only process entry point.
//
// Order matters: validate config, then connect to Mongo, and only then listen. The old
// service connected inside the listen callback and so accepted traffic before the
// database was confirmed reachable.

const { getConfig } = require("./config");
const { connect, close } = require("./db");
const { createApp } = require("./http/app");

const SHUTDOWN_GRACE_MS = 10_000;

function attachShutdownHandlers(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${signal} received - shutting down gracefully`);

    // Docker sends SIGTERM then SIGKILL ~10s later; drain in-flight requests first.
    const forced = setTimeout(() => {
      console.error("Forced shutdown: connections did not close in time");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forced.unref();

    server.close(async () => {
      try {
        await close();
      } catch (error) {
        console.error("shutdown.db_close_failed", { message: error?.message });
      }
      clearTimeout(forced);
      console.log("HTTP server closed");
      process.exit(0);
    });
  };

  ["SIGTERM", "SIGINT"].forEach((signal) => {
    process.on(signal, () => {
      void shutdown(signal);
    });
  });
}

async function main() {
  const config = getConfig();
  await connect();

  const server = createApp().listen(config.port, () => {
    console.log(`portfolio-api-v2 listening on port ${config.port} (${config.env})`);
  });

  attachShutdownHandlers(server);
}

main().catch((error) => {
  console.error("startup.failed", { message: error?.message });
  process.exit(1);
});
