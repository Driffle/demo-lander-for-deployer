import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import multer from "multer";
import mysql from "mysql2/promise";
import pg from "pg";
import { createClient } from "redis";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";

const app = express();
app.use(express.json());
const port = Number(process.env.PORT) || 3000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const APP_META_ID = "singleton";
const DEMO_TEST_LOGICAL_KEY = "demo_test";
const DEMO_TEST_JSON = '{"demo":"true"}';
const COUNTER_NAME = "main";

let pool = null;
let dbError = null;

let mongoClient = null;
let mongoDb = null;
let mongoInitError = null;

let redisClient = null;
let redisInitError = null;

let mysqlPool = null;
let mysqlInitError = null;

let s3Client = null;
let s3Bucket = null;
let s3InitError = null;

function getDatabaseUrl() {
  return process.env.DATABASE_URL || null;
}

function getMongoUri() {
  return process.env.MONGODB_URI || null;
}

function getRedisUrl() {
  return process.env.REDIS_URL || null;
}

function getEnvCustom() {
  return process.env.ENV_CUSTOM ?? null;
}

/** Namespace keys when sharing a Redis instance with other apps (optional). */
function getRedisKeyPrefix() {
  const p = (process.env.REDIS_KEY_PREFIX || "").trim();
  return p.replace(/:+$/, "");
}

function redisKey(logicalKey) {
  const p = getRedisKeyPrefix();
  return p ? `${p}:${logicalKey}` : logicalKey;
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

async function initRedis() {
  const url = getRedisUrl();
  if (!url) {
    redisInitError = null;
    return;
  }
  try {
    redisClient = createClient({ url });
    redisClient.on("error", (err) => {
      console.error("Redis client error:", err);
    });
    await redisClient.connect();
    await redisClient.set(redisKey(DEMO_TEST_LOGICAL_KEY), DEMO_TEST_JSON);
    redisInitError = null;
  } catch (e) {
    redisInitError = String(e?.message || e);
    try {
      if (redisClient?.isOpen) await redisClient.quit();
    } catch {
      /* ignore */
    }
    redisClient = null;
  }
}

function getMysqlConfig() {
  const host = process.env.MYSQL_HOST || null;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.MYSQL_PORT) || 3306,
    database: process.env.MYSQL_DATABASE || "lander",
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
  };
}

async function initMysql() {
  const cfg = getMysqlConfig();
  if (!cfg) {
    mysqlInitError =
      "MYSQL_HOST is not set (expected when running under Deployer with MySQL enabled).";
    return;
  }
  try {
    mysqlPool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 5 });
    await mysqlPool.execute(`
      CREATE TABLE IF NOT EXISTS counters (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        value BIGINT NOT NULL DEFAULT 0
      )
    `);
    const [rows] = await mysqlPool.execute(
      "SELECT 1 FROM counters WHERE name = ?",
      [COUNTER_NAME],
    );
    if (/** @type {any[]} */ (rows).length === 0) {
      await mysqlPool.execute(
        "INSERT IGNORE INTO counters (name, value) VALUES (?, 0)",
        [COUNTER_NAME],
      );
    }
    mysqlInitError = null;
  } catch (e) {
    mysqlInitError = String(e?.message || e);
    mysqlPool = null;
  }
}

async function getCounter() {
  if (!mysqlPool) return { value: null, error: mysqlInitError };
  try {
    const [rows] = await mysqlPool.execute(
      "SELECT value FROM counters WHERE name = ?",
      [COUNTER_NAME],
    );
    const r = /** @type {any[]} */ (rows);
    return { value: r.length ? Number(r[0].value) : 0, error: null };
  } catch (e) {
    return { value: null, error: String(e?.message || e) };
  }
}

async function changeCounter(delta) {
  if (!mysqlPool) return { value: null, error: mysqlInitError || "MySQL not connected" };
  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      "UPDATE counters SET value = value + ? WHERE name = ?",
      [delta, COUNTER_NAME],
    );
    const [rows] = await conn.execute(
      "SELECT value FROM counters WHERE name = ?",
      [COUNTER_NAME],
    );
    await conn.commit();
    const r = /** @type {any[]} */ (rows);
    return { value: r.length ? Number(r[0].value) : 0, error: null };
  } catch (e) {
    await conn.rollback();
    return { value: null, error: String(e?.message || e) };
  } finally {
    conn.release();
  }
}

