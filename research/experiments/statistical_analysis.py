"""Public analysis-module entry point; observations are independent repetition means."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analysis"))
from analyze_experiments import (  # noqa: E402,F401
    analyze,
    bootstrap_mean_ci,
    exact_sign_test_pvalue,
    nearest_rank_percentile,
)
