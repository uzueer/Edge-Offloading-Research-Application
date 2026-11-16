ALTER TABLE scheduling_decisions
  DROP CONSTRAINT scheduling_decisions_algorithm_check,
  ADD CONSTRAINT scheduling_decisions_algorithm_check
    CHECK (algorithm IN ('round-robin', 'edge-only', 'fewest-active-tasks', 'latency-aware'));

ALTER TABLE experiment_results
  DROP CONSTRAINT experiment_results_algorithm_check,
  ADD CONSTRAINT experiment_results_algorithm_check
    CHECK (algorithm IN ('round-robin', 'edge-only', 'fewest-active-tasks', 'latency-aware'));
