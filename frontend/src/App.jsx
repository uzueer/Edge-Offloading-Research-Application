import { useCallback, useEffect, useMemo, useState } from 'react';

const algorithms = ['round-robin', 'edge-only', 'latency-aware'];
const labels = { 'round-robin': 'Round Robin', 'edge-only': 'Edge-only', 'latency-aware': 'Latency-aware' };
const number = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';

async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.message ?? data?.error ?? `Request failed (${response.status})`);
  return data;
}

function Stat({ label, value, suffix = '' }) {
  return <div className="stat"><span>{label}</span><strong>{value}{suffix}</strong></div>;
}

function BarChart({ title, rows, valueKey, suffix = 'ms', color = 'teal' }) {
  const max = Math.max(0, ...rows.map(row => Number(row[valueKey]) || 0));
  return <section className="chart-card">
    <div className="section-heading"><div><p className="eyebrow">OBSERVED RESULTS</p><h3>{title}</h3></div><span className="unit">{suffix}</span></div>
    {rows.length ? <div className="bars" role="img" aria-label={`${title} by scheduling algorithm`}>
      {rows.map(row => {
        const value = Number(row[valueKey]);
        const width = max > 0 && Number.isFinite(value) ? Math.max(2, value / max * 100) : 0;
        return <div className="bar-row" key={row.algorithm}>
          <span>{labels[row.algorithm] ?? row.algorithm}</span><div className="bar-track"><div className={`bar ${color}`} style={{ width: `${width}%` }} /></div><b>{number(value)}{suffix === 'ms' ? ' ms' : ''}</b>
        </div>;
      })}
    </div> : <p className="empty">Completed experiment data will appear here.</p>}
  </section>;
}

