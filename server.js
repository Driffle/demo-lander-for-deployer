import express from "express";
import pg from "pg";

const app = express();
const port = Number(process.env.PORT) || 3000;

let pool = null;
let dbError = null;

function getDatabaseUrl() {
  return process.env.DATABASE_URL || null;
}

async function initDb() {
  const url = getDatabaseUrl();
  if (!url) {
    dbError = "DATABASE_URL is not set (expected when running under Deployer with Postgres enabled).";
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

app.get("/health", (_req, res) => {
  res.type("text").send(dbError ? "degraded" : "ok");
});

app.get("/", async (_req, res) => {
  let visitCount = null;
  let lastError = dbError;
  if (pool && !lastError) {
    try {
      await pool.query("INSERT INTO visits DEFAULT VALUES");
      const r = await pool.query("SELECT COUNT(*)::int AS n FROM visits");
      visitCount = r.rows[0]?.n ?? 0;
    } catch (e) {
      lastError = String(e?.message || e);
    }
  }

  const url = getDatabaseUrl();
  const masked = url
    ? url.replace(/:([^:@/]+)@/, ":****@")
    : "(not set)";

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo lander — Deployer + Postgres</title>
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
  <h1>Demo lander for Deployer</h1>
  <p>This app is meant to be deployed with <strong>Deployer</strong> and the <strong>Postgres</strong> backend enabled.</p>
  <ul>
    <li>Compose file: <code>docker-compose.prod.yml</code></li>
    <li>Database URL (masked): <code>${escapeHtml(masked)}</code></li>
    <li>Visit count (from Postgres): ${
      visitCount !== null
        ? `<span class="ok">${escapeHtml(String(visitCount))}</span>`
        : `<span class="bad">${lastError ? escapeHtml(lastError) : "not connected"}</span>`
    }</li>
  </ul>
  <p>Each page load inserts a row into <code>visits</code>; refresh to see the count increase when the DB is healthy.</p>
  <p><a href="/health"><code>/health</code></a> — returns <code>ok</code> when the database initialized cleanly.</p>
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

app.listen(port, "0.0.0.0", () => {
  console.log(`demo-lander listening on :${port}`);
});
