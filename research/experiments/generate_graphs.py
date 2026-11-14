#!/usr/bin/env python3
"""Generate cross-configuration RTT and workload plots from archived API JSON exports."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

RESEARCH_DIR = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=RESEARCH_DIR / "results/raw")
    parser.add_argument("--output-dir", type=Path, default=RESEARCH_DIR / "results/graphs")
    parser.add_argument("--analysis-dir", type=Path, default=RESEARCH_DIR / "results/analysis")
    args = parser.parse_args()
    rows = []
    for path in sorted(args.input_dir.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        experiment = payload.get("experiment", {})
        config = experiment.get("configuration", {})
        scenario = config.get("scenario") or {}
        network = scenario.get("networkProfile", "unknown")
        task_count = scenario.get("taskCount", config.get("taskCount"))
        for record in payload.get("results", []):
            metrics = record.get("metrics") or {}
            if metrics.get("resultType") != "task":
                continue
            rows.append({"algorithm": record.get("algorithm"), "status": metrics.get("status"),
                "responseMs": metrics.get("actualResponseMs"), "repetition": record.get("repetition"),
                "taskCount": task_count, "networkProfile": network})
    if not rows:
        raise SystemExit(f"No task rows found under {args.input_dir}")
    frame = pd.DataFrame(rows)
    successful = frame[frame.status == "succeeded"]
    grouped = successful.groupby(["algorithm", "networkProfile", "taskCount"], as_index=False).agg(
        meanResponseMs=("responseMs", "mean"), medianResponseMs=("responseMs", "median"),
        p95ResponseMs=("responseMs", lambda values: values.quantile(.95)))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    grouped.to_csv(args.output_dir / "scenario_summary.csv", index=False)
    # Correct all planned policy contrasts across the complete matrix, not only within each experiment.
    matrix_tests = []
    for path in sorted(args.analysis_dir.glob("*/analysis.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        scenario = (report.get("experiment", {}).get("configuration", {}).get("scenario") or {})
        for comparison in report.get("pairedComparisons", []):
            pvalue = comparison.get("wilcoxonSignedRankPValueOnRepetitionMeans")
            matrix_tests.append({
                "experimentId": report.get("experiment", {}).get("id"),
                "taskCount": scenario.get("taskCount"),
                "networkProfile": scenario.get("networkProfile"),
                "capacityProfile": scenario.get("capacityProfile"),
                "baseline": comparison.get("baseline"),
                "independentRepetitionCount": comparison.get("independentRepetitionCount"),
                "meanBaselineMinusLatencyAwareMs": comparison.get("meanBaselineMinusLatencyAwareMs"),
                "pairedCohensDz": comparison.get("pairedCohensDz"),
                "pValueWilcoxon": pvalue,
            })
    valid = sorted((row["pValueWilcoxon"], i) for i, row in enumerate(matrix_tests)
                   if row["pValueWilcoxon"] is not None)
    running_max = 0.0
    for rank, (pvalue, index) in enumerate(valid):
        adjusted = min(1.0, (len(valid) - rank) * pvalue)
        running_max = max(running_max, adjusted)
        matrix_tests[index]["pValueHolmAcrossMatrix"] = running_max
    for row in matrix_tests:
        row.setdefault("pValueHolmAcrossMatrix", None)
    pd.DataFrame(matrix_tests).to_csv(args.output_dir / "paired_matrix_comparisons.csv", index=False)
    for dimension, filename, title, xlabel in [
        ("networkProfile", "performance_by_rtt", "Response time by configured simulated RTT profile", "Simulated RTT profile"),
        ("taskCount", "performance_by_workload", "Response time by task count", "Tasks per policy and repetition"),
    ]:
        pivot = grouped.pivot_table(index=dimension, columns="algorithm", values="meanResponseMs", aggfunc="mean")
        ax = pivot.plot(marker="o", figsize=(8.5, 5.2))
        ax.set_title(title + " (same-host workers)")
        ax.set_xlabel(xlabel)
        ax.set_ylabel("Mean successful API response time (ms)")
        ax.grid(alpha=.25)
        ax.legend(title="Scheduling policy")
        plt.tight_layout()
        plt.savefig(args.output_dir / f"{filename}.png", dpi=300, bbox_inches="tight")
        plt.savefig(args.output_dir / f"{filename}.pdf", bbox_inches="tight")
        plt.close()
    print(f"Wrote scenario summary and figures to {args.output_dir}")


if __name__ == "__main__":
    main()
