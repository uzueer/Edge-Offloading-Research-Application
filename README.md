# Edge Offloading Research Application

A research prototype for comparing **Round Robin**, **Edge-only**, **Fewest active tasks**, and **Latency-aware** scheduling across three containerized workers: `edge-1`, `edge-2`, and `cloud-1`.

The stack uses React/Vite, Node.js/Express, PostgreSQL, Docker Compose, and Python analysis tools. Network RTT values in the Compose and benchmark configurations are simulated timer delays. All worker containers run on the same physical host.


## Project layout

```text
frontend/                 React/Vite app, its npm project, Dockerfile
backend/                  Express API, workers, database code, tests, npm project
  src/                    API, schedulers, experiment service, worker server
  workers/                worker container entry point
  db/migrations/          PostgreSQL schema migrations
  test/                   backend and scheduler tests
research/                 all benchmarking, analysis, and results
  experiments/            benchmark configuration and runner scripts
  analysis/               statistics code, requirements, Python tests
  results/
    final/                the single retained benchmark result set
      raw/                measured JSON and CSV exports
      warmups/            separate warm-up exports
      analysis/           per-run statistics tables and reports
      graphs/             final RTT/capacity plots and comparison tables
  benchmark_visualization.ipynb  interactive results notebook
docs/                     submitted report and dashboard evidence
docker-compose.yml        local multi-container stack
README.md                 this project guide
```

The frontend and backend each have their own `package.json`, lockfile, and `node_modules/`. Install or run their npm commands from the matching folder.

## Start the application

Requirements: Docker Engine with Docker Compose. For running Node or Python tools directly on the host, install Node.js 22 or newer and Python 3.

From the repository root:

```bash
docker compose up -d --build
docker compose ps
```

