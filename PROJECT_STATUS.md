# Project Status

## Research project

**Topic:** Latency-Aware Task Offloading Between Edge Nodes and Cloud for Containerized Microservices

## Current phase

**Complete — all planned phases 0–8**

All phases are implemented and verified. No additional phase is pending.

## Initial inspection

- The requested project directory `/home/uzueer/Edge` contains no application source files or project configuration. Only environment-provided `.agents`, `.aws`, `.codex`, and `.git` entries were visible.
- Git resolves its top-level directory to `/home/uzueer`, not `/home/uzueer/Edge`. The latest commit is `7b99588` (`first commit`).
- The enclosing repository has pre-existing unrelated changes, including a deleted `/home/uzueer/README.md` and many untracked entries outside this project directory. No files in `/home/uzueer/Edge` were reported as changed by the scoped status check. These surrounding files were left untouched.
- There are no existing project tests to run in this directory.

## Planned architecture

The application will be built in the requested phase order. Research calculations, measurement provenance, controlled methodology, and reproducibility take priority over dashboard work.

1. **Scheduling core (Node.js):** Keep latency estimation, node health/resource eligibility, and Round Robin, Edge-only, and latency-aware policies as separable modules. Filter unhealthy or resource-ineligible nodes before making a choice. Model predicted total latency as predicted network delay + predicted queueing delay + predicted execution time. Keep predictions separate from actual worker measurements.
2. **Persistence (PostgreSQL):** Add versioned migrations for nodes, measurements, tasks, decisions, experiments, and results. Validate database access and persist algorithm choices and their component estimates; test constraints, relationships, transactions, and retrieval.
3. **Workers (Docker Compose):** Provide independently addressable `edge-1`, `edge-2`, and `cloud-1` services with health checks, bounded deterministic CPU-bound computations, execution timing, and verifiable outputs. Label configured capacity and simulated network delay; containers on one host do not represent geographically distributed infrastructure.
4. **Backend/orchestration (Express):** Expose task submission/status and node monitoring, connect the schedulers to workers, persist lifecycle events and decisions, and handle timeouts, failures, duplicate submissions, and unavailable nodes.
5. **Experiments (Node.js):** Compare all policies using equivalent task traces and controlled initial conditions. Record workload, complexity, arrival interval, configured delay/capacity, random seed, and repetitions. Calculate response-time distribution, throughput, success/failure, queue wait, execution time, scheduling overhead, node distribution, prediction error, and relative performance. Export traceable CSV/JSON without assuming an outcome.
6. **Analysis (Python):** Use Pandas/NumPy on actual exported runs for descriptive statistics, confidence intervals, and appropriate comparisons. Generate publication-quality Matplotlib PNG/PDF charts with scripts that reproduce them; synthetic fixtures must not be presented as experimental evidence.
7. **Dashboard (React/Vite):** Build a minimal interface for node state, task submission/results, predicted versus actual latency, experiment setup/progress/comparison, charts, and CSV/JSON export using backend data.
8. **Integration and methodology:** Verify clean setup, persistence, workers, policies, experiments, exports, and reproducible graph generation. Complete usage and methodology documentation and disclose limitations.

### Phase acceptance criteria

| Phase | Exit criteria |
|---|---|
| 0 | Existing work and Git state inspected; architecture, assumptions, phase plan, and status tracking documented. |
| 1 | Independent model and all three algorithms pass hand-calculated unit tests, including eligibility and edge cases. |
| 2 | Migrations and persistence survive backend restarts; database constraints and integration tests pass. |
| 3 | Three workers start, pass health checks, execute bounded tasks, and return verifiable outputs. |
| 4 | API submissions schedule and execute on workers with predictions, observations, and lifecycle records kept distinct. |
| 5 | Equivalent controlled traces run across policies and produce persisted, traceable CSV/JSON results. |
| 6 | Analysis and every graph regenerate from exported experimental data with documented statistical methods. |
| 7 | Dashboard can submit tasks, inspect actual results, and compare completed experiments from backend data. |
| 8 | Clean-start instructions, full test suite, persistence, workers, experiments, exports, graphs, and research limitations are verified/documented. |

## Phase plan and gates

