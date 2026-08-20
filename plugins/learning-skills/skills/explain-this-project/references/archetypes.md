# Recon and archetypes

Read at Steps 1–2. Purpose: work out what kind of project this is with a handful
of cheap commands, then aim the document at that kind of project.

---

## 1. Recon commands

Run these before opening anything by hand. They're cheap and they usually settle
the archetype in one pass.

```bash
# Tracked files only — never drowns in node_modules / vendor / target
git ls-files | head -300
git ls-files | wc -l

# Which languages and how much of each
git ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20

# Manifests, infra, entry points — the highest-signal files in any repo
git ls-files | grep -Ei '(package|go|cargo|pyproject|pom|build\.gradle|composer|Gemfile|mix)\.(json|mod|toml|xml|gradle|lock)?$|dockerfile|docker-compose|\.tf$|^(k8s|helm|charts|deploy)/|\.github/workflows/|Makefile'

# What the project actually depends on
cat package.json go.mod pyproject.toml Cargo.toml 2>/dev/null | head -120

# How many deployable units exist — the microservices question, answered
grep -E '^\s{2}[a-z0-9_-]+:' docker-compose.y*ml 2>/dev/null
git ls-files | grep -i dockerfile

# Entry points
git ls-files | grep -Ei '(^|/)(main|index|app|server|program)\.[a-z]+$|^cmd/|^src/main'

# Where the outside world comes in
git grep -lE '(router|Route|@(Get|Post)Mapping|app\.(get|post)|http\.Handle|@app\.route)' | head -20

# What history says the team actually works on
git log --oneline -15
```

Stop when the picture is clear. More reading past that point produces vaguer
output, not sharper output — the specifics crowd each other out.

---

## 2. Identifying the archetype

| Archetype | Signals |
|---|---|
| **Multi-service backend** | 2+ services in `docker-compose.yml`, several Dockerfiles, `k8s/` or `helm/`, `services/*` or `apps/*`, a broker (Kafka/Rabbit/NATS/SQS) in deps, `*.proto` |
| **Single-service backend** | one Dockerfile, one manifest, `handlers|controllers` + `models`, one database |
| **Frontend SPA** | React/Vue/Svelte/Angular, `vite`/`webpack`, `index.html` with an empty mount div, `router`, no server code |
| **Server-rendered / full-stack framework** | Next, Nuxt, Remix, Django, Rails, Laravel, Phoenix; `pages/` or `app/`, templates, its own migrations |
| **Monorepo** | `packages/`/`apps/`, `turbo.json`, `nx.json`, `pnpm-workspace.yaml`, `go.work`, Lerna |
| **Library / SDK** | publish config, `exports` field, no entry point that starts anything, examples in README, wide version support matrix |
| **CLI** | `cmd/`, `bin/`, argument parser (cobra, clap, argparse, commander), `console_scripts` |
| **Data pipeline** | Airflow/Dagster/dbt, `dags/`, scheduled jobs, warehouse connectors |
| **Mobile** | `android/`, `ios/`, `pubspec.yaml`, `*.xcodeproj`, React Native |

**Monorepo:** don't try to explain everything. Pick the part the user opened it
for, or the largest by tracked-file count, name that choice in section 1, and say
one sentence about what else lives here.

**Library/SDK:** the six sections still apply, but section 3 traces a call from
the consumer's side — someone installs the package, calls one function, and you
follow it inward. That's the equivalent of a request.

---

## 3. What each archetype's document should emphasize

### Multi-service backend
- **Map (§2):** one box per deployable service, plus databases and brokers as external boxes. Take the box list straight from `docker-compose.yml` or the k8s manifests — that's the real topology, not the folder names.
- **Trace (§3):** one request crossing at least one service boundary. The moment of crossing is the whole point: this is where a beginner first sees that a function call can go over a network and fail.
- **Principles worth checking:** service boundaries, gateway, message queue, idempotency, retry/backoff, database per service, eventual consistency, health checks, stateless.
- **Risks (§5):** a service is down; a message arrives twice; two requests write the same row at once; the network is slow rather than broken.

### Frontend SPA
- **Map (§2):** layers rather than services — routes/pages, shared components, state store, API layer, backend as an external box.
- **Trace (§3):** what happens between the click and the pixels: event → state change → request → cache → re-render.
- **Principles worth checking:** components, state management, data fetching layer, rendering strategy, bundling and code splitting, contract with the backend.
- **Risks (§5):** request fails and the screen has nothing to show; two screens show stale versions of the same data; the first load is huge; the token expires mid-session.

### Server-rendered / full-stack framework
- **Map (§2):** what runs on the server, what runs in the browser, what's decided at build time. Beginners find this split genuinely confusing and it's worth being slow about.
- **Trace (§3):** a full page load, from URL to HTML to hydration.
- **Principles worth checking:** rendering strategy, layers, migrations, config, caching, sessions/auth.

### Single-service backend
- **Map (§2):** layers inside one box.
- **Trace (§3):** one endpoint end to end, all the way to SQL.
- **Principles worth checking:** layers, separation of concerns, dependency injection, migrations, transactions, config, tests.

### CLI / library / pipeline
- **Map (§2):** input → stages → output.
- **Trace (§3):** one invocation, or one call by a consumer.
- **Principles worth checking:** contract, config, separation of concerns, tests, versioning.

---

## 4. Learning-path skeletons (§6)

Skeletons, not answers. Cut anything the repo doesn't use, add what it does, and
reorder so each item is genuinely reachable from the one before it. The order and
the "why here" are what make the section worth reading.

**Multi-service backend**
1. One language well enough to read it — HTTP and JSON — what a database is and basic SQL — how one server handles one request
2. Client/server model; why a network call can fail when a function call can't
3. One web framework in that language; routing, handlers, middleware
4. Data storage: schema, indexes, transactions, migrations
5. Containers: why "works on my machine" stops being an argument
6. Splitting into services; how they find and call each other
7. Asynchronous messaging and queues
8. Delivery guarantees: retries, duplicates, idempotency
9. Observability: logs, metrics, tracing across services
10. Deployment and orchestration (this is where Kubernetes belongs — and not earlier)

**Frontend**
1. HTML/CSS — JavaScript — what the browser actually does with a page
2. The DOM, events, and why redrawing by hand gets unmanageable
3. A component framework; props and local state
4. Routing and the difference between a page and a screen
5. Talking to a backend: fetch, async, errors, loading states
6. Shared state and when local state stops being enough
7. Caching and staleness on the client
8. Build tooling: bundlers, splitting, environment variables
9. Rendering strategies (CSR/SSR/SSG) and what each costs
10. Types, tests, accessibility, performance budgets

Every item should point at something in this repo — "you'll see this in
`internal/queue/consumer.go`". Untethered, the list is just a syllabus the reader
could have googled; tethered, it's a map of the thing in front of them.