The dashboard is at [http://localhost:5173](http://localhost:5173). The API is at [http://localhost:3000](http://localhost:3000). PostgreSQL is on port `5432`; workers are on ports `8101` (`edge-1`), `8102` (`edge-2`), and `8103` (`cloud-1`). Check the API and worker configuration with:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/nodes
```

To stop the stack and keep database data:

```bash
docker compose down
```

To also delete the PostgreSQL volume and all database records:

```bash
docker compose down -v
```

For host development or tests, install dependencies separately:

```bash
(cd backend && npm ci)
(cd frontend && npm ci)
```

Then run `npm start`, `npm test`, or `npm run db:migrate` from `backend/`; run `npm run dev` or `npm run build` from `frontend/`.

## Use the application

### Submit a task

In the dashboard's **Submit a task** form, choose a scheduler and provide workload MI, worker CPU iterations, memory, and a seed. Workload MI is used by the scheduler's mathematical model. CPU iterations control the worker's deterministic computation. There is no calibrated conversion between those two values.

### Run a dashboard experiment

In **Run experiment**, select task and repetition counts, workload and iteration ranges, arrival interval, random seed, and optional per-worker capacity, slot, memory, and RTT overrides. Each repetition uses the same generated task trace for all four policies. The service rotates policy order and waits for workers to become idle before replaying a policy. Results and CSV/JSON exports are available from **Experiment results**.

## Benchmark matrix and analysis

The reproducible benchmark runner is `research/experiments/run_benchmarks.py`; its settings are in `research/experiments/experiment_config.json`. The full matrix contains:

- Task counts: 50, 100, 250, and 500.
- Simulated RTT profiles: low (5/10/25 ms), medium (10/30/60 ms), high (20/50/100 ms), and asymmetric (5/40/15 ms) for edge-1/edge-2/cloud-1.
- Capacity profiles: default, edge-faster, and cloud-faster.
- 30 seeded repetitions per configuration, comparing all four policies.

That is 48 configurations and 5,760 policy-level runs, before the separate warm-ups. The full matrix is a large, long-running workload. Start Docker Compose first, then run:

```bash
python research/experiments/run_benchmarks.py
```

The runner writes results under `research/results/final/`: raw measured JSON/CSV files in `raw/`, separate warm-ups in `warmups/`, and a progress manifest in `manifest.json`. Use `--resume` to skip configurations already marked complete and reconnect to an experiment that is still running:

```bash
python research/experiments/run_benchmarks.py --resume
```

After runs finish, create per-experiment statistics tables and the final RTT/capacity plots with matrix-wide paired comparisons:

```bash
for file in research/results/final/raw/*.json; do
  id=$(basename "$file" .json)
  python research/analysis/analyze_experiments.py \
    --input "$file" \
    --output-dir "research/results/final/analysis/$id"
done

python research/experiments/generate_graphs.py
```

The analyzer writes summary tables without extra plots by default; pass `--plots` only when per-run exploratory plots are needed. `generate_graphs.py` reads from and writes to `research/results/final/` by default. It produces the RTT and capacity plots, `scenario_summary.csv`, and `paired_matrix_comparisons.csv`. Per-experiment statistics use repetitions as the independent samples; task-level observations are descriptive. Paired Wilcoxon tests have Holm corrections within each export and across the available matrix comparisons. Outliers are flagged and retained.

### Explore graphs in the notebook

Install the Python dependencies and kernel support into a virtual environment from the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r research/analysis/requirements.txt
```

Open `research/benchmark_visualization.ipynb` in VS Code or Jupyter, select the `.venv` Python kernel, and choose **Run All**. It reads the final raw exports and displays the existing paper plots, worker placement counts, and paired comparison table without creating duplicate graph files.

## Current results and limits

The single retained result set is `research/results/final/`: 12 configurations (4 simulated RTT profiles × 3 capacity profiles), 30 repetitions, and 50 tasks per repetition for each of four policies. All 72,000 measured task records succeeded. The 100-task experiment was interrupted and the 250/500-task workloads were not run; they are excluded.

| Scheduler | Mean API response (ms) | SD of 360 repetition means (ms) | Median (ms) | 95th percentile (ms) | Successful tasks |
|---|---:|---:|---:|---:|---:|
| Round Robin | 48.95 | 17.21 | 41.77 | 113.73 | 18,000/18,000 |
| Edge-only | **28.40** | 11.12 | **24.85** | **53.16** | 18,000/18,000 |
| Fewest active tasks | 49.02 | 17.17 | 41.85 | 113.62 | 18,000/18,000 |
| Latency-aware | 30.26 | 10.66 | 27.49 | 57.41 | 18,000/18,000 |

Paired tests use repetition means, with Holm correction across 36 comparisons (three baselines × 12 configurations). Latency-aware was significantly faster than Round Robin in 11/12 configurations and Fewest active tasks in 12/12. It was faster than Edge-only in 3/12 and slower in 9/12; four differences favoring Edge-only were significant, none favoring latency-aware were significant, and eight were not significant. This result describes only the completed workload and this implementation.

The worker containers, API, and database run on the same physical host. RTT values are injected timer delays, not measurements over a real network. Worker MIPS, slots, and memory are configured scheduler inputs, not calibrated capacities of separate machines. Workload MI is not calibrated against the worker's CPU-loop iterations, and API response time includes API/database overhead beyond the latency predictor. Treat these as limitations when interpreting or presenting the comparison.

### Results pictures

These plots use the verified fresh batch; they do not represent the unrun larger workloads.

**Mean response time by simulated network RTT**:

![Mean response time by simulated network RTT](research/results/final/graphs/performance_by_rtt.png)

**Mean response time by configured capacity profile**:

![Mean response time by configured capacity profile](research/results/final/graphs/performance_by_capacity.png)

Raw JSON/CSV exports, per-run summary tables, paired comparisons, and the two final plots are kept together in `research/results/final/`.

## Tests and build

Start the Compose stack before running database/API integration tests:

```bash
(cd backend && RUN_API_INTEGRATION=1 DATABASE_URL=postgres://edge:edge_dev_only@localhost:5432/edge_offloading npm test)
```

Build the frontend bundle:

```bash
(cd frontend && npm run build)
```

Run the Python analysis tests after installing `research/analysis/requirements.txt`:

```bash
python -m unittest discover -s research/analysis/tests -v
```

## API routes

The API base URL is `http://localhost:3000`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | API and database readiness |
| `GET` | `/nodes` | Worker health, capacity, and network inputs |
| `GET` | `/nodes/:nodeId/measurements` | Recent worker measurements |
| `POST` | `/tasks` | Schedule and execute one task |
| `GET` | `/tasks/:taskId` | Retrieve a task and its latest decision |
| `POST` | `/experiments` | Start a seeded policy comparison |
| `GET` | `/experiments` | List saved experiments |
| `GET` | `/experiments/:id` | Experiment configuration, runs, and live progress when available |
| `GET` | `/experiments/:id/results` | Task-level and aggregate records |
| `GET` | `/experiments/:id/export?format=csv` | Export CSV; JSON is also supported |

For local environment overrides, copy `.env.example` to `.env` and adjust ports or worker settings. The example credentials are for local development only.
