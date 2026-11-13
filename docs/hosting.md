# Hosting Cue: guest-mode foundation

This branch starts the hosted version. `main` remains the local application. Nothing here deploys a public service automatically.

The first hosted version is anonymous: visitors can discover, search and play public videos, browse channels, read comments, use Shorts and watch live streams with YouTube's chat embed. Likes, Watch later, history, resume points, profiles and settings stay in that visitor's browser; there are no server accounts or cross-device sync yet. The home page uses a public search, not anyone's signed-in recommendations. Local and hosted browser storage use separate namespaces.

## Application and playback worker

```text
Visitor ── HTTPS ── Caddy ── web gateway :8080
                                  │
                            private network
                            + shared secret
                                  │
                              worker :3001 ── YouTube
```

Like AnimeKaiser's separation of its web app and streaming implementation, Cue now has a small read-only worker interface. It keeps the existing TypeScript frontend and player rather than adopting a new framework.

- **Public web image:** static browser files and `server/hosted-main.ts`. It has no `yt-dlp`, FFmpeg, cookie exporter, or local account backend. The gateway accepts only named read-only routes and forwards media ranges with backpressure and cancellation. It does not accept an arbitrary destination URL. The browser never receives the worker secret.
- **Private worker image:** the existing resolver and media relay in restricted `CUE_MODE=worker`. Every request needs the worker secret. Only the read-only interface is reachable; static pages, browser-cookie import, account operations, downloads and AI-caption operations are refused. Playback never falls back to saved cookies in this mode.
- **Resolver isolation:** worker commands ignore the machine's yt-dlp configuration and plugin directories, use a worker-local cache, and explicitly enable Node for JavaScript challenges. The image installs `yt-dlp[default]` to include the matching solver scripts, following [yt-dlp's setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
- **Separate data:** workers require an explicit absolute `CUE_DATA_DIR`, outside the local `data/`, public assets and build output (including symlink aliases). The container uses its own volume. Do not mount the local application's `data/`, accounts directory or browser profiles into either hosted container.
- **Compatibility check:** the gateway requires the worker protocol header, so accidentally pointing it at an ordinary local Cue server does not expose that server's responses.
- **Outages:** the web shell, browser library and settings still work when the worker is down. Worker-backed features report unavailability rather than loading the owner's data as a fallback.

The source for both images remains in this branch. “Private worker” means private network access, not a separate private GitHub repository. Splitting the processes does not remove responsibility for the content and traffic a deployment serves.

## Guest feature limits

| Capability | Local Cue | Guest hosting |
| --- | --- | --- |
| Public discovery, search, VOD, live, comments and Shorts | Yes | Yes |
| Video insights | Optional | Optional |
| History, likes, Watch later, settings | Browser profiles | Browser profiles, separate namespace |
| YouTube subscriptions, personal recommendations and private/member videos | Connected account | Unavailable |
| Browser-cookie import | Local browsers | Unavailable |
| Downloads and local AI transcription | Yes | Unavailable |
| Custom extension modules | Trusted user modules | Unavailable; built-in insights only |

The unavailable operations are blocked in both the gateway and worker, not just hidden in the interface. Downloads and transcription need independent resource budgets and job ownership before being offered publicly. Browser-cookie export is a local feature and must never be offered by a public server.

## Run the split locally with Docker

Requires Docker with Compose. The local application on port 3000 can continue running independently.

1. Copy `.env.hosted.example` to `.env.hosted`.
2. Generate a worker secret with `openssl rand -hex 32` and put it in `CUE_WORKER_SECRET` in `.env.hosted`. Keep this file private. Do not use a short or example secret.
3. Start the two containers:

```sh
docker compose --env-file .env.hosted -f compose.hosted.yml up --build -d
```

Open `http://localhost:8080`. The worker port is not published. Both containers run as a non-root user with read-only root filesystems; only the worker's separate volume and temporary directory are writable.

`/healthz` reports web liveness. `/readyz` checks the authenticated worker connection, without making a YouTube request; it does not guarantee that YouTube extraction will succeed.

To stop without deleting the worker volume:

```sh
docker compose --env-file .env.hosted -f compose.hosted.yml down
```

## Run without containers for development

Build once with `npm ci && npm run build`. Give both processes the same generated worker secret in their environment. In separate terminals:

```sh
# Worker: an isolated directory; never the local data/ folder.
CUE_DATA_DIR="$PWD/hosted-data" PORT=3001 npm run start:worker

# Public gateway: CUE_WORKER_SECRET must also be set in this terminal.
CUE_PUBLIC_ORIGIN=http://localhost:8080 npm run start:web
```

`npm start` and `npm run dev` continue to start local Cue by default, on loopback. The hosted entry points do not read `.env.hosted` automatically; Compose loads it, or use your process manager's environment configuration.

## Connect a public domain

1. Choose a server and domain. Point the domain's DNS at the server.
2. Set `CUE_PUBLIC_ORIGIN=https://your-domain` exactly; paths, credentials and HTTP public origins are rejected.
3. Put Caddy or an equivalent TLS reverse proxy in front of `127.0.0.1:8080`; `deploy/Caddyfile.example` is a starting point.
4. Only with one trusted proxy that overwrites `X-Forwarded-For`, set `CUE_TRUST_PROXY=1`. Otherwise leave it off. The gateway never trusts forwarded host/origin headers. Behind an unconfigured proxy, visitors share the proxy's rate bucket rather than trusting attacker-supplied IPs.
5. Keep ports 3001 and 8080 off the public interface. Use HTTPS or a private tunnel if the worker is on another machine; a shared secret over public plain HTTP is not sufficient.

The gateway defaults to 120 request units per IP per minute (expensive operations cost four), four simultaneous expensive requests globally and 32 simultaneous upstream requests globally, with at most eight active per IP and two expensive requests per IP. `CUE_MAX_HEAVY`, `CUE_MAX_MEDIA` and `CUE_REQUESTS_PER_MINUTE` tune these. The worker also bounds resolver concurrency, execution time, image sizes and cache entries. Static responses are not proxied through the worker.

These are **process-local admission limits**, not a complete abuse or bandwidth system. They reset when the process restarts, are not shared across replicas, and do not cap total bytes transferred. Before inviting unrestricted traffic, configure edge rate limits and a hosting-provider bandwidth budget, verify these settings against the expected workload, and add operational monitoring. Stream traffic still passes through the servers. YouTube availability must be checked from the actual hosting provider; successful playback on a laptop does not establish cloud availability.

## Current validation and remaining deployment work

Automated tests exercise worker authentication, disabled capabilities, protocol compatibility, origin/host checks, credential stripping, profile stripping, ranged media, resource admission and worker failure handling, alongside the local application's tests.

Still to do on the chosen host: build and run the container images, configure DNS and TLS, verify actual VOD/live/Shorts playback from that network, set bandwidth and edge-abuse controls, and perform a load test. Accounts, cloud libraries and personal YouTube integration are later milestones if wanted. This foundation is not a claim that an untested unrestricted deployment is production-ready.
