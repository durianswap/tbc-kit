import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// Cold/warm means empty/populated per-operation material caches. Engine is
// already initialized; synthetic fetch latency is not real API latency.
export async function measureUnifiedRoute(factories, samples = 20) {
  assert.equal(factories.length, 2);
  assert.equal(samples,20,'Median indexing is fixed for the documented20 samples');
  const values = [[], []], counts = [[], []];
  for (let round = 0; round < samples + 2; round++) {
    const plans = [];
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const lane = factories[index]();
      const start = performance.now(), cold = await lane.prepare();
      const coldEnd = performance.now(), coldReads = lane.reads();
      const warm = await lane.prepare(), warmEnd = performance.now();
      const warmReads = lane.reads() - coldReads;
      const plan = await lane.plan(warm), planEnd = performance.now();
      assert.equal(plan.ok, true, 'Timed plan must succeed');
      assert.equal(lane.reads(), coldReads + warmReads, 'Planning added a read');
      assert.ok(cold.snapshot.snapshotHash && cold.policy.policyHash);
      plans[index] = plan.result.plan.payload;
      if (round >= 2) {
        values[index].push({ coldPrepareMs: coldEnd-start, warmPrepareMs:warmEnd-coldEnd, planMs:planEnd-warmEnd });
        counts[index].push({coldReads,warmReads});
      }
    }
    assert.deepEqual(plans[0].transactions, plans[1].transactions);
    assert.deepEqual(plans[0].signingTasks, plans[1].signingTasks);
  }
  assert.deepEqual(counts[0],counts[1],'Timing pair read budgets diverged');
  for(const rows of counts) assert.ok(rows.every(r=>JSON.stringify(r)===JSON.stringify(rows[0])),'Fixture read count fluctuated');
  const summarize = rows => Object.fromEntries(['coldPrepareMs','warmPrepareMs','planMs'].map(key=>{
    const sorted=rows.map(r=>r[key]).sort((a,b)=>a-b);
    return [key,{median:Number(((sorted[9]+sorted[10])/2).toFixed(3)),p95:Number(sorted[Math.ceil(samples*.95)-1].toFixed(3))}];
  }));
  return {samples,warmup:2,order:'alternating',concrete:summarize(values[0]),unified:summarize(values[1]),
    readBudget:counts[0][0],rawSamples:values,
    scope:'Local cold/warm material preparation+policy and warmed WASM plan; no approval, signing, real network or device latency'};
}
