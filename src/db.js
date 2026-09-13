"use strict";

// One MongoClient for the whole process, created lazily and reused.
//
// Deliberately NOT using `serverApi: { strict: true }`: Atlas Search stages such as
// `$vectorSearch` are rejected under a strict-API client, which is why the old service
// ended up maintaining two separate clients. One non-strict client serves both the
// stats read path and the vector search landing in Phase 3a.

const dns = require("node:dns");
const { MongoClient } = require("mongodb");
const { getConfig } = require("./config");

let client = null;
let database = null;
let connecting = null;

/**
 * Point the resolver at explicit DNS servers, when configured.
 *
 * `mongodb+srv://` does an SRV lookup before it can reach Atlas, and a resolver that
 * does not answer SRV queries fails it with `querySrv ECONNREFUSED` — which reads like a
 * connection problem but happens before any connection is attempted.
 *
 * This is process-global because the driver resolves through the global `dns` module, so
 * a scoped `dns.Resolver` would not affect it. It is opt-in and applied here at connect
 * time rather than as an import side effect, which is what made the old service's
 * unconditional `dns.setServers()` in mongo.js worth leaving behind.
 */
function applyDnsOverride(servers) {
  if (servers.length === 0) {
    return;
  }
  dns.setServers(servers);
  console.log("db.dns_override_applied", { servers });
}

async function openConnection() {
  const { mongo } = getConfig();
  applyDnsOverride(mongo.dnsServers);

  const nextClient = new MongoClient(mongo.uri, {
    serverSelectionTimeoutMS: mongo.timeoutMs,
    connectTimeoutMS: mongo.timeoutMs,
  });

  await nextClient.connect();
  await nextClient.db("admin").command({ ping: 1 });

  client = nextClient;
  database = nextClient.db(mongo.dbName);
  return database;
}

/**
 * Connect (or return the existing connection). Concurrent callers share one attempt.
 * `server.js` awaits this before listening, so the process never accepts traffic it
 * cannot serve.
 */
async function connect() {
  if (database) {
    return database;
  }
  if (!connecting) {
    connecting = openConnection().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

async function getCollection(name) {
  const db = await connect();
  return db.collection(name);
}

/** The GitHub stats archive — the collection `/github` reads and `/refresh` writes. */
async function statsCollection() {
  return getCollection(getConfig().mongo.statsCollection);
}

/**
 * The underlying MongoClient, connected. Needed by LangGraph's MongoDBSaver, which
 * takes a client rather than a database handle — this is why it is exported at all.
 */
async function getClient() {
  await connect();
  return client;
}

async function close() {
  if (client) {
    await client.close();
  }
  client = null;
  database = null;
}

module.exports = { connect, getCollection, statsCollection, getClient, close };