async function resetCounter() {
  if (!mysqlPool) return { value: null, error: mysqlInitError || "MySQL not connected" };
  try {
    await mysqlPool.execute(
      "UPDATE counters SET value = 0 WHERE name = ?",
      [COUNTER_NAME],
    );
    return { value: 0, error: null };
  } catch (e) {
    return { value: null, error: String(e?.message || e) };
  }
}

function getS3Config() {
  const accessKey = process.env.S3_ACCESS_KEY_ID || null;
  const secretKey = process.env.S3_SECRET_ACCESS_KEY || null;
  if (!accessKey || !secretKey) return null;
  return {
    endpoint: process.env.S3_ENDPOINT || null,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    bucket: process.env.S3_BUCKET || "demo-uploads",
    region: process.env.S3_REGION || "us-east-1",
  };
}

async function initS3() {
  const cfg = getS3Config();
  if (!cfg) {
    s3InitError =
      "S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY not set (enable MinIO backend in Deployer or set S3 env vars).";
    return;
  }
  try {
    const opts = {
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    };
    if (cfg.endpoint) {
      opts.endpoint = cfg.endpoint;
      opts.forcePathStyle = true;
    }
    s3Client = new S3Client(opts);
    s3Bucket = cfg.bucket;
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: s3Bucket }));
    } catch (e) {
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
        await s3Client.send(new CreateBucketCommand({ Bucket: s3Bucket }));
      } else {
        throw e;
      }
    }
    s3InitError = null;
  } catch (e) {
    s3InitError = String(e?.message || e);
    s3Client = null;
    s3Bucket = null;
  }
}

function healthOk() {
  const pgNeeded = Boolean(getDatabaseUrl());
  const mongoNeeded = Boolean(getMongoUri());
  const redisNeeded = Boolean(getRedisUrl());
  const mysqlNeeded = Boolean(getMysqlConfig());
  const s3Needed = Boolean(getS3Config());
  if (pgNeeded && dbError) return false;
  if (mongoNeeded && mongoInitError) return false;
  if (redisNeeded && redisInitError) return false;
  if (mysqlNeeded && mysqlInitError) return false;
  if (s3Needed && s3InitError) return false;
  return true;
}

app.get("/health", (_req, res) => {
  res.type("text").send(healthOk() ? "ok" : "degraded");
});

app.get("/api/counter", async (_req, res) => {
  const { value, error } = await getCounter();
  if (error) return res.status(503).json({ error });
  res.json({ value });
});

app.post("/api/counter/increment", async (_req, res) => {
  const { value, error } = await changeCounter(1);
  if (error) return res.status(503).json({ error });
  res.json({ value });
});

app.post("/api/counter/decrement", async (_req, res) => {
  const { value, error } = await changeCounter(-1);
  if (error) return res.status(503).json({ error });
  res.json({ value });
});

app.post("/api/counter/reset", async (_req, res) => {
  const { value, error } = await resetCounter();
  if (error) return res.status(503).json({ error });
  res.json({ value });
});

app.post("/api/files/upload", upload.single("file"), async (req, res) => {
  if (!s3Client || !s3Bucket) return res.status(503).json({ error: s3InitError || "S3 not connected" });
  if (!mongoDb) return res.status(503).json({ error: mongoInitError || "MongoDB not connected" });
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  const file = req.file;
  const s3Key = `uploads/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));
    const doc = {
      originalName: file.originalname,
      s3Key,
      size: file.size,
      contentType: file.mimetype,
      uploadedAt: new Date(),
    };
    const result = await mongoDb.collection("uploads").insertOne(doc);
    res.json({ ...doc, _id: result.insertedId });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/files", async (_req, res) => {
  if (!mongoDb) return res.status(503).json({ error: mongoInitError || "MongoDB not connected" });
  try {
    const files = await mongoDb.collection("uploads").find().sort({ uploadedAt: -1 }).toArray();
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/files/:id/download", async (req, res) => {
  if (!s3Client || !s3Bucket) return res.status(503).json({ error: s3InitError || "S3 not connected" });
  if (!mongoDb) return res.status(503).json({ error: mongoInitError || "MongoDB not connected" });
  try {
    const doc = await mongoDb.collection("uploads").findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: "File not found" });
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: s3Bucket, Key: doc.s3Key }));
    res.set("Content-Type", doc.contentType || "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.originalName)}"`);
    obj.Body.transformToWebStream().pipeTo(
      new WritableStream({
        write(chunk) { res.write(chunk); },
        close() { res.end(); },
        abort(err) { res.destroy(err); },
      }),
    );
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e?.message || e) });
  }
});

