#!/usr/bin/env python3
"""Run the configured seeded benchmark matrix against the local experiment API."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent


def request_json(url: str, method: str = "GET", body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def stable_seed(base: int, key: str) -> int:
    digest = hashlib.sha256(f"{base}:{key}".encode()).digest()
    return int.from_bytes(digest[:4], "big")


def atomic_json(path: Path, data: dict) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def save_export(base_url: str, experiment_id: str, output: Path):
    output.mkdir(parents=True, exist_ok=True)
    for kind in ("json", "csv"):
        request = Request(f"{base_url}/experiments/{experiment_id}/export?format={kind}")
        with urlopen(request, timeout=120) as response:
            (output / f"{experiment_id}.{kind}").write_bytes(response.read())


def experiment_progress(status: dict) -> dict:
    progress = status.get("progress")
    if progress:
        return progress
    # In-memory progress disappears on API restart; infer only durable run state.
    runs = (status.get("experiment") or {}).get("runs", [])
    if runs and all(run.get("status") == "succeeded" for run in runs):
        return {"status": "succeeded", "completedRuns": len(runs), "completedTasks": None}
    if any(run.get("status") == "failed" for run in runs):
        return {"status": "failed", "error": "one or more persisted repetitions failed"}
    if runs:
        return {"status": "interrupted", "error": "API process restarted before all repetitions completed"}
    return {"status": "unavailable", "error": "no progress or persisted run state returned"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "experiment_config.json")
    parser.add_argument("--base-url")
    parser.add_argument("--output-dir", type=Path, default=ROOT.parent / "results")
    parser.add_argument("--resume", action="store_true", help="Skip matrix cells already completed in the local manifest")
    parser.add_argument("--capacity-profile", choices=["all", "edge_faster", "cloud_faster", "default"], default="all")
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    base = (args.base_url or config["baseUrl"]).rstrip("/")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if args.resume and manifest_path.exists() else {"experiments": {}}
    profiles = {"default": {}}
    profiles.update(config["capacityProfiles"])
    if args.capacity_profile != "all":
        profiles = {args.capacity_profile: profiles[args.capacity_profile]}
    total = len(config["taskCounts"]) * len(config["networkProfiles"]) * len(profiles)
    print(f"Matrix: {total} configurations × {config['repetitions']} repetitions × 3 policies")
    print("Network profiles are simulated RTT values; worker containers share the host.")

    for tasks in config["taskCounts"]:
        for network_name, rtts in config["networkProfiles"].items():
            for capacity_name, node_resources in profiles.items():
                key = f"tasks={tasks}|network={network_name}|capacity={capacity_name}"
                previous = manifest["experiments"].get(key)
                if previous and previous.get("status") == "succeeded":
                    print(f"skip completed {key} ({previous['experimentId']})")
                    continue
                seed = stable_seed(config["randomSeed"], key)
                node_profiles = {node: {**node_resources.get(node, {}), "networkRttMs": rtt}
                                 for node, rtt in rtts.items()}
                payload = {
                    "name": f"benchmark {key}", "taskCount": tasks, "repetitions": config["repetitions"],
                    "randomSeed": seed, "workloadMIMin": config["workloadMIMin"],
                    "workloadMIMax": config["workloadMIMax"], "iterationsMin": config["iterationsMin"],
                    "iterationsMax": config["iterationsMax"], "arrivalIntervalMs": config["arrivalIntervalMs"],
                    "memoryMB": config["memoryMBMin"], "memoryMBMax": config["memoryMBMax"],
                    "minCapacityMips": config["minCapacityMipsMin"],
                    "minCapacityMipsMax": config["minCapacityMipsMax"], "nodeProfiles": node_profiles,
                    "scenario": {"taskCount": tasks, "networkProfile": network_name,
                                 "capacityProfile": capacity_name, "simulatedRTTMs": rtts}
                }
                try:
                    request_json(f"{base}/health")
                    if previous and previous.get("status") == "running":
                        # Reattach to an existing durable API experiment; do not create duplicate task runs.
                        experiment_id = previous["experimentId"]
                        progress = experiment_progress(request_json(f"{base}/experiments/{experiment_id}"))
                        if progress.get("status") in ("interrupted", "failed", "unavailable"):
                            raise RuntimeError(f"existing experiment {experiment_id} cannot continue: {progress.get('error')}")
                    else:
                        # Warm-up is a separate persisted experiment, excluded from measured result exports.
                        warmup = {**payload, "name": f"warmup {key}", "taskCount": config["warmupTasks"],
                                  "repetitions": 1, "randomSeed": seed ^ 0xA5A5A5A5}
                        warm = request_json(f"{base}/experiments", "POST", warmup)
                        warm_id = warm["id"]
                        while True:
                            status = experiment_progress(request_json(f"{base}/experiments/{warm_id}"))
                            if status.get("status") in ("succeeded", "failed", "interrupted", "unavailable"):
                                break
                            time.sleep(2)
                        save_export(base, warm_id, args.output_dir / "warmups")
                        if status["status"] != "succeeded":
                            raise RuntimeError(f"warm-up failed: {status.get('error')}")

                        experiment = request_json(f"{base}/experiments", "POST", payload)
                        experiment_id = experiment["id"]
                        manifest["experiments"][key] = {"experimentId": experiment_id, "warmupId": warm_id,
                            "seed": seed, "status": "running", "configuration": payload}
                        atomic_json(manifest_path, manifest)
                    while True:
                        status = request_json(f"{base}/experiments/{experiment_id}")
                        progress = experiment_progress(status)
                        print(f"{key}: {progress.get('completedRuns', 0)}/{config['repetitions']} repetitions; "
                              f"{progress.get('completedTasks', 0)}/{config['repetitions'] * tasks * 3} tasks", end="\r")
                        if progress.get("status") in ("succeeded", "failed", "interrupted", "unavailable"):
                            break
                        time.sleep(2)
                    save_export(base, experiment_id, args.output_dir / "raw")
                    record = manifest["experiments"][key]
                    record["status"] = progress["status"]
                    record["error"] = progress.get("error")
                    atomic_json(manifest_path, manifest)
                    print(f"\n{key}: {progress['status']} ({experiment_id})")
                    if progress["status"] != "succeeded":
                        return 2
                except (URLError, HTTPError, TimeoutError, RuntimeError, KeyError) as error:
                    print(f"\nStopped at {key}: {error}")
                    print("Completed cells remain archived in manifest.json; rerun with --resume after recovery.")
                    return 2
    print(f"Completed matrix exports are in {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