| Phase | Scope | Status |
|---|---|---|
| 0 | Inspect directory and Git status; document architecture and project state | Complete |
| 1 | Implement and test latency calculations, eligibility, Round Robin, Edge-only, and latency-aware scheduling | Complete |
| 2 | PostgreSQL schemas, migrations, validated persistence, and DB tests | Complete |
| 3 | Three Docker workers with health checks and bounded computation | Complete |
| 4 | Express API, monitoring, and task orchestration | Complete |
| 5 | Controlled experiments, metrics, and CSV/JSON export | Complete |
| 6 | Python statistical analysis and reproducible graphs | Complete |
| 7 | Minimal React/Vite research dashboard | Complete |
| 8 | Clean integration, methodology validation, and final documentation | Complete |

The user authorized sequential progress through all phases without requesting approval at every phase gate. Each phase is still verified and recorded before the next phase begins.

## Phase 0 verification and open items

- **Verification:** Inspected directory contents, repository root, latest commit, and scoped Git status.
- **Tests:** None available or applicable; Phase 0 is documentation and inspection only.
- **Open item:** The project directory is nested inside a broader Git repository. This may affect how changes appear in Git status and should be kept in mind when reviewing project-only changes.
- **Phase 0 acceptance:** Existing directory, project files, and scoped Git state were inspected. The architecture, assumptions, phase sequence, status tracking, and next-phase gate were documented. Later work was performed only after subsequent user approval.

## Phase 1 implementation

- Added a dependency-free ES module project with Node's built-in `node:test` runner.
- Added standalone mathematical functions for fresh RTT-to-one-way network delay, execution duration, queueing wait, total predicted latency, and health/resource eligibility.
- Added common `schedule({ task, nodes, nowMs? })` entry points for deterministic Round Robin, Edge-only, and latency-aware schedulers. Decisions include candidate eligibility; latency-aware decisions include each eligible candidate's component breakdown and the selected breakdown. No eligible candidate returns `selectedNode: null`.
- Latency-aware scheduling removes health/resource-ineligible nodes before computing predictions. Missing, stale, future-dated, or otherwise invalid network inputs make that candidate unusable and report a reason. Predictions are marked and represented separately from measured RTT inputs.
- **Model assumptions:** workload is in MI; processing capacity is MIPS; latency is milliseconds; timestamps are Unix epoch milliseconds. Execution is `1000 * workloadMI / capacityMips`. Queue wait is a fluid approximation `1000 * workAheadMI / (capacityMips * executionSlots)`, assuming identical slots share aggregate queued work evenly. For the request/result offload transaction, network input is RTT and is added once as the transaction's network component.
- **Changed files:** `package.json`, `src/latency-model.js`, `src/schedulers.js`, `test/scheduling.test.js`, and this status document.
- **Verification:** `npm test` passed: 10 tests, 0 failures. Coverage includes each latency component, unit conversion, queue workloads and slots, eligibility, malformed/extreme values, absent/stale/future measurements, no eligible nodes, deterministic tie-breaking, the 20/35/15 ms hand-check including unhealthy exclusion, Round Robin rotation/skipping, and Edge-only cloud exclusion.
- **Remaining issues:** Queueing is an intentionally simple analytical approximation; experiment phases should compare it with worker observations while preserving the distinction between predictions and actual measurements. See phase-specific sections for later infrastructure state.

## Phase 2 implementation

- Added PostgreSQL 16 Compose service configuration with a named data volume and readiness health check, SQL migration `001_initial_schema.sql`, and a checksum-verifying migration runner guarded by a PostgreSQL advisory lock.
- Added a `pg` connection pool and repository methods for nodes, observed node measurements, tasks, scheduling decisions and per-candidate predictions, actual task executions, experiment definitions/runs, and experiment result records. SQL values are parameterized; decision/candidate writes and execution outcome writes use transactions.
- Database constraints enforce roles, algorithm/status vocabularies, units, non-negative values, and foreign-key relationships. Predicted components are persisted separately from measurements and actual execution timings.
- Added `.env.example`, `.gitignore`, Phase 2 database setup notes in `README.md`, and a Node test harness for integration tests.
- **Changed files:** `.gitignore`, `.env.example`, `docker-compose.yml`, `README.md`, `package.json`, `package-lock.json`, `db/migrations/001_initial_schema.sql`, `src/db/pool.js`, `src/db/migrate.js`, `src/db/repository.js`, `test/db.test.js`, `test/run.js`, and this status document.
- **Verification:** Ran `npm run db:migrate` against the local PostgreSQL 16 service; output confirmed `Applied migrations: 001_initial_schema.sql`. Ran `DATABASE_URL=postgres://edge:edge_dev_only@localhost:5432/edge_offloading npm test`: 12 passed, 0 failed, 0 skipped. The integration test verified idempotent migration, database constraints, transaction rollback, inserts/retrieval for each record family, and task/decision persistence after closing and recreating the pool.
- **Assumptions/limitations:** PostgreSQL example credentials are development-only. Integration tests require a reachable PostgreSQL server. Migration files are immutable after application; changes require a new numbered migration. The repository currently exposes persistence primitives; API lifecycle orchestration arrives in Phase 4.

