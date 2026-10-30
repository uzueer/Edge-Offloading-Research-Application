# Edge Offloading Research Application

Research application for comparing Round Robin, Edge-only, and latency-aware task scheduling across three containerized workers: `edge-1`, `edge-2`, and `cloud-1`.

The stack uses Node.js/Express, PostgreSQL, Docker Compose, React/Vite, and Python with Pandas, NumPy, and Matplotlib. The current Compose configuration is intended for local development and methodology validation.

## Quick start

Requirements: Docker Engine with Docker Compose, Node.js 22 or newer, and Python 3 for optional analysis.

From the project directory:

```bash
cd /home/uzueer/Edge
docker compose up -d --build
docker compose ps
```

Open the dashboard at [http://localhost:5173](http://localhost:5173). Compose starts PostgreSQL, the API, all three workers, and the Vite dashboard. The API applies pending database migrations on startup.

Default local service addresses:

| Service | Address |
|---|---|
| Dashboard | `http://localhost:5173` |
| API | `http://localhost:3000` |
| PostgreSQL | `localhost:5432` |
| `edge-1` worker | `http://localhost:8101` |
| `edge-2` worker | `http://localhost:8102` |
| `cloud-1` worker | `http://localhost:8103` |

Check service health with:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/nodes
```

To stop the services and retain the database:

```bash
docker compose down
```

To remove the database volume and all persisted experiment/task data as well:

```bash
docker compose down -v
```

## Use the dashboard

### Submit one task

In **Submit a task**:

1. Choose Round Robin, Edge-only, or Latency-aware.
2. Enter workload in MI, iterations, memory in MB, and a deterministic seed.
3. Select **Submit task**.

The result displays the task outcome, selected worker, predicted total latency when available, and actual response/execution timing. Workload MI is used by the scheduler's mathematical model. The worker's iteration count controls a deterministic CPU-bound computation and has no calibrated conversion to MI.

### Run a policy comparison

In **Run experiment**, configure:

- Tasks per policy and repetition count.
- Workload and iteration ranges.
- Arrival interval in milliseconds.
- Random seed.
- Optional per-node capacity, execution slots, memory, and RTT profile inputs.

Select **Start experiment**. The runner generates the same seeded task trace for each policy within each repetition, waits for workers to return to idle between policy replays, and rotates policy order between repetitions. Select the experiment under **Experiment results** to see persisted means, percentiles, throughput, success rates, and exports. Select **Download CSV** or **Download JSON** to preserve detailed trace inputs, predictions, and measurements.

Live progress is held in API memory. After an API restart, persisted experiment/run status and results remain available, but in-progress dashboard counters may no longer be present.

## Research model and interpretation

The scheduler compares eligible nodes using:

```text
predicted total latency (ms)
  = predicted network delay (ms)
  + predicted queueing delay (ms)
  + predicted execution time (ms)
```

Workload is in million instructions (MI), and capacity is in million instructions per second (MIPS). Execution prediction is `1000 × workload MI / capacity MIPS`. Queue delay uses queued MI divided by aggregate capacity across configured execution slots. For an offload request/result transaction, configured or measured RTT is included once as the network component. Unhealthy and resource-ineligible nodes are excluded before selection. The latency-aware scheduler selects the eligible node with the lowest predicted total; ties are resolved by node ID.

The application records prediction components separately from actual worker queue/execution timing and API response time. Missing or stale network observations are not treated as zero delay.

**Research limitations:** The three Compose workers run on one physical host. Their MIPS, slots, and memory are configured scheduler inputs, not calibrated measurements of independent hardware. Compose RTT values are simulated delays/configuration, not geographic WAN measurements. The worker iteration workload is not calibrated to MI. The saved validation export demonstrates the pipeline only; it is not evidence that a scheduling policy performs better. Use independent nodes, measured network conditions, calibrated capacities/workloads, equivalent traces, controlled initial conditions, and more repetitions before making performance or significance claims.

See [PROJECT_STATUS.md](./PROJECT_STATUS.md) for phase decisions, test records, and outstanding research limitations. Statistical definitions and figure reproduction are in [analysis/README.md](./analysis/README.md).

## Related work to review

These papers are useful starting points for the literature review; this list is not exhaustive and does not establish novelty for this implementation.

- Hsieh, L.-T., Liu, H., Guo, Y., and Gazda, R. (2020). [Task Management for Cooperative Mobile Edge Computing](https://doi.org/10.1109/SEC50012.2020.00051). *2020 IEEE/ACM Symposium on Edge Computing*. Studies heterogeneous edge nodes cooperating with a remote cloud under changing task arrivals and network conditions. It is relevant context for task placement across edge and cloud.
- Varghese, B., Wang, N., Bermbach, D., Hong, C.-H., de Lara, E., Shi, W., and Stewart, C. (2021). [A Survey on Edge Performance Benchmarking](https://doi.org/10.1145/3444692). *ACM Computing Surveys, 54*(3), Article 66. Surveys edge performance benchmarking and helps frame workload, system-under-test, and measurement choices.
- Iorio, M., Risso, F., and Casetti, C. (2021). [When Latency Matters: Measurements and Lessons Learned](https://doi.org/10.1145/3503954.3503956). *ACM SIGCOMM Computer Communication Review, 51*(4), 2–13. Reports measurements of end-to-end offloading and discusses how network and platform factors affect latency.
- Huang, L., Feng, X., Zhang, L., Qian, L., and Wu, Y. (2019). [Multi-Server Multi-User Multi-Task Computation Offloading for Mobile Edge Computing Networks](https://doi.org/10.3390/s19061446). *Sensors, 19*(6), 1446. Considers task offloading across multiple edge servers and a cloud server, providing related context for heterogeneous destinations and multiple tasks.

Read the papers and their cited work before stating a research gap. Their models and settings differ from this containerized prototype, so compare assumptions and evaluation methods rather than directly comparing headline results.

## Tests and analysis

Start the Compose stack first, then run the full Node suite with live PostgreSQL, API, and worker integration:

```bash
RUN_API_INTEGRATION=1 \
DATABASE_URL=postgres://edge:edge_dev_only@localhost:5432/edge_offloading \
npm test
```

Build the frontend bundle:

```bash
npm run build
```

Run the dashboard with a host-installed Node environment instead of Compose:

```bash
npm run dev
```

The Vite API proxy defaults to `http://localhost:3000`; set `API_PROXY_TARGET` to use a different API address.

Install the pinned analysis dependencies and test the Python tooling:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r analysis/requirements.txt
python -m unittest discover -s analysis/tests -v
```

Analyze an API JSON export and write summary tables plus reproducible PNG/PDF figures:

```bash
python analysis/analyze_experiments.py \
  --input path/to/experiment-export.json \
  --output-dir analysis/outputs/my-experiment \
  --seed 2026 \
  --bootstrap-samples 5000
```

The validation export and its figures are under `analysis/validation/`; their README identifies them as a smoke run, not research evidence.

## API reference

The API is available at `http://localhost:3000`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | API and PostgreSQL readiness |
| `GET` | `/nodes` | Worker health, capacity, and network inputs |
| `GET` | `/nodes/:nodeId/measurements` | Recent node measurements |
| `POST` | `/tasks` | Schedule and execute a task |
| `GET` | `/tasks/:taskId` | Retrieve task and decision |
| `POST` | `/experiments` | Start a seeded experiment |
| `GET` | `/experiments` | List persisted experiments |
| `GET` | `/experiments/:id` | Experiment configuration, runs, and live progress when available |
| `GET` | `/experiments/:id/results` | Per-task and aggregate records |
| `GET` | `/experiments/:id/export?format=csv` | Download CSV export (`json` also supported) |

Example task request:

```bash
curl -X POST http://localhost:3000/tasks \
  -H 'content-type: application/json' \
  -d '{"algorithm":"latency-aware","workloadMI":5,"iterations":50000,"memoryMB":64,"seed":42}'
```

For environment overrides, copy `.env.example` to `.env` and adjust ports and configured worker profiles. Example credentials are for local development only.
