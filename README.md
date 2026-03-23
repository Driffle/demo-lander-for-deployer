# demo-lander-for-deployer

Minimal Node + Express app with **PostgreSQL** for end-to-end testing of Deployer (Git deploy + platform Postgres).

## Deployer setup

This repo’s `docker-compose.prod.yml` includes a **bundled Postgres** (`db`) plus **web**, same as local Docker.

1. Register an app pointing at this repository, branch `main`, compose file `docker-compose.prod.yml`.
2. Leave **MySQL / Postgres / Redis / Mongo** backends **off** for this app (the stack already provides its own database; enabling platform Postgres would merge conflicting `DATABASE_URL` behavior).
3. Deploy. Compose brings up `db` and `web` on the default project network.

## Local Docker (with Postgres)

`docker-compose.yml` only includes `docker-compose.prod.yml`, so local and prod compose stay identical.

```bash
docker compose up -d --build
```

Open http://localhost:3000 — each request inserts into `visits` and shows the total count. Stop with `docker compose down` (add `-v` to drop the database volume).

## Endpoints

- `GET /` — HTML status page
- `GET /health` — `ok` if the database connected during startup, otherwise `degraded`
