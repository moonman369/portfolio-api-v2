"use strict";

// One MongoClient for the whole process, created lazily and reused.
//
// Deliberately NOT using `serverApi: { strict: true }`: Atlas Search stages such as
// `$vectorSearch` are rejected under a strict-API client, which is why the old service
// ended up maintaining two separate clients. One non-strict client serves both the
// stats read path and the vector search landing in Phase 3a.

const { MongoClient } = require("mongodb");
const { getConfig } = require("./config");

let client = null;
let database = null;
let connecting = null;

async function openConnection() {
  const { mongo } = getConfig();

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

async function close() {
  if (client) {
    await client.close();
  }
  client = null;
  database = null;
}

module.exports = { connect, getCollection, statsCollection, close };