## Phase 3 implementation

- Added a reusable `Dockerfile.worker` and Compose instances named `edge-1`, `edge-2`, and `cloud-1`. Each has a distinct host port, role, configured MIPS/slots/memory, and labeled simulated network RTT.
- Added worker `/health`, `/metrics`, and bounded `POST /execute` endpoints. The deterministic uint32 computation enforces a maximum iteration count and returns a SHA-256 digest. Workers track queue, execution, and worker elapsed time separately and reject excess queued work.
- **Changed files:** `Dockerfile.worker`, `docker-compose.yml`, `src/workers/compute.js`, `src/workers/server.js`, `workers/worker.js`, `test/workers.test.js`, `test/run.js`, and this status document.
- **Verification:** `docker compose config --quiet` succeeded. `npm test` with PostgreSQL reachable passed 14 tests, 0 failed, 0 skipped. `docker compose up -d --build edge-1 edge-2 cloud-1` built and started all three containers. Live endpoint checks reported healthy=true for all; each accepted 50,000 iterations with seed 42, returned HTTP 200 and the same digest `8b92d2eeaa1adb8ed51243cab0ce0b319074638e59524509ae737956e8f1e1b0`, and returned separate non-negative queue/execution timing fields.
- **Limitations:** The containers run on one host. `CAPACITY_MIPS` is a configured scheduler input, not a calibrated hardware benchmark; `SIMULATED_NETWORK_RTT_MS` is configuration metadata, not a measured WAN link. The deterministic iteration workload is bounded but is not itself a conversion to MI. Phase 4 will connect task requests, worker-reported timings, and measured/configured network values to the scheduler and persistence layer.

## Phase 4 implementation

- Added an Express API with health, node monitoring, recent measurement, task submission, and task retrieval routes. The API refreshes health and configured resource state before scheduling, persists measured API probe RTT and simulated RTT as separate sourced observations, then invokes the existing scheduling algorithms.
- Added HTTP worker clients with request timeouts and explicit RTT simulation (half delay before submission and half after response). Tasks have persisted submitted/scheduled/running/terminal lifecycle transitions. Decisions and candidates are persisted before dispatch; execution records keep network provenance, worker queue/execution timings, and API end-to-end response time distinct. Duplicate IDs return 409, malformed/resource-invalid requests return 400, unavailable capacity returns 503, worker errors return 502, and timeouts return 504.
- Added Phase 4 forward migration `002_network_provenance.sql` to store whether actual network delay was measured or simulated. Updated the Phase 1 model to treat RTT as the full request/result transaction network component and count it once; this aligns the predicted component with the API's uplink-plus-downlink simulation rather than predicting only one direction.
- Added `Dockerfile.api` and an API Compose service; added usage and endpoint documentation.
- **Changed files:** `Dockerfile.api`, `.dockerignore`, `docker-compose.yml`, `README.md`, `PROJECT_STATUS.md`, `package.json`, `package-lock.json`, `src/latency-model.js`, `src/db/repository.js`, `src/api/app.js`, `src/api/server.js`, `src/api/workers.js`, `src/workers/compute.js`, `src/workers/server.js`, `Dockerfile.worker`, `db/migrations/002_network_provenance.sql`, `test/scheduling.test.js`, `test/api.test.js`, and `test/run.js`.
- **Verification:** `docker compose config --quiet` succeeded. `RUN_API_INTEGRATION=1 DATABASE_URL=postgres://edge:edge_dev_only@localhost:5432/edge_offloading npm test` passed 15 tests, 0 failures, 0 skips. This included real PostgreSQL and worker integration, all policies through the API, no-eligible handling, duplicate rejection, prediction persistence, and actual network provenance. Rebuilt the full Compose stack successfully; `/health` and `/nodes` returned HTTP 200. A temporary live API submission completed on `edge-1`, returned predicted latency 9.25 ms and simulated actual network delay 8 ms, persisted as succeeded, and its verification rows were removed after retrieval.
- **Limitations:** Configured MIPS does not yet predict deterministic iteration execution time accurately, and the worker's active work ahead is conservatively estimated from full active task workload. Simulated RTT remains a controlled parameter, while API health-probe RTT is a separate local observation. No geographic or physical edge/cloud performance claim is supported.

