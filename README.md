# demo-lander-for-deployer

Minimal Node + Express app with **PostgreSQL** for end-to-end testing of Deployer (Git deploy + platform Postgres).

## Deployer setup

This repo’s `docker-compose.prod.yml` includes a **bundled Postgres** (`db`) plus **web**, same as local Docker.

1. Register an app pointing at this repository, branch `main`, compose file `docker-compose.prod.yml`.
2. Leave **MySQL / Postgres / Redis / Mongo** backends **off** for this app (the stack already provides its own database; enabling platform Postgres would merge conflicting `DATABASE_URL` behavior).
3. Deploy. Compose brings up `db` and `web` on the default project network.

## Local Docker (with Postgres)

`docker-compose.yml` only includes `docker-compose.prod.yml`, so local and prod compose stay identical.

Configuration is driven by a **`.env`** file in the repo root (not committed; see `.gitignore`). Copy the template and edit as needed:

```bash
cp .env.example .env
docker compose up -d --build
```

Docker Compose loads `.env` automatically for `${VAR}` substitution in `docker-compose.prod.yml` (database credentials, app URLs, MinIO/S3, `ENV_CUSTOM`, etc.).

The **`web`** service also uses `env_file: .env`, so **any** variable you add to `.env` is passed into the Node container. Keys listed again under `web.environment` in `docker-compose.prod.yml` **override** the same name from `.env` (for example `DATABASE_URL` is always built from the Postgres settings in compose, not a raw `DATABASE_URL` line alone).

Open http://localhost:3000 — each request inserts into `visits` and shows the total count. Stop with `docker compose down` (add `-v` to drop the database volume).

If you change `ENV_CUSTOM` or other app code but the UI looks stale, rebuild the image so the container runs the latest `server.js`:

```bash
docker compose up -d --build --force-recreate web
```

To confirm Node sees `ENV_CUSTOM` (same source as the landing page), open http://localhost:3000/api/env-custom — it should return JSON with `ENV_CUSTOM` and `parsed`.

## Endpoints

- `GET /` — HTML status page
- `GET /health` — `ok` if the database connected during startup, otherwise `degraded`
- `GET /api/env-custom` — JSON with raw `ENV_CUSTOM` and parsed value (debug)
