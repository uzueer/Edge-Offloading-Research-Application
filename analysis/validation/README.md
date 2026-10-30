# Validation-only experiment export

`compose-smoke-export.json` was downloaded from the running Phase 5 API after a real execution on the local Compose workers. It is not synthetic, but it is a small pipeline smoke run and must not be presented as research evidence or as support for an algorithm performance claim.

- Experiment ID: `9260152a-9ad9-4c0b-908a-ca31e1e3de90`
- Seed: `26029`
- Trace: 6 tasks per policy, 2 repetitions, 36 task-level records total
- Execution: all three worker containers on one host; network RTT configured as simulated; node MIPS values are scheduler profiles
- Figures and tables were generated from this API export using the pinned analysis dependencies and bootstrap seed `2026`.

Regenerate the analysis with:

```sh
python analysis/analyze_experiments.py \
  --input analysis/validation/compose-smoke-export.json \
  --output-dir analysis/validation/figures \
  --seed 2026 \
  --bootstrap-samples 2000
```

The small number of repetitions provides weak statistical resolution. The generated plots demonstrate the pipeline only; they are not a comparative research conclusion.
