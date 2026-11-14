function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportExperimentJson(experiment, results) {
  return JSON.stringify({ experiment, results }, null, 2);
}

export function exportExperimentCsv(experiment, results) {
  const columns = ['experiment_id', 'configuration_json', 'run_id', 'repetition', 'random_seed',
    'algorithm', 'record_type', 'task_id', 'node_id', 'predicted_latency_ms', 'actual_response_ms',
    'metrics_json', 'recorded_at'];
  const lines = [columns.map(csvCell).join(',')];
  for (const row of results) {
    const values = [experiment.id, JSON.stringify(experiment.configuration), row.runId, row.repetition,
      row.randomSeed, row.algorithm, row.metrics?.resultType ?? 'task', row.taskId, row.nodeId,
      row.predictedLatencyMs, row.actualResponseMs, JSON.stringify(row.metrics), row.recordedAt?.toISOString?.() ?? row.recordedAt];
    lines.push(values.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
