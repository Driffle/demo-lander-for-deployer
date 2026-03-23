# demo-lander-for-deployer

Minimal Node + Express app with **PostgreSQL** for end-to-end testing of Deployer (Git deploy + platform Postgres).

## Deployer setup

1. Start the Deployer platform stack (Postgres must be running on `deployer_platform`).
2. Register an app pointing at this repository, branch `main`, compose file `docker-compose.prod.yml`.
3. Enable the **Postgres** backend for the app.
4. Deploy. Deployer generates `.deployer.env` with `DATABASE_URL` and attaches your `web` service to `deployer_platform`.

## Local Docker (optional)

With a Postgres URL:

```bash
export DATABASE_URL=postgresql://user:pass@host:5432/dbname
docker compose -f docker-compose.prod.yml up --build
```

Open http://localhost:3000 — the home page increments a `visits` counter in the database.

## Endpoints

- `GET /` — HTML status page
- `GET /health` — `ok` if the database connected during startup, otherwise `degraded`
