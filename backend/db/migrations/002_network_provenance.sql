ALTER TABLE task_executions
  ADD COLUMN actual_network_kind TEXT;

ALTER TABLE task_executions
  ADD CONSTRAINT task_executions_network_kind_check
  CHECK (
    (actual_network_ms IS NULL AND actual_network_kind IS NULL) OR
    (actual_network_ms IS NOT NULL AND actual_network_kind IN ('measured', 'simulated'))
  );
