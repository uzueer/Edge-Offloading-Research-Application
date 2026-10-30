import json
import csv
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "analysis"))

from analyze_experiments import analyze, bootstrap_mean_ci, exact_sign_test_pvalue, load_export, nearest_rank_percentile  # noqa: E402


def fixture_export():
    results = []
    times = {
        "round-robin": [10.0, 12.0],
        "edge-only": [9.0, 11.0],
        "latency-aware": [8.0, 10.0],
    }
    for algorithm, response_times in times.items():
        for index, response in enumerate(response_times):
            results.append({
                "runId": 1,
                "repetition": 0,
                "randomSeed": 7,
                "algorithm": algorithm,
                "taskId": f"{algorithm}-{index}",
                "nodeId": "edge-1",
                "metrics": {
                    "resultType": "task",
                    "traceTaskId": f"trace-{index}",
                    "status": "succeeded",
                    "actualResponseMs": response,
                    "actualQueueingMs": 1.0,
                    "actualExecutionMs": 5.0,
                    "schedulingOverheadMs": 0.1,
                    "predictedLatencyMs": 7.0,
                    "predictionErrorMs": -1.0,
                },
            })
    return {"experiment": {"id": "fixture", "name": "synthetic unit-test fixture",
                            "randomSeed": 7, "configuration": {"randomSeed": 7}}, "results": results}


class AnalysisTests(unittest.TestCase):
    def test_json_export_loads_and_task_metrics_are_summarized(self):
        payload = fixture_export()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            experiment, results = load_export(path)
        report, tasks = analyze(experiment, results, seed=12, bootstrap_samples=200)
        self.assertEqual(len(tasks), 6)
        self.assertEqual(report["algorithmSummaries"]["latency-aware"]["meanResponseTimeMs"], 9.0)
        self.assertIsNone(report["algorithmSummaries"]["latency-aware"]["meanResponseTime95CIByRepetitionMs"])
        self.assertEqual(report["pairedComparisons"][0]["pairedTaskCount"], 2)
        self.assertIsNone(report["pairedComparisons"][0]["exactTwoSidedSignTestPValueOnRepetitionMeans"])
        self.assertIn("synthetic unit-test fixture", report["experiment"]["name"])

    def test_bootstrap_and_sign_test_handle_small_samples(self):
        self.assertIsNone(bootstrap_mean_ci([1.0]))
        self.assertEqual(bootstrap_mean_ci([1.0, 2.0], seed=4, samples=200),
                         bootstrap_mean_ci([1.0, 2.0], seed=4, samples=200))
        self.assertIsNone(exact_sign_test_pvalue([1.0]))
        self.assertAlmostEqual(exact_sign_test_pvalue([1.0, 2.0, 3.0]), 0.25)
        self.assertEqual(nearest_rank_percentile([10.0, 20.0], 0.95), 20.0)

    def test_csv_api_export_parses_configuration_and_nested_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "export.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=["experiment_id", "configuration_json", "run_id",
                    "repetition", "random_seed", "algorithm", "record_type", "task_id", "node_id",
                    "predicted_latency_ms", "actual_response_ms", "metrics_json", "recorded_at"])
                writer.writeheader()
                writer.writerow({"experiment_id": "csv-test", "configuration_json": json.dumps({"randomSeed": 4}),
                    "run_id": 1, "repetition": 0, "random_seed": 4, "algorithm": "round-robin",
                    "record_type": "task", "task_id": "task-1", "node_id": "edge-1",
                    "predicted_latency_ms": 10, "actual_response_ms": 12,
                    "metrics_json": json.dumps({"resultType": "task", "status": "succeeded", "actualResponseMs": 12}),
                    "recorded_at": "2026-01-01T00:00:00Z"})
            experiment, results = load_export(path)
        self.assertEqual(experiment["id"], "csv-test")
        self.assertEqual(results[0]["metrics"]["actualResponseMs"], 12)


if __name__ == "__main__":
    unittest.main()