app.delete("/api/files/:id", async (req, res) => {
  if (!s3Client || !s3Bucket) return res.status(503).json({ error: s3InitError || "S3 not connected" });
  if (!mongoDb) return res.status(503).json({ error: mongoInitError || "MongoDB not connected" });
  try {
    const doc = await mongoDb.collection("uploads").findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: "File not found" });
    await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: doc.s3Key }));
    await mongoDb.collection("uploads").deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
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

  let demoTestRaw = null;
  let demoTestDisplayError = null;
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    demoTestDisplayError = "REDIS_URL not set";
  } else if (!redisClient || redisInitError) {
    demoTestDisplayError = redisInitError || "not connected";
  } else {
    try {
      demoTestRaw = await redisClient.get(redisKey(DEMO_TEST_LOGICAL_KEY));
    } catch (e) {
      demoTestDisplayError = String(e?.message || e);
    }
  }

  let demoTestFormatted = null;
  if (demoTestRaw !== null) {
    try {
      demoTestFormatted = JSON.stringify(JSON.parse(demoTestRaw), null, 2);
    } catch {
      demoTestFormatted = null;
    }
  }

  const { value: counterValue, error: counterError } = await getCounter();

  const { appName: mongoAppName, error: mongoReadError } =
    await getAppNameFromMongo();

  const mysqlCfg = getMysqlConfig();
  const mysqlMasked = mysqlCfg
    ? `mysql://${mysqlCfg.user}:****@${mysqlCfg.host}:${mysqlCfg.port}/${mysqlCfg.database}`
    : "(not set)";

  const s3Cfg = getS3Config();
  const s3EndpointDisplay = s3Cfg
    ? (s3Cfg.endpoint || "AWS S3 (default)") + " / bucket: " + (s3Bucket || s3Cfg.bucket)
    : "(not set)";

  const url = getDatabaseUrl();
  const masked = url
    ? url.replace(/:([^:@/]+)@/, ":****@")
    : "(not set)";

  const mongoUri = getMongoUri();
  const mongoMasked = mongoUri
    ? mongoUri.replace(/:([^:@/]+)@/, ":****@")
    : "(not set)";

  const redisMasked = redisUrl
    ? redisUrl.replace(/:([^:@/]+)@/, ":****@")
    : "(not set)";

  const redisKeyEffective = redisUrl ? redisKey(DEMO_TEST_LOGICAL_KEY) : null;
  const redisPrefixDisplay = getRedisKeyPrefix() || "(none)";

  const envCustom = getEnvCustom();

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo lander — Deployer + Postgres + MongoDB + Redis + MySQL + S3</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7ecf3; }
    body { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.5rem; font-weight: 600; }
    .ok { color: #7ee787; }
    .bad { color: #ff7b72; }
    code, pre { font-size: 0.85rem; background: #1c2333; padding: 0.2em 0.45em; border-radius: 4px; }
    pre { padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    a { color: #79c0ff; }
    .counter-box { margin: 1.5rem 0; padding: 1.25rem; background: #1c2333; border-radius: 8px; text-align: center; }
    .counter-value { font-size: 2.5rem; font-weight: 700; font-variant-numeric: tabular-nums; margin: 0.5rem 0; }
    .counter-buttons { display: flex; gap: 0.5rem; justify-content: center; margin-top: 0.75rem; }
    .counter-buttons button, .upload-box button {
      font-size: 0.9rem; font-weight: 600; padding: 0.4rem 1rem; border: none;
      border-radius: 6px; cursor: pointer; transition: opacity 0.15s;
    }
    .counter-buttons button:hover, .upload-box button:hover { opacity: 0.85; }
    .counter-buttons button:disabled, .upload-box button:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-inc, .btn-upload { background: #238636; color: #fff; }
    .btn-dec, .btn-del { background: #da3633; color: #fff; }
    .btn-reset { background: #30363d; color: #c9d1d9; }
    .upload-box { margin: 1.5rem 0; padding: 1.25rem; background: #1c2333; border-radius: 8px; }
    .upload-box h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.75rem; }
    .upload-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .upload-form input[type="file"] { flex: 1; min-width: 0; font-size: 0.85rem; color: #c9d1d9; }
    .upload-status { font-size: 0.8rem; margin-top: 0.5rem; min-height: 1.2em; }
    .file-table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.85rem; }
    .file-table th { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #30363d; opacity: 0.7; font-weight: 500; }
    .file-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #1c2333; }
    .file-table a { text-decoration: none; }
    .btn-del { font-size: 0.75rem; padding: 0.2rem 0.5rem; }
    .env-custom-banner { margin: 0.75rem 0 1rem; padding: 0.75rem 1rem; background: #1c2333; border-radius: 8px; border-left: 4px solid #79c0ff; }
  </style>
</head>
<body>
  <h1>${
    mongoAppName !== null
      ? escapeHtml(String(mongoAppName))
      : "Demo lander for Deployer"
  }</h1>
  <p class="env-custom-banner"><code>ENV_CUSTOM</code>: ${
    envCustom !== null
      ? `<span class="ok">${escapeHtml(envCustom)}</span>`
      : `<span class="bad">(not set)</span>`
  }</p>
  <p>This app is meant to be deployed with <strong>Deployer</strong>, <strong>Postgres</strong> for visits, <strong>MongoDB</strong> for the headline app name and file metadata, <strong>Redis</strong> for the <code>demo_test</code> value, <strong>MySQL</strong> for the atomic counter, and <strong>S3/MinIO</strong> for file uploads.</p>

  <div class="counter-box">
    <div style="font-size:0.85rem;opacity:0.7;text-transform:uppercase;letter-spacing:0.05em">Atomic Counter <span style="opacity:0.5">(MySQL)</span></div>
    ${
      counterValue !== null
        ? `<div class="counter-value ok" id="counter-value">${escapeHtml(String(counterValue))}</div>`
        : `<div class="counter-value bad" id="counter-value">${escapeHtml(counterError || "not connected")}</div>`
    }
    <div class="counter-buttons">
      <button class="btn-dec" onclick="counterAction('decrement')" ${counterValue === null ? "disabled" : ""}>&#x2212; Decrement</button>
      <button class="btn-reset" onclick="counterAction('reset')" ${counterValue === null ? "disabled" : ""}>Reset</button>
      <button class="btn-inc" onclick="counterAction('increment')" ${counterValue === null ? "disabled" : ""}>+ Increment</button>
    </div>
  </div>
  <script>
    async function counterAction(action) {
      try {
        const r = await fetch('/api/counter/' + action, { method: 'POST' });
        const d = await r.json();
        const el = document.getElementById('counter-value');
        if (d.error) { el.textContent = d.error; el.className = 'counter-value bad'; }
        else { el.textContent = d.value; el.className = 'counter-value ok'; }
      } catch (e) { console.error(e); }
    }
  </script>

  <div class="upload-box">
    <h2>File Uploads <span style="opacity:0.5">(S3/MinIO + MongoDB)</span></h2>
    ${s3Client && mongoDb ? `
    <div class="upload-form">
      <input type="file" id="file-input" />
      <button class="btn-upload" onclick="uploadFile()">Upload</button>
    </div>
    <div class="upload-status" id="upload-status"></div>
    <table class="file-table">
      <thead><tr><th>Name</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
      <tbody id="file-list"><tr><td colspan="4" style="opacity:0.5">Loading...</td></tr></tbody>
    </table>
    <script>
      function fmtSize(b) {
        if (b < 1024) return b + ' B';
        if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
        return (b/1024/1024).toFixed(1) + ' MB';
      }
      function fmtDate(d) { return new Date(d).toLocaleString(); }
      async function loadFiles() {
        try {
          const r = await fetch('/api/files');
          const files = await r.json();
          const tb = document.getElementById('file-list');
          if (!files.length) { tb.innerHTML = '<tr><td colspan="4" style="opacity:0.5">No files uploaded yet</td></tr>'; return; }
          tb.innerHTML = files.map(f => '<tr>'
            + '<td><a href="/api/files/' + f._id + '/download">' + esc(f.originalName) + '</a></td>'
            + '<td>' + fmtSize(f.size) + '</td>'
            + '<td>' + fmtDate(f.uploadedAt) + '</td>'
            + '<td><button class="btn-del" onclick="deleteFile(\\'' + f._id + '\\')">Delete</button></td>'
            + '</tr>').join('');
        } catch(e) { console.error(e); }
      }
      function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
      async function uploadFile() {
        const inp = document.getElementById('file-input');
        const st = document.getElementById('upload-status');
        if (!inp.files.length) { st.textContent = 'Select a file first'; st.className = 'upload-status bad'; return; }
        st.textContent = 'Uploading...'; st.className = 'upload-status';
        const fd = new FormData(); fd.append('file', inp.files[0]);
        try {
          const r = await fetch('/api/files/upload', { method: 'POST', body: fd });
          const d = await r.json();
          if (d.error) { st.textContent = d.error; st.className = 'upload-status bad'; }
          else { st.textContent = 'Uploaded ' + d.originalName; st.className = 'upload-status ok'; inp.value = ''; loadFiles(); }
        } catch(e) { st.textContent = String(e); st.className = 'upload-status bad'; }
      }
      async function deleteFile(id) {
        try {
          await fetch('/api/files/' + id, { method: 'DELETE' });
          loadFiles();
        } catch(e) { console.error(e); }
      }
      loadFiles();
    </script>
    ` : `<p class="bad">${escapeHtml(s3InitError || mongoInitError || "S3 or MongoDB not connected")}</p>`}
  </div>

  <ul>
    <li>Compose file: <code>docker-compose.prod.yml</code></li>
    <li><code>ENV_CUSTOM</code>: ${
      envCustom !== null
        ? `<span class="ok">${escapeHtml(envCustom)}</span>`
        : `<span class="bad">(not set)</span>`
    }</li>
    <li>App name (from MongoDB <code>app_meta</code>): ${
      mongoAppName !== null
        ? `<span class="ok">${escapeHtml(String(mongoAppName))}</span>`
        : `<span class="bad">${mongoReadError ? escapeHtml(mongoReadError) : "not connected"}</span>`
    }</li>
    <li>Postgres URL (masked): <code>${escapeHtml(masked)}</code></li>
    <li>MongoDB URI (masked): <code>${escapeHtml(mongoMasked)}</code></li>
    <li>Redis URL (masked): <code>${escapeHtml(redisMasked)}</code></li>
    <li><code>REDIS_KEY_PREFIX</code>: <code>${escapeHtml(redisPrefixDisplay)}</code></li>
    <li>MySQL (masked): <code>${escapeHtml(mysqlMasked)}</code></li>
    <li>S3/MinIO: ${
      s3Client
        ? `<span class="ok">${escapeHtml(s3EndpointDisplay)}</span>`
        : `<span class="bad">${escapeHtml(s3InitError || "not connected")}</span>`
    }</li>
    <li>Redis key <code>${escapeHtml(redisKeyEffective ?? DEMO_TEST_LOGICAL_KEY)}</code> (no TTL, set at startup): ${
      demoTestRaw !== null
        ? `<pre class="ok">${escapeHtml(
            demoTestFormatted ?? demoTestRaw
          )}</pre>`
        : `<span class="bad">${escapeHtml(demoTestDisplayError)}</span>`
    }</li>
    <li>Visit count (from Postgres): ${
      visitCount !== null
        ? `<span class="ok">${escapeHtml(String(visitCount))}</span>`
        : `<span class="bad">${lastPgError ? escapeHtml(lastPgError) : "not connected"}</span>`
    }</li>
    <li>Atomic counter (from MySQL): ${
      counterValue !== null
        ? `<span class="ok">${escapeHtml(String(counterValue))}</span>`
        : `<span class="bad">${counterError ? escapeHtml(counterError) : "not connected"}</span>`
    }</li>
  </ul>
  <p>Each page load inserts a row into <code>visits</code>; refresh to see the count increase when Postgres is healthy. The headline reads <code>appName</code> from MongoDB (seeded on first connect; override with <code>APP_NAME</code> or edit the document). Use the counter buttons to test atomic MySQL operations and the upload section to test S3/MinIO storage.</p>
  <p><a href="/health"><code>/health</code></a> — returns <code>ok</code> when every configured database or cache initialized cleanly.</p>
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
await initRedis();
await initMysql();
await initS3();

app.listen(port, "0.0.0.0", () => {
  console.log(`demo-lander listening on :${port}`);
});
