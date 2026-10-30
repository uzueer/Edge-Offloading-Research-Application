# Reproducible experiment analysis

The analysis script reads an actual API experiment export (`.json` or `.csv`), derives descriptive statistics from task-level records, and produces PNG/PDF figures. It does not generate workloads or replace measured data with sample values.

## Setup

Use Python 3.12 or a compatible Python 3 release. Create an environment and install the pinned libraries:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r analysis/requirements.txt
```

## Analyze an export

```sh
python analysis/analyze_experiments.py \
  --input path/to/experiment-export.json \
  --output-dir analysis/outputs/my-experiment \
  --seed 2026 \
  --bootstrap-samples 5000
```

The output directory receives `analysis.json`, algorithm and paired-comparison CSV tables, and four figures as both PNG and PDF. Set the analysis `--seed` to reproduce bootstrap intervals. Input JSON is the preferred archival format because it includes the full experiment object and export rows; CSV exports include equivalent configuration and metrics JSON fields.

## Statistics and definitions

- Response-time summaries use successful task API-side response measurements. Failures and success/failure rates are reported separately. p95 uses the nearest-rank definition, consistent with the experiment runner.
- Throughput is read from persisted per-run summaries. Queue, execution, scheduling overhead, and node distribution come from task-level or run-level result data.
- Prediction error is the exported modeled actual component total (network + worker queue + worker execution) minus predicted total. It is separate from API response time, which also includes scheduling and API-side work.
- The 95% interval uses deterministic percentile bootstrapping of independent repetition means. An interval is omitted with fewer than two observed successful repetitions. With only a few repetitions, intervals are exploratory and can be unstable.
- Paired comparisons match tasks by repetition and trace task ID, compute baseline-minus-latency-aware response differences, and aggregate differences by repetition. The exact two-sided sign test operates on repetition-level differences. A small repetition count has low power and must not be treated as evidence of significance.
- Relative improvement is `(baseline mean - latency-aware mean) / baseline mean * 100`; a negative value means the latency-aware mean was higher in that run.
- Network RTT values may be configured simulations. The supplied Compose workers share one host; these results do not establish geographic edge/cloud performance.

## Tests

Python analysis unit tests use explicitly labeled in-memory fixtures to verify parsing and statistics only. They do not create figures or produce research result files:

```sh
python -m unittest discover -s analysis/tests -v
```

`analysis/validation/` contains one actual same-host Compose smoke export and its generated figures for pipeline verification. It is labeled as validation material, not research evidence.