## Phase 5 implementation

- Added a seeded trace generator with bounded task count, workload MI range, worker iteration range, arrival interval, memory and minimum-capacity requirements, random seed, repetitions, and optional per-node scheduler profiles for MIPS, slots, memory, and simulated RTT.
- The experiment service persists the full configuration and run seeds, replays equivalent task inputs for Round Robin, Edge-only, and latency-aware policies, starts each policy with workers idle, serializes decision order while allowing worker tasks to overlap according to the trace arrivals, rotates policy order by repetition, and stores task-level and aggregate result rows.
- Metrics include mean, median, p95 response time, throughput, success/failure counts and rates, mean queue and execution time, scheduler overhead, node distribution, prediction error, and latency-aware relative performance against both baselines. Values are calculated from actual run data; no expected improvement is embedded.
- Added status/progress, results, and JSON/CSV export API endpoints. Exports retain experiment config, trace IDs/inputs, run seed, estimates, observed timings, and aggregate comparisons.
- **Changed files:** `README.md`, `PROJECT_STATUS.md`, `src/db/repository.js`, `src/api/app.js`, `src/experiments/metrics.js`, `src/experiments/service.js`, `src/experiments/export.js`, `test/experiments.test.js`, `test/api.test.js`, and `test/run.js`.
- **Verification:** `RUN_API_INTEGRATION=1 DATABASE_URL=postgres://edge:edge_dev_only@localhost:5432/edge_offloading npm test` passed 18 tests, 0 failures, 0 skips. The integration test ran all three policies over the same seeded trace against PostgreSQL and the live workers, verified all 9 task rows used equivalent trace inputs, verified 3 aggregate rows and run completion, and exercised CSV and JSON exports. An initial run found PostgreSQL identity IDs were strings; normalization was fixed and the complete suite passed on rerun.
- **Limitations:** MIPS profiles affect scheduler predictions but do not resize or benchmark the host containers. Deterministic loop iterations are not calibrated to MI. Simulated RTT is applied as delays; local probe RTT is separately stored. The run has deterministic arrivals and idle initial queues, but a single-host Compose setup does not model geographic network variation or independent hardware.

## Phase 6 implementation

- Added a pinned Python analysis environment and CLI for actual JSON/CSV exports. Pandas/NumPy analysis includes response/queue/execution/scheduling summaries, nearest-rank p95, run-level bootstrap confidence intervals, trace-paired comparisons, exact sign tests over repetition-level paired means, prediction errors, and relative comparisons.
- Added reproducible Matplotlib PNG/PDF figures for response-time distributions, response-time means with repetition bootstrap intervals, throughput, and predicted/observed latency components. Figures label their experiment ID and same-host/simulated-RTT conditions.
- Added methodology documentation and unit tests. Synthetic test fixtures are used only for parser/statistics unit tests and do not generate figures or claim research findings.
- Generated a validation export from a real Compose experiment: seed `26029`, 6 tasks per policy, 2 repetitions, 36 task rows, and 6 aggregate rows. The raw API export and generated analysis tables/figures are preserved under `analysis/validation/` and labeled as pipeline smoke validation, not research evidence.
- **Changed files:** `.gitignore`, `README.md`, `PROJECT_STATUS.md`, `analysis/requirements.txt`, `analysis/analyze_experiments.py`, `analysis/README.md`, `analysis/tests/test_analysis.py`, `analysis/validation/README.md`, `analysis/validation/compose-smoke-export.json`, `analysis/validation/figures/analysis.json`, `algorithm_summary.csv`, `paired_comparisons.csv`, and eight PNG/PDF figure files.
- **Verification:** `python -m unittest discover -s analysis/tests -v` using the bundled Python runtime plus Matplotlib 3.11.2 passed 3 tests. Ran `analysis/analyze_experiments.py` against the real API JSON export; it processed 36 task records and produced `analysis.json`, two CSV tables, and four PNG/PDF figure pairs. Inspected response-time and latency-component PNGs visually.
- **Limitations:** The validation run has only two repetitions, so interval and comparison resolution is weak; its sign-test output is not evidence of statistical significance. Workers are local containers and their RTTs/capacities are configured/simulated. Larger, independently repeated experiments on appropriately separated hardware are required for research conclusions.

