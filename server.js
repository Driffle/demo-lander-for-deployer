import express from "express";
import { MongoClient } from "mongodb";
import pg from "pg";

const app = express();
const port = Number(process.env.PORT) || 3000;

const APP_META_ID = "singleton";

let pool = null;
let dbError = null;

let mongoClient = null;
let mongoDb = null;
let mongoInitError = null;

function getDatabaseUrl() {
  return process.env.DATABASE_URL || null;
}

function getMongoUri() {
  return process.env.MONGODB_URI || null;
}

async function initDb() {
  const url = getDatabaseUrl();
  if (!url) {
    dbError =
      "DATABASE_URL is not set (expected when running under Deployer with Postgres enabled).";
    return;
  }
  pool = new pg.Pool({ connectionString: url, max: 5 });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    dbError = null;
  } catch (e) {
    dbError = String(e?.message || e);
    pool = null;
  }
}

async function initMongo() {
  const uri = getMongoUri();
  if (!uri) {
    mongoInitError =
      "MONGODB_URI is not set (set it to use MongoDB for the displayed app name).";
    return;
  }
  try {
    mongoClient = new MongoClient(uri, { maxPoolSize: 5 });
    await mongoClient.connect();
    const dbName = process.env.MONGODB_DB_NAME || "demo_lander";
    mongoDb = mongoClient.db(dbName);
    const coll = mongoDb.collection("app_meta");
    const existing = await coll.findOne({ _id: APP_META_ID });
    if (!existing) {
      const defaultName =
        process.env.APP_NAME || "Demo lander for Deployer";
      await coll.insertOne({ _id: APP_META_ID, appName: defaultName });
    }
    mongoInitError = null;
  } catch (e) {
    mongoInitError = String(e?.message || e);
    if (mongoClient) {
      try {
        await mongoClient.close();
      } catch {
        /* ignore */
      }
    }
    mongoClient = null;
    mongoDb = null;
  }
}

async function getAppNameFromMongo() {
  if (!mongoDb) {
    return { appName: null, error: mongoInitError };
  }
  try {
    const coll = mongoDb.collection("app_meta");
    let doc = await coll.findOne({ _id: APP_META_ID });
    if (!doc) {
      const defaultName =
        process.env.APP_NAME || "Demo lander for Deployer";
      await coll.insertOne({ _id: APP_META_ID, appName: defaultName });
      doc = { appName: defaultName };
    }
    return { appName: doc.appName ?? null, error: null };
  } catch (e) {
    return { appName: null, error: String(e?.message || e) };
  }
}

function healthOk() {
  const pgNeeded = Boolean(getDatabaseUrl());
  const mongoNeeded = Boolean(getMongoUri());
  if (pgNeeded && dbError) return false;
  if (mongoNeeded && mongoInitError) return false;
  return true;
}

app.get("/health", (_req, res) => {
  res.type("text").send(healthOk() ? "ok" : "degraded");
});

app.get("/", async (_req, res) => {
  let visitCount = null;
  let lastPgError = dbError;
  if (pool && !lastPgError) {
    try {
      await pool.query("INSERT INTO visits DEFAULT VALUES");
      const r = await pool.query("SELECT COUNT(*)::int AS n FROM visits");
      visitCount = r.rows[0]?.n ?? 0;
    } catch (e) {
      lastPgError = String(e?.message || e);
    }
  }

  const { appName: mongoAppName, error: mongoReadError } =
    await getAppNameFromMongo();

  const url = getDatabaseUrl();
  const masked = url
    ? url.replace(/:([^:@/]+)@/, ":****@")
    : "(not set)";

  const mongoUri = getMongoUri();
  const mongoMasked = mongoUri
    ? mongoUri.replace(/:([^:@/]+)@/, ":****@")
    : "(not set)";

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo lander — Deployer + Postgres + MongoDB</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7ecf3; }
    body { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.5rem; font-weight: 600; }
    .ok { color: #7ee787; }
    .bad { color: #ff7b72; }
    code, pre { font-size: 0.85rem; background: #1c2333; padding: 0.2em 0.45em; border-radius: 4px; }
    pre { padding: 1rem; overflow-x: auto; }
    a { color: #79c0ff; }
  </style>
</head>
<body>
  <h1>${
    mongoAppName !== null
      ? escapeHtml(String(mongoAppName))
      : "Demo lander for Deployer"
  }</h1>
  <p>This app is meant to be deployed with <strong>Deployer</strong>, with <strong>Postgres</strong> for visits and <strong>MongoDB</strong> for the displayed app name.</p>
  <ul>
    <li>Compose file: <code>docker-compose.prod.yml</code></li>
    <li>App name (from MongoDB <code>app_meta</code>): ${
      mongoAppName !== null
        ? `<span class="ok">${escapeHtml(String(mongoAppName))}</span>`
        : `<span class="bad">${mongoReadError ? escapeHtml(mongoReadError) : "not connected"}</span>`
    }</li>
    <li>Postgres URL (masked): <code>${escapeHtml(masked)}</code></li>
    <li>MongoDB URI (masked): <code>${escapeHtml(mongoMasked)}</code></li>
    <li>Visit count (from Postgres): ${
      visitCount !== null
        ? `<span class="ok">${escapeHtml(String(visitCount))}</span>`
        : `<span class="bad">${lastPgError ? escapeHtml(lastPgError) : "not connected"}</span>`
    }</li>
  </ul>
  <p>Each page load inserts a row into <code>visits</code>; refresh to see the count increase when Postgres is healthy. The headline reads <code>appName</code> from MongoDB (seeded on first connect; override with <code>APP_NAME</code> or edit the document).</p>
  <p><a href="/health"><code>/health</code></a> — returns <code>ok</code> when every configured database initialized cleanly.</p>
</body>
</html>`);
});

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

await initDb();
await initMongo();

app.listen(port, "0.0.0.0", () => {
  console.log(`demo-lander listening on :${port}`);
});