export default function App() {
  const [nodes, setNodes] = useState([]);
  const [experiments, setExperiments] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [experiment, setExperiment] = useState(null);
  const [results, setResults] = useState([]);
  const [taskForm, setTaskForm] = useState({ algorithm: 'latency-aware', workloadMI: 5, iterations: 50000, seed: 42, memoryMB: 64 });
  const [experimentForm, setExperimentForm] = useState({ name: 'Dashboard experiment', taskCount: 9, repetitions: 2, workloadMIMin: 1, workloadMIMax: 10, iterationsMin: 10000, iterationsMax: 50000, arrivalIntervalMs: 5, randomSeed: 26029 });
  const [taskResult, setTaskResult] = useState(null);
  const [busyTask, setBusyTask] = useState(false);
  const [busyExperiment, setBusyExperiment] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [nodeData, experimentData] = await Promise.all([api('/nodes'), api('/experiments?limit=30')]);
      setNodes(nodeData.nodes ?? []);
      setExperiments(experimentData.experiments ?? []);
      setUpdatedAt(new Date());
      setError('');
    } catch (cause) { setError(cause.message); }
  }, []);

  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);

  const loadExperiment = useCallback(async id => {
    if (!id) { setExperiment(null); setResults([]); return; }
    try {
      const [detail, resultData] = await Promise.all([api(`/experiments/${id}`), api(`/experiments/${id}/results`)]);
      setExperiment({ ...detail.experiment, progress: detail.progress });
      setResults(resultData.results ?? []);
    } catch (cause) { setError(cause.message); }
  }, []);

  useEffect(() => { if (selectedId) loadExperiment(selectedId); }, [selectedId, loadExperiment]);
  useEffect(() => {
    if (!selectedId || !busyExperiment) return undefined;
    const timer = setInterval(() => loadExperiment(selectedId), 1000);
    return () => clearInterval(timer);
  }, [selectedId, busyExperiment, loadExperiment]);

  useEffect(() => {
    if (experiments.length && !selectedId) setSelectedId(experiments[0].id);
  }, [experiments, selectedId]);

  const [profiles, setProfiles] = useState({});
  useEffect(() => {
    setProfiles(previous => Object.fromEntries(nodes.map(node => [node.id, {
      capacityMips: previous[node.id]?.capacityMips ?? node.resources?.capacityMips ?? 1,
      networkRttMs: previous[node.id]?.networkRttMs ?? node.configuredNetworkRttMs ?? 0,
      executionSlots: previous[node.id]?.executionSlots ?? node.resources?.executionSlots ?? 1,
      availableMemoryMB: previous[node.id]?.availableMemoryMB ?? node.resources?.availableMemoryMB ?? 0,
    }])));
  }, [nodes]);

  const aggregates = useMemo(() => results.filter(row => row.metrics?.resultType === 'aggregate'), [results]);
  const summaryRows = useMemo(() => algorithms.map(algorithm => {
    const grouped = aggregates.filter(row => row.algorithm === algorithm).map(row => row.metrics.summary ?? {});
    const avg = key => {
      const values = grouped.map(item => Number(item[key])).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    return { algorithm, meanResponseTimeMs: avg('meanResponseTimeMs'), p95ResponseTimeMs: avg('p95ResponseTimeMs'), throughputTasksPerSecond: avg('throughputTasksPerSecond'), successRate: avg('successRate') };
  }).filter(row => row.meanResponseTimeMs !== null || row.throughputTasksPerSecond !== null), [aggregates]);

  async function submitTask(event) {
    event.preventDefault(); setBusyTask(true); setTaskResult(null); setError('');
    try {
      const result = await api('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...taskForm, workloadMI: Number(taskForm.workloadMI), iterations: Number(taskForm.iterations), seed: Number(taskForm.seed), memoryMB: Number(taskForm.memoryMB) }) });
      setTaskResult(result); await refresh();
    } catch (cause) { setError(cause.message); }
    finally { setBusyTask(false); }
  }

  async function submitExperiment(event) {
    event.preventDefault(); setBusyExperiment(true); setError('');
    try {
      const payload = Object.fromEntries(Object.entries(experimentForm).map(([key, value]) => [key, ['name'].includes(key) ? value : Number(value)]));
      payload.nodeProfiles = profiles;
      const result = await api('/experiments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      setSelectedId(result.id); setExperiment({ ...result, progress: result.progress });
      await refresh();
    } catch (cause) { setError(cause.message); setBusyExperiment(false); }
  }

  useEffect(() => {
    if (experiment?.progress?.status === 'succeeded' || experiment?.progress?.status === 'failed') setBusyExperiment(false);
  }, [experiment]);

  const taskPrediction = taskResult?.decision?.candidates?.find(item => item.nodeId === taskResult.decision?.selectedNode?.id)?.estimate;
  const taskExecution = taskResult?.execution;
  const progress = experiment?.progress;
  const progressPercent = progress?.totalTasks ? Math.round((progress.completedTasks ?? 0) / progress.totalTasks * 100) : null;

  return <main className="shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">E</div><div><span className="eyebrow">RESEARCH CONSOLE</span><h1>Edge Offloading</h1></div></div><div className="live-state"><span className="live-dot" />Live data <span className="divider">·</span>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : 'Connecting'}</div></header>
    <section className="intro"><div><p className="eyebrow">LATENCY-AWARE TASK OFFLOADING</p><h2>Measure how work moves<br />across edge and cloud.</h2><p className="intro-copy">Inspect worker health, execute a task, and compare scheduling policies using recorded runs.</p></div><div className="intro-badge"><span>3</span><small>worker nodes</small><i>EDGE&nbsp; · &nbsp;CLOUD</i></div></section>
    {error && <div className="alert"><strong>Connection or request issue</strong><span>{error}</span><button onClick={() => { setError(''); refresh(); }}>Retry</button></div>}

    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">INFRASTRUCTURE</p><h2>Worker nodes</h2></div><span className="subtle">Health and configured resources · refreshes every 5 seconds</span></div>
      <div className="node-grid">{nodes.length ? nodes.map(node => <article className="node-card" key={node.id}><div className="node-head"><div><span className="node-role">{node.role === 'cloud' ? 'CLOUD WORKER' : 'EDGE WORKER'}</span><h3>{node.id}</h3></div><span className={`status ${node.healthy ? 'healthy' : 'unhealthy'}`}><i />{node.healthy ? 'Healthy' : 'Unavailable'}</span></div><div className="node-stats"><Stat label="Capacity" value={number(node.resources?.capacityMips, 0)} suffix=" MIPS"/><Stat label="Slots" value={node.resources?.executionSlots ?? '—'}/><Stat label="Available memory" value={number(node.resources?.availableMemoryMB, 0)} suffix=" MB"/></div><div className="node-foot"><span>Configured RTT</span><b>{number(node.configuredNetworkRttMs)} ms</b><small>{node.configuredNetworkKind ?? 'source unavailable'}</small></div></article>) : <div className="empty wide">Waiting for node data from the API…</div>}</div>
    </section>

    <div className="work-grid"><section className="panel"><div className="section-heading"><div><p className="eyebrow">TASK ORCHESTRATION</p><h2>Submit a task</h2></div><span className="step-number">01</span></div><p className="panel-copy">The selected scheduler filters unhealthy and ineligible nodes before dispatch.</p>
      <form onSubmit={submitTask} className="form-grid"><label className="span-2">Scheduling algorithm<select value={taskForm.algorithm} onChange={event => setTaskForm({ ...taskForm, algorithm: event.target.value })}>{algorithms.map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label><label>Workload <small>MI</small><input type="number" min="0" step="0.1" value={taskForm.workloadMI} onChange={event => setTaskForm({ ...taskForm, workloadMI: event.target.value })} required /></label><label>Iterations <small>worker count</small><input type="number" min="1" max="10000000" value={taskForm.iterations} onChange={event => setTaskForm({ ...taskForm, iterations: event.target.value })} required /></label><label>Memory <small>MB</small><input type="number" min="0" value={taskForm.memoryMB} onChange={event => setTaskForm({ ...taskForm, memoryMB: event.target.value })} /></label><label>Seed <small>uint32</small><input type="number" min="0" max="4294967295" value={taskForm.seed} onChange={event => setTaskForm({ ...taskForm, seed: event.target.value })} /></label><button className="primary span-2" disabled={busyTask}>{busyTask ? 'Executing task…' : 'Submit task'}<span>↗</span></button></form>
      {taskResult && <div className={`result-box ${taskResult.task?.status === 'succeeded' ? 'success' : 'failure'}`}><div className="result-title"><strong>{taskResult.task?.status === 'succeeded' ? 'Task completed' : 'Task failed'}</strong><span>{taskResult.worker?.nodeId ?? 'No worker selected'}</span></div><div className="result-metrics"><Stat label="Predicted total" value={number(taskPrediction?.totalPredictedLatencyMs)} suffix=" ms"/><Stat label="Actual response" value={number(taskExecution?.actualResponseMs)} suffix=" ms"/><Stat label="Actual execution" value={number(taskExecution?.actualExecutionMs)} suffix=" ms"/></div>{taskResult.task?.id && <small className="mono">Task {taskResult.task.id}</small>}</div>}
    </section>

    <section className="panel"><div className="section-heading"><div><p className="eyebrow">CONTROLLED COMPARISON</p><h2>Run experiment</h2></div><span className="step-number">02</span></div><p className="panel-copy">A seeded trace is replayed across all three policies, starting from idle workers.</p>
      <form onSubmit={submitExperiment} className="form-grid experiment-form"><label className="span-2">Experiment name<input value={experimentForm.name} onChange={event => setExperimentForm({ ...experimentForm, name: event.target.value })} required /></label><label>Tasks / policy<input type="number" min="1" max="100" value={experimentForm.taskCount} onChange={event => setExperimentForm({ ...experimentForm, taskCount: event.target.value })} /></label><label>Repetitions<input type="number" min="1" max="30" value={experimentForm.repetitions} onChange={event => setExperimentForm({ ...experimentForm, repetitions: event.target.value })} /></label><label>Workload min <small>MI</small><input type="number" min="0" step="0.1" value={experimentForm.workloadMIMin} onChange={event => setExperimentForm({ ...experimentForm, workloadMIMin: event.target.value })} /></label><label>Workload max <small>MI</small><input type="number" min="0" step="0.1" value={experimentForm.workloadMIMax} onChange={event => setExperimentForm({ ...experimentForm, workloadMIMax: event.target.value })} /></label><label>Iterations min<input type="number" min="1" max="10000000" value={experimentForm.iterationsMin} onChange={event => setExperimentForm({ ...experimentForm, iterationsMin: event.target.value })} /></label><label>Iterations max<input type="number" min="1" max="10000000" value={experimentForm.iterationsMax} onChange={event => setExperimentForm({ ...experimentForm, iterationsMax: event.target.value })} /></label><label>Arrival interval <small>ms</small><input type="number" min="0" max="60000" value={experimentForm.arrivalIntervalMs} onChange={event => setExperimentForm({ ...experimentForm, arrivalIntervalMs: event.target.value })} /></label><label>Random seed<input type="number" min="0" max="4294967295" value={experimentForm.randomSeed} onChange={event => setExperimentForm({ ...experimentForm, randomSeed: event.target.value })} /></label>
        <details className="span-2 profiles"><summary>Scheduler node profiles <small>(configured model inputs)</small></summary><div className="profile-grid">{nodes.map(node => <fieldset key={node.id}><legend>{node.id}</legend><label>Capacity · MIPS<input type="number" min="0.001" value={profiles[node.id]?.capacityMips ?? ''} onChange={event => setProfiles({ ...profiles, [node.id]: { ...profiles[node.id], capacityMips: Number(event.target.value) } })} /></label><label>RTT · ms<input type="number" min="0" value={profiles[node.id]?.networkRttMs ?? ''} onChange={event => setProfiles({ ...profiles, [node.id]: { ...profiles[node.id], networkRttMs: Number(event.target.value) } })} /></label></fieldset>)}</div></details>
        <button className="primary span-2" disabled={busyExperiment}>{busyExperiment ? 'Experiment running…' : 'Start experiment'}<span>↗</span></button>
      </form>
    </section></div>

    <section className="section-block results-section"><div className="section-heading"><div><p className="eyebrow">MEASURED OUTCOMES</p><h2>Experiment results</h2></div><div className="select-wrap"><label htmlFor="experiment-select">Select run</label><select id="experiment-select" value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">Choose an experiment</option>{experiments.map(item => <option value={item.id} key={item.id}>{item.name} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></div></div>
      {experiment && <div className="experiment-summary"><div><h3>{experiment.name}</h3><p>Seed {experiment.randomSeed ?? experiment.configuration?.randomSeed} <span>·</span> {experiment.repetitions} repetition(s) <span>·</span> {experiment.configuration?.taskCount} tasks per policy</p></div><div className="run-state"><span className={`status ${progress?.status === 'succeeded' ? 'healthy' : progress?.status === 'failed' ? 'unhealthy' : 'running'}`}><i />{progress?.status ?? experiment.runs?.[0]?.status ?? 'recorded'}</span>{progress && <span>{progress.completedRuns ?? 0}/{progress.totalRuns ?? experiment.repetitions} runs</span>}</div>{progressPercent !== null && progress?.status !== 'succeeded' && <div className="progress-track"><div style={{ width: `${progressPercent}%` }}/></div>}</div>}
      <div className="chart-grid"><BarChart title="Mean response time" rows={summaryRows} valueKey="meanResponseTimeMs"/><BarChart title="Throughput" rows={summaryRows} valueKey="throughputTasksPerSecond" suffix=" tasks/s" color="blue"/></div>
      {summaryRows.length > 0 ? <div className="table-wrap"><table><thead><tr><th>Algorithm</th><th>Mean response</th><th>Median / P95</th><th>Throughput</th><th>Success rate</th></tr></thead><tbody>{summaryRows.map(row => <tr key={row.algorithm}><td><span className="algorithm-dot" />{labels[row.algorithm]}</td><td>{number(row.meanResponseTimeMs)} ms</td><td>{number(aggregates.filter(item => item.algorithm === row.algorithm).map(item => item.metrics.summary?.medianResponseTimeMs).filter(Number.isFinite).reduce((a, b) => a + b, 0) / Math.max(1, aggregates.filter(item => item.algorithm === row.algorithm && Number.isFinite(item.metrics.summary?.medianResponseTimeMs)).length))} / {number(row.p95ResponseTimeMs)} ms</td><td>{number(row.throughputTasksPerSecond, 3)} tasks/s</td><td>{row.successRate === null ? '—' : `${number(row.successRate * 100, 1)}%`}</td></tr>)}</tbody></table></div> : <div className="empty wide">Select a completed experiment to inspect recorded results.</div>}
      {experiment && <div className="export-row"><span>Exports include trace inputs, predictions, and actual timings.</span><a href={`/api/experiments/${experiment.id}/export?format=csv`}>Download CSV ↓</a><a href={`/api/experiments/${experiment.id}/export?format=json`}>Download JSON ↓</a></div>}
    </section>
    <footer><span>Edge Offloading Research Console</span><span>Predictions and measurements are shown separately · configured RTT is simulated</span></footer>
  </main>;
}
