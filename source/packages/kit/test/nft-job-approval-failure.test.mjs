import assert from 'node:assert/strict';
import test from 'node:test';
import {harness, NOW} from './nft-job-stress-fixture.mjs';

test('native approval rejection at or after the job deadline returns expired through Provider', async () => {
  for (const elapsed of [120000, 120001]) {
    let h;
    h = await harness(1, {duringApprove: async () => {
      h.setClock(NOW + elapsed);
      throw new Error('native approval fence expired');
    }});
    try {
      const result = await h.wallet.tbc721.batchMint(h.input);
      assert.equal(result.status, 'stopped');
      assert.equal(result.reason, 'expired');
      assert.equal(result.minted, 0);
      assert.deepEqual(result.batches, []);
      assert.equal(h.stats().approvals, 1);
      assert.equal(h.stats().signatures, 0);
      assert.equal(h.dispatched.length, 0);
      assert.deepEqual(h.calls, {index:1,native:1,raw:0,decoded:0,status:0,reconcile:0});
    } finally { h.close(); }
  }
});

test('approval adapter failure before the deadline is not disguised as expiry', async () => {
  const h = await harness(1, {duringApprove: async () => { throw new Error('adapter failure'); }});
  try {
    await assert.rejects(h.wallet.tbc721.batchMint(h.input), e => e.code === -32603);
    assert.equal(h.stats().signatures, 0);
    assert.equal(h.dispatched.length, 0);
  } finally { h.close(); }
});

test('cancelled native approval rejection returns cancelled without signing', async () => {
  const abort = new AbortController();
  const h = await harness(1, {duringApprove: async () => {
    abort.abort();
    throw new Error('native approval cancelled');
  }});
  try {
    const result = await h.session.runNftMintJob({...h.input, signal:abort.signal});
    assert.equal(result.status, 'stopped');
    assert.equal(result.reason, 'cancelled');
    assert.equal(h.stats().approvals, 1);
    assert.equal(h.stats().signatures, 0);
    assert.equal(h.dispatched.length, 0);
  } finally { h.close(); }
});

test('a returned tampered consent remains invalid even when the deadline elapsed', async () => {
  const h = await harness(1, {badConsent:true, expireInApproval:true});
  try {
    await assert.rejects(h.wallet.tbc721.batchMint(h.input), e => e.code === -32603);
    assert.equal(h.stats().signatures, 0);
    assert.equal(h.dispatched.length, 0);
  } finally { h.close(); }
});
