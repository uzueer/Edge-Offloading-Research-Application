import { createHash } from 'node:crypto';

export const DEFAULT_MAX_ITERATIONS = 10_000_000;
const UINT32_MAX = 0xffff_ffff;

export function validateComputeRequest(value, { maxIterations = DEFAULT_MAX_ITERATIONS } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('JSON object body is required');
  if (!Number.isSafeInteger(value.iterations) || value.iterations < 1 || value.iterations > maxIterations) {
    throw new RangeError(`iterations must be an integer from 1 to ${maxIterations}`);
  }
  const seed = value.seed ?? 1;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > UINT32_MAX) {
    throw new RangeError('seed must be an integer from 0 to 4294967295');
  }
  const workloadMI = value.workloadMI ?? 0;
  if (typeof workloadMI !== 'number' || !Number.isFinite(workloadMI) || workloadMI < 0) {
    throw new RangeError('workloadMI must be finite and non-negative');
  }
  if (value.taskId !== undefined && (typeof value.taskId !== 'string' || value.taskId.length < 1 || value.taskId.length > 200)) {
    throw new TypeError('taskId must be a non-empty string up to 200 characters');
  }
  return { taskId: value.taskId ?? null, iterations: value.iterations, seed, workloadMI };
}

/** Deterministic CPU-bound uint32 recurrence, yielding periodically for health/queue handling. */
export async function executeDeterministicWork({ iterations, seed }, { chunkSize = 25_000 } = {}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError('chunkSize must be a positive integer');
  let state = seed >>> 0;
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    checksum = (checksum + (state ^ i)) >>> 0;
    if ((i + 1) % chunkSize === 0) await new Promise(resolve => setImmediate(resolve));
  }
  const canonical = JSON.stringify({ iterations, seed, state, checksum });
  return {
    iterations,
    seed,
    state,
    checksum,
    outputSha256: createHash('sha256').update(canonical).digest('hex'),
  };
}
