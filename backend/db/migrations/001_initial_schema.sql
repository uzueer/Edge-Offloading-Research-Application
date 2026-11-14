CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('edge', 'cloud')),
  capacity_mips NUMERIC(18, 6) NOT NULL CHECK (capacity_mips > 0),
  execution_slots INTEGER NOT NULL CHECK (execution_slots > 0),
  available_memory_mb NUMERIC(18, 3) NOT NULL CHECK (available_memory_mb >= 0),
  healthy BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE node_measurements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  measurement_type TEXT NOT NULL CHECK (measurement_type IN ('network_rtt', 'cpu_utilization', 'available_memory')),
  value NUMERIC(20, 6) NOT NULL CHECK (value >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('ms', 'percent', 'MB')),
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (measurement_type = 'network_rtt' AND unit = 'ms') OR
    (measurement_type = 'cpu_utilization' AND unit = 'percent' AND value <= 100) OR
    (measurement_type = 'available_memory' AND unit = 'MB')
  )
);
CREATE INDEX node_measurements_recent_idx ON node_measurements(node_id, measurement_type, observed_at DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workload_mi NUMERIC(20, 6) NOT NULL CHECK (workload_mi >= 0),
  memory_mb NUMERIC(18, 3) NOT NULL DEFAULT 0 CHECK (memory_mb >= 0),
  min_capacity_mips NUMERIC(18, 6) NOT NULL DEFAULT 0 CHECK (min_capacity_mips >= 0),
  work_ahead_mi NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (work_ahead_mi >= 0),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'scheduled', 'running', 'succeeded', 'failed')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduling_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('round-robin', 'edge-only', 'latency-aware')),
  selected_node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('scheduled', 'no-eligible-node')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((decision = 'scheduled' AND selected_node_id IS NOT NULL) OR
         (decision = 'no-eligible-node' AND selected_node_id IS NULL))
);
CREATE INDEX scheduling_decisions_task_idx ON scheduling_decisions(task_id, created_at DESC);

CREATE TABLE decision_candidates (
  decision_id BIGINT NOT NULL REFERENCES scheduling_decisions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  eligible BOOLEAN NOT NULL,
  ineligibility_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ineligibility_reasons) = 'array'),
  predicted_network_delay_ms NUMERIC(20, 6) CHECK (predicted_network_delay_ms >= 0),
  predicted_queueing_delay_ms NUMERIC(20, 6) CHECK (predicted_queueing_delay_ms >= 0),
  predicted_execution_time_ms NUMERIC(20, 6) CHECK (predicted_execution_time_ms >= 0),
  predicted_total_latency_ms NUMERIC(20, 6) CHECK (predicted_total_latency_ms >= 0),
  PRIMARY KEY (decision_id, node_id),
  CHECK (
    predicted_total_latency_ms IS NULL OR
    (predicted_network_delay_ms IS NOT NULL AND predicted_queueing_delay_ms IS NOT NULL AND
     predicted_execution_time_ms IS NOT NULL AND
     abs(predicted_total_latency_ms - predicted_network_delay_ms - predicted_queueing_delay_ms - predicted_execution_time_ms) <= 0.00001)
  )
);

CREATE TABLE task_executions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  actual_network_ms NUMERIC(20, 6) CHECK (actual_network_ms >= 0),
  actual_queueing_ms NUMERIC(20, 6) CHECK (actual_queueing_ms >= 0),
  actual_execution_ms NUMERIC(20, 6) CHECK (actual_execution_ms >= 0),
  actual_response_ms NUMERIC(20, 6) CHECK (actual_response_ms >= 0),
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'succeeded' AND error IS NULL) OR status = 'failed')
);

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  configuration JSONB NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  random_seed BIGINT,
  repetitions INTEGER NOT NULL CHECK (repetitions > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experiment_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  repetition INTEGER NOT NULL CHECK (repetition >= 0),
  random_seed BIGINT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (experiment_id, repetition)
);

CREATE TABLE experiment_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES experiment_runs(id) ON DELETE RESTRICT,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('round-robin', 'edge-only', 'latency-aware')),
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  predicted_latency_ms NUMERIC(20, 6) CHECK (predicted_latency_ms >= 0),
  actual_response_ms NUMERIC(20, 6) CHECK (actual_response_ms >= 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX experiment_results_run_idx ON experiment_results(run_id, algorithm);
