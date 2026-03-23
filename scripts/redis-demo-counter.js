/**
 * Sidecar: every INTERVAL_MS, read demo_test JSON from Redis, ensure numeric `count`
 * (default 0), increment, and write back. Preserves other JSON fields.
 */
import { createClient } from "redis";

const INTERVAL_MS = 10_000;
const DEMO_TEST_LOGICAL_KEY = "demo_test";

function getRedisUrl() {
  return process.env.REDIS_URL || null;
}

function getRedisKeyPrefix() {
  const p = (process.env.REDIS_KEY_PREFIX || "").trim();
  return p.replace(/:+$/, "");
}

function redisKey(logicalKey) {
  const p = getRedisKeyPrefix();
  return p ? `${p}:${logicalKey}` : logicalKey;
}

function parseDemoTestObject(raw) {
  if (raw == null || raw === "") return {};
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return v;
  } catch {
    return {};
  }
}

function normalizeCount(obj) {
  const c = obj.count;
  if (typeof c === "number" && Number.isFinite(c)) return c;
  return 0;
}

async function tick(client, key) {
  const raw = await client.get(key);
  const obj = parseDemoTestObject(raw);
  const next = { ...obj, count: normalizeCount(obj) + 1 };
  await client.set(key, JSON.stringify(next));
}

async function main() {
  const url = getRedisUrl();
  if (!url) {
    console.error("redis-demo-counter: REDIS_URL not set, exiting");
    process.exit(1);
  }

  const client = createClient({ url });
  client.on("error", (err) => {
    console.error("Redis client error:", err);
  });
  await client.connect();

  const key = redisKey(DEMO_TEST_LOGICAL_KEY);
  console.log(
    `redis-demo-counter: key ${key} — tick every ${INTERVAL_MS / 1000}s`,
  );

  const run = async () => {
    try {
      await tick(client, key);
    } catch (e) {
      console.error("redis-demo-counter tick failed:", e?.message || e);
    }
  };

  await run();
  setInterval(run, INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
