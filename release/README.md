# Release

The VPS never builds Client Desk from source. GitHub Actions (`.github/workflows/image.yml`) builds the desk
service's `Dockerfile`, publishes `ghcr.io/hamchowderr/client-desk-desk:sha-<commit>` on every push to `main`,
then moves the `release/client-desk` branch to that commit.

Coolify deploys from `release/client-desk` with `release/docker-compose.yml`. It sets `SOURCE_COMMIT` to the
deployed commit, so the desk service runs the image built from exactly that commit; doltgres runs its pinned
Docker Hub image. `docker-compose.yaml` at the repo root still builds from source, for local use.

The release branch only moves forward: the workflow never force-pushes, so a re-run of an older commit cannot
roll the app back. The GHCR package is private; the VPS pulls it with its own ghcr.io login.

Keep `release/docker-compose.yml` in step with `docker-compose.yaml`: only desk's `build: .` differs.