## Phase 7 implementation

- Added a React/Vite dashboard at `frontend/` for live worker status/configuration, task submission and results, seeded experiment setup with editable node profiles, experiment progress, aggregate response/throughput charts, and CSV/JSON exports. All displayed observations and results come from the existing API; frontend code does not fabricate measurements or repeat the scheduling model.
- Added a Vite `/api` proxy, production bundle script, and a Compose development dashboard service at port 5173. The profile editor labels configured MIPS and simulated RTT as model inputs; predictions and actual response/execution values use separate fields.
- Updated `README.md` with dashboard startup and local development commands.
- **Changed files:** `.gitignore`, `Dockerfile.web`, `docker-compose.yml`, `README.md`, `PROJECT_STATUS.md`, `package.json`, `package-lock.json`, `vite.config.js`, `frontend/index.html`, `frontend/src/main.jsx`, `frontend/src/App.jsx`, and `frontend/src/styles.css`.
- **Verification:** `npm run build` succeeded with Vite 8.3.5 (16 modules transformed). `docker compose config --quiet` succeeded. Rebuilt and started the full Compose stack; PostgreSQL, API, all three workers, and dashboard were running, with API/workers/PostgreSQL healthy. Browser inspection confirmed three live node cards, experiment results from the persisted validation run, both export links, and no missing initial page content. `http://localhost:5173/api/health` returned `{"healthy":true,"database":"connected"}` and the proxy returned all three live nodes. The integration suite passed 18 tests, 0 failures, 0 skips.
- **Limitations:** Vite is configured as a development server in Compose; the production bundle is available via `npm run build` but is not served by a separate production web server. Historical progress is unavailable after API restart because live progress is held in memory; persisted experiment/run status and results remain accessible. Dashboard browser verification was manual; API/database/worker integration remains covered by automated Node tests.

## Phase 8 final integration and research validation

- Completed the README with full-stack startup, dashboard operation, API endpoints, integration/Python test commands, analysis regeneration, and research interpretation/limitations instructions.
- Rebuilt and started the Compose stack. Final status: PostgreSQL, API, `edge-1`, `edge-2`, `cloud-1`, and dashboard running; PostgreSQL, API, and all three workers healthy. `docker compose config --quiet` succeeded.
- Verified PostgreSQL persistence across an API container restart: the prior validation experiment retained both succeeded repetitions and all 42 persisted result records. JSON export returned 42 records; CSV export returned its header plus 42 data rows. The API still reported all three workers healthy, and dashboard `/api/health` proxy remained connected.
- Re-ran full Node integration command: `RUN_API_INTEGRATION=1 DATABASE_URL=postgres://edge:edge_dev_only@localhost:5432/edge_offloading npm test` passed 18 tests, 0 failures, 0 skips. This covers model/schedulers, PostgreSQL constraints and restart retrieval, worker execution, API lifecycle, seeded experiments, and exports.
- Re-ran Python analysis unit suite: 3 tests passed. Reproduced analysis from the preserved actual smoke export into `/tmp/edge-phase8-analysis`: 36 task records parsed, `analysis.json` and both CSV tables generated, and all four figures generated as PNG/PDF pairs.
- Re-ran `npm run build`: Vite production bundle succeeded (16 modules transformed). Browser inspection showed live data from all three nodes, the stored experiment summary, and export controls.
- **Changed files:** `README.md` and `PROJECT_STATUS.md` for this phase. The README is the user-facing setup and operating guide.
- **Remaining issues and research limits:** The retained run is only a small same-host pipeline validation, not comparative evidence. Repeat on independent hardware with calibrated compute capacity and workload, real measured network conditions, and more repetitions before making performance or statistical claims. Compose serves the dashboard through Vite's development server; use the generated production bundle with a production web server if deploying beyond local research use. Experiment live progress is in memory, while experiment/run/results are persisted.
