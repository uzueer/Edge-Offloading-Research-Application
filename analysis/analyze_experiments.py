#!/usr/bin/env python3
"""Analyze actual Edge offloading API JSON/CSV exports and create reproducible figures."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

ALGORITHMS = ["round-robin", "edge-only", "latency-aware"]
ALGORITHM_LABELS = {
    "round-robin": "Round Robin",
    "edge-only": "Edge-only",
    "latency-aware": "Latency-aware",
}


def load_export(input_path: str | Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    path = Path(input_path)
    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("experiment"), dict):
            raise ValueError("JSON export must have an experiment object")
        if not isinstance(payload.get("results"), list):
            raise ValueError("JSON export must have a results array")
        return payload["experiment"], payload["results"]
    if path.suffix.lower() == ".csv":
        frame = pd.read_csv(path)
        if frame.empty:
            raise ValueError("CSV export is empty")
        config_text = frame.iloc[0].get("configuration_json")
        configuration = json.loads(config_text) if isinstance(config_text, str) else {}
        experiment_id = frame.iloc[0].get("experiment_id")
        records: list[dict[str, Any]] = []
        for row in frame.to_dict(orient="records"):
            metrics = row.get("metrics_json")
            row["metrics"] = json.loads(metrics) if isinstance(metrics, str) and metrics else {}
            records.append(row)
        return {"id": experiment_id, "configuration": configuration}, records
    raise ValueError("input must be a JSON or CSV API export")


def task_frame(results: list[dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for result in results:
        metrics = result.get("metrics") or {}
        if metrics.get("resultType", result.get("record_type")) != "task":
            continue
        row = {
            "runId": result.get("runId", result.get("run_id")),
            "repetition": result.get("repetition"),
            "randomSeed": result.get("randomSeed", result.get("random_seed")),
            "algorithm": result.get("algorithm"),
            "taskId": result.get("taskId", result.get("task_id")),
            "nodeId": result.get("nodeId", result.get("node_id")),
            "traceTaskId": metrics.get("traceTaskId"),
            "status": metrics.get("status", "unknown"),
            "responseMs": metrics.get("actualResponseMs", result.get("actualResponseMs", result.get("actual_response_ms"))),
            "queueMs": metrics.get("actualQueueingMs"),
            "executionMs": metrics.get("actualExecutionMs"),
            "schedulingOverheadMs": metrics.get("schedulingOverheadMs"),
            "predictedLatencyMs": metrics.get("predictedLatencyMs", result.get("predictedLatencyMs", result.get("predicted_latency_ms"))),
            "predictionErrorMs": metrics.get("predictionErrorMs"),
            "modelledActualLatencyMs": metrics.get("modelledActualLatencyMs"),
            "workloadMI": metrics.get("workloadMI"),
            "iterations": metrics.get("iterations"),
            "taskSeed": metrics.get("taskSeed"),
            "arrivalOffsetMs": metrics.get("arrivalOffsetMs"),
            "actualNetworkMs": metrics.get("actualNetworkMs"),
            "actualNetworkKind": metrics.get("actualNetworkKind"),
            "predictedComponents": metrics.get("predictedComponents"),
        }
        rows.append(row)
    frame = pd.DataFrame(rows)
    if frame.empty:
        raise ValueError("export contains no task-level experiment results")
    frame["algorithm"] = frame["algorithm"].astype(str)
    frame["status"] = frame["status"].astype(str)
    for column in ["responseMs", "queueMs", "executionMs", "schedulingOverheadMs", "predictedLatencyMs",
                  "predictionErrorMs", "modelledActualLatencyMs", "workloadMI", "iterations", "taskSeed",
                  "arrivalOffsetMs", "actualNetworkMs", "repetition"]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame


def bootstrap_mean_ci(values: list[float] | np.ndarray, *, seed: int = 0,
                      samples: int = 5000) -> tuple[float, float] | None:
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    if len(values) < 2:
        return None
    if samples < 100:
        raise ValueError("bootstrap samples must be at least 100")
    rng = np.random.default_rng(seed)
    draws = rng.choice(values, size=(samples, len(values)), replace=True).mean(axis=1)
    low, high = np.quantile(draws, [0.025, 0.975])
    return float(low), float(high)


def exact_sign_test_pvalue(values: list[float] | np.ndarray) -> float | None:
    signs = np.asarray(values, dtype=float)
    signs = signs[np.isfinite(signs) & (signs != 0)]
    n = len(signs)
    if n < 2:
        return None
    positives = int(np.sum(signs > 0))
    tail = min(positives, n - positives)
    probability = sum(math.comb(n, k) for k in range(tail + 1)) / (2**n)
    return min(1.0, 2.0 * probability)


def _finite_mean(series: pd.Series) -> float | None:
    values = pd.to_numeric(series, errors="coerce").dropna()
    return float(values.mean()) if not values.empty else None


def nearest_rank_percentile(values: np.ndarray, percentile: float) -> float | None:
    ordered = np.sort(np.asarray(values, dtype=float))
    if not len(ordered):
        return None
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return float(ordered[index])


def analyze(experiment: dict[str, Any], results: list[dict[str, Any]], *, seed: int = 0,
            bootstrap_samples: int = 5000) -> tuple[dict[str, Any], pd.DataFrame]:
    tasks = task_frame(results)
    successful = tasks[tasks["status"] == "succeeded"].copy()
    repetitions = sorted(int(value) for value in tasks["repetition"].dropna().unique())
    per_algorithm: dict[str, Any] = {}
    run_means: dict[str, list[float]] = {}
    aggregates: list[dict[str, Any]] = []

    aggregate_rows = [row for row in results if (row.get("metrics") or {}).get("resultType") == "aggregate"]
    aggregate_by_key = {(row.get("repetition"), row.get("algorithm")): row.get("metrics", {}).get("summary", {})
                        for row in aggregate_rows}

    for index, algorithm in enumerate(ALGORITHMS):
        rows = tasks[tasks["algorithm"] == algorithm]
        good = rows[rows["status"] == "succeeded"]
        response = good["responseMs"].dropna().to_numpy(dtype=float)
        repetition_means = []
        per_repetition = []
        for repetition in repetitions:
            repetition_rows = rows[rows["repetition"] == repetition]
            repetition_good = repetition_rows[repetition_rows["status"] == "succeeded"]
            run_mean = _finite_mean(repetition_good["responseMs"])
            aggregate = aggregate_by_key.get((repetition, algorithm), {})
            if run_mean is not None:
                repetition_means.append(run_mean)
            per_repetition.append({
                "repetition": repetition,
                "taskCount": int(len(repetition_rows)),
                "succeededCount": int(len(repetition_good)),
                "failedCount": int(len(repetition_rows) - len(repetition_good)),
                "meanResponseTimeMs": run_mean,
                "throughputTasksPerSecond": aggregate.get("throughputTasksPerSecond"),
                "meanQueueingTimeMs": aggregate.get("meanQueueingTimeMs"),
                "meanExecutionTimeMs": aggregate.get("meanExecutionTimeMs"),
                "meanSchedulingOverheadMs": aggregate.get("meanSchedulingOverheadMs"),
            })
        run_means[algorithm] = repetition_means
        response_ci = bootstrap_mean_ci(repetition_means, seed=seed + index, samples=bootstrap_samples)
        summary = {
            "taskCount": int(len(rows)),
            "succeededCount": int(len(good)),
            "failedCount": int(len(rows) - len(good)),
            "successRate": float(len(good) / len(rows)) if len(rows) else 0.0,
            "failureRate": float((len(rows) - len(good)) / len(rows)) if len(rows) else 0.0,
            "meanResponseTimeMs": float(np.mean(response)) if len(response) else None,
            "medianResponseTimeMs": float(np.median(response)) if len(response) else None,
            "p95ResponseTimeMs": nearest_rank_percentile(response, 0.95),
            "meanQueueingTimeMs": _finite_mean(good["queueMs"]),
            "meanExecutionTimeMs": _finite_mean(good["executionMs"]),
            "meanSchedulingOverheadMs": _finite_mean(rows["schedulingOverheadMs"]),
            "meanAbsolutePredictionErrorMs": _finite_mean(good["predictionErrorMs"].abs()),
            "meanPredictionErrorMs": _finite_mean(good["predictionErrorMs"]),
            "meanThroughputTasksPerSecond": float(np.mean([
                item["throughputTasksPerSecond"] for item in per_repetition
                if item["throughputTasksPerSecond"] is not None
            ])) if any(item["throughputTasksPerSecond"] is not None for item in per_repetition) else None,
            "meanResponseTime95CIByRepetitionMs": list(response_ci) if response_ci else None,
            "responseTimeCIRepetitions": len(repetition_means),
            "perRepetition": per_repetition,
        }
        per_algorithm[algorithm] = summary
        aggregates.append({"algorithm": algorithm, **summary})

    comparisons = []
    for baseline in ["round-robin", "edge-only"]:
        paired = successful[successful["algorithm"].isin([baseline, "latency-aware"])].pivot_table(
            index=["repetition", "traceTaskId"], columns="algorithm", values="responseMs", aggfunc="mean"
        )
        if baseline in paired and "latency-aware" in paired:
            paired = paired[[baseline, "latency-aware"]].dropna()
            paired["baselineMinusLatencyAwareMs"] = paired[baseline] - paired["latency-aware"]
            repetition_differences = paired.groupby(level="repetition")["baselineMinusLatencyAwareMs"].mean()
            difference_values = repetition_differences.to_numpy(dtype=float)
            ci = bootstrap_mean_ci(difference_values, seed=seed + 100 + len(comparisons), samples=bootstrap_samples)
            baseline_mean = per_algorithm[baseline]["meanResponseTimeMs"]
            latency_mean = per_algorithm["latency-aware"]["meanResponseTimeMs"]
            comparisons.append({
                "baseline": baseline,
                "pairedTaskCount": int(len(paired)),
                "independentRepetitionCount": int(len(repetition_differences)),
                "meanBaselineMinusLatencyAwareMs": float(np.mean(difference_values)) if len(difference_values) else None,
                "pairedMeanDifference95CIByRepetitionMs": list(ci) if ci else None,
                "exactTwoSidedSignTestPValueOnRepetitionMeans": exact_sign_test_pvalue(difference_values),
                "latencyAwareRelativePerformanceImprovementPercent": (
                    float((baseline_mean - latency_mean) / baseline_mean * 100)
                    if baseline_mean is not None and baseline_mean > 0 and latency_mean is not None else None
                ),
            })
        else:
            comparisons.append({"baseline": baseline, "pairedTaskCount": 0,
                                "independentRepetitionCount": 0, "meanBaselineMinusLatencyAwareMs": None,
                                "pairedMeanDifference95CIByRepetitionMs": None,
                                "exactTwoSidedSignTestPValueOnRepetitionMeans": None,
                                "latencyAwareRelativePerformanceImprovementPercent": None})

    report = {
        "experiment": {"id": experiment.get("id"), "name": experiment.get("name"),
                       "randomSeed": experiment.get("randomSeed"), "configuration": experiment.get("configuration")},
        "analysisSoftware": {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
                             "matplotlib": matplotlib.__version__},
        "algorithmSummaries": per_algorithm,
        "pairedComparisons": comparisons,
        "methodology": {
            "responseTime": "successful task API-side responseMs values from the export; failures are reported separately",
            "confidenceIntervals": "percentile bootstrap over independent run/repetition means; no interval is emitted for fewer than two repetitions",
            "pairedComparison": "matched trace task mean response differences, summarized at the repetition level",
            "signTest": "exact two-sided sign test over nonzero repetition-level paired mean differences; small repetition counts are low power",
            "predictionError": "uses the exported modelled actual component total (network + worker queue + worker execution) minus predicted total; API response time is separate",
            "networkLimit": "configured simulated RTT on single-host containers is not geographic network evidence",
            "interpretation": "descriptive and comparative output only; no performance benefit or statistical significance is assumed",
        },
    }
    return report, tasks


def _component_means(tasks: pd.DataFrame, algorithm: str) -> tuple[list[float], list[float]]:
    rows = tasks[(tasks["algorithm"] == algorithm) & (tasks["status"] == "succeeded")]
    predicted_values = {key: [] for key in ["networkDelayMs", "queueingDelayMs", "executionTimeMs"]}
    actual_values = {"networkDelayMs": [], "queueingDelayMs": [], "executionTimeMs": []}
    for _, row in rows.iterrows():
        predicted = row.get("predictedComponents")
        if isinstance(predicted, dict):
            for key in predicted_values:
                if predicted.get(key) is not None:
                    predicted_values[key].append(float(predicted[key]))
        for key, column in [("networkDelayMs", "actualNetworkMs"), ("queueingDelayMs", "queueMs"),
                            ("executionTimeMs", "executionMs")]:
            value = row.get(column)
            if pd.notna(value):
                actual_values[key].append(float(value))
    predicted = [float(np.mean(values)) if values else 0.0 for values in predicted_values.values()]
    actual = [float(np.mean(values)) if values else 0.0 for values in actual_values.values()]
    return predicted, actual


def create_figures(experiment: dict[str, Any], tasks: pd.DataFrame, report: dict[str, Any], output_dir: str | Path) -> list[Path]:
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.titlesize": 12,
                         "axes.labelsize": 10, "figure.dpi": 120, "savefig.dpi": 300})
    title = f"Experiment {str(experiment.get('id', 'unknown'))[:8]} — same-host workers, simulated RTT"
    created: list[Path] = []

    response_data = [tasks[(tasks.algorithm == algorithm) & (tasks.status == "succeeded")]["responseMs"].dropna().to_numpy()
                     for algorithm in ALGORITHMS]
    fig, ax = plt.subplots(figsize=(8.2, 5.2))
    present = [(ALGORITHM_LABELS[algorithm], values) for algorithm, values in zip(ALGORITHMS, response_data) if len(values)]
    if present:
        labels, arrays = zip(*present)
        ax.boxplot(arrays, tick_labels=labels, showmeans=True, meanline=True, patch_artist=True,
                   boxprops={"facecolor": "#d7e6f5"}, medianprops={"color": "#16324f", "linewidth": 1.5})
    ax.set_title(f"Response time distribution\n{title}")
    ax.set_ylabel("API-side response time (ms)")
    ax.grid(axis="y", alpha=0.25)
    fig.tight_layout()
    created += _save_pair(fig, output / "response_time_distribution")

    fig, ax = plt.subplots(figsize=(8.2, 5.2))
    means, lows, highs, labels, algorithms_for_points = [], [], [], [], []
    for algorithm in ALGORITHMS:
        summary = report["algorithmSummaries"][algorithm]
        per_rep = [row["meanResponseTimeMs"] for row in summary["perRepetition"] if row["meanResponseTimeMs"] is not None]
        if not per_rep:
            continue
        mean_value = float(np.mean(per_rep))
        ci = summary["meanResponseTime95CIByRepetitionMs"]
        means.append(mean_value)
        lows.append(mean_value - ci[0] if ci else 0.0)
        highs.append(ci[1] - mean_value if ci else 0.0)
        labels.append(ALGORITHM_LABELS[algorithm])
        algorithms_for_points.append(algorithm)
    if means:
        x = np.arange(len(means))
        ax.errorbar(x, means, yerr=np.array([lows, highs]), fmt="o", capsize=5, color="#235789")
        for position, value, algorithm in zip(x, means, algorithms_for_points):
            ax.annotate("CI unavailable (1 repetition)" if report["algorithmSummaries"][algorithm]["responseTimeCIRepetitions"] < 2 else "",
                        (position, value), xytext=(0, 9), textcoords="offset points", ha="center", fontsize=8)
        ax.set_xticks(x, labels)
    ax.set_title(f"Mean response time by repetition (95% bootstrap CI)\n{title}")
    ax.set_ylabel("Mean successful response time (ms)")
    ax.grid(axis="y", alpha=0.25)
    fig.tight_layout()
    created += _save_pair(fig, output / "mean_response_time_ci")

    fig, ax = plt.subplots(figsize=(8.2, 5.2))
    throughput = []
    for algorithm in ALGORITHMS:
        values = [row["throughputTasksPerSecond"] for row in report["algorithmSummaries"][algorithm]["perRepetition"]
                  if row["throughputTasksPerSecond"] is not None]
        throughput.append(float(np.mean(values)) if values else 0.0)
    ax.bar([ALGORITHM_LABELS[item] for item in ALGORITHMS], throughput, color=["#6c9bcf", "#83b692", "#e09f7d"])
    ax.set_title(f"Throughput by algorithm\n{title}")
    ax.set_ylabel("Successful tasks per second")
    ax.grid(axis="y", alpha=0.25)
    fig.tight_layout()
    created += _save_pair(fig, output / "throughput_by_algorithm")

    fig, ax = plt.subplots(figsize=(11.5, 5.8))
    positions = []
    component_profiles = []
    labels = []
    position = 0
    for algorithm in ALGORITHMS:
        predicted, actual = _component_means(tasks, algorithm)
        for kind, values in [("Predicted", predicted), ("Observed", actual)]:
            positions.append(position)
            component_profiles.append(values)
            labels.append(f"{ALGORITHM_LABELS[algorithm]}\n{kind}")
            position += 1
    colors = ["#7aa6c2", "#f2c078", "#bb8588"]
    base = np.zeros(len(positions))
    for component_index, component_name in enumerate(["Network", "Queue", "Execution"]):
        heights = [row[component_index] for row in component_profiles]
        ax.bar(positions, heights, bottom=base, label=component_name, color=colors[component_index])
        base += np.asarray(heights)
    ax.set_xticks(positions, labels)
    ax.set_title(f"Predicted and observed latency components\n{title}")
    ax.set_ylabel("Mean component duration (ms)")
    ax.legend(title="Component")
    ax.grid(axis="y", alpha=0.25)
    fig.tight_layout()
    created += _save_pair(fig, output / "latency_components")

    plt.close("all")
    return created


def _save_pair(figure: plt.Figure, stem: Path) -> list[Path]:
    png = stem.with_suffix(".png")
    pdf = stem.with_suffix(".pdf")
    figure.savefig(png, bbox_inches="tight")
    figure.savefig(pdf, bbox_inches="tight")
    plt.close(figure)
    return [png, pdf]


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value) if np.isfinite(value) else None
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Experiment API export (.json or .csv)")
    parser.add_argument("--output-dir", default="analysis/outputs", help="Directory for analysis tables and figures")
    parser.add_argument("--seed", type=int, default=0, help="Seed for bootstrap resampling")
    parser.add_argument("--bootstrap-samples", type=int, default=5000)
    args = parser.parse_args(argv)
    experiment, results = load_export(args.input)
    report, tasks = analyze(experiment, results, seed=args.seed, bootstrap_samples=args.bootstrap_samples)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    (output / "analysis.json").write_text(json.dumps(_json_safe(report), indent=2, allow_nan=False) + "\n", encoding="utf-8")
    pd.DataFrame(report["algorithmSummaries"]).T.rename_axis("algorithm").to_csv(output / "algorithm_summary.csv")
    pd.DataFrame(report["pairedComparisons"]).to_csv(output / "paired_comparisons.csv", index=False)
    figures = create_figures(experiment, tasks, report, output)
    print(json.dumps({"experimentId": experiment.get("id"), "taskRows": len(tasks),
                      "figures": [str(path) for path in figures], "analysis": str(output / "analysis.json")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
