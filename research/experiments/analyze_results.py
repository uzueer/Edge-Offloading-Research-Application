#!/usr/bin/env python3
"""Analyze one actual API export and write tables and publication-size figures."""
from pathlib import Path
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analysis"))
runpy.run_path(str(Path(__file__).resolve().parents[1] / "analysis" / "analyze_experiments.py"), run_name="__main__")
