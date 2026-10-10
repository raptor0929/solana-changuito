import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readJob, sandboxMode, startJob } from '../checkout/sandbox.ts';

type Env = Parameters<typeof sandboxMode>[1];
const URL_SET = { SANDBOX_URL: 'https://sandbox.example' } as unknown as Env;
const NO_URL = {} as Env;
const OFF = { mock: false, mockFail: false };
const SHOPPER = { email: 'a@b.com', password: 'x', dni: '30123456' };
const ITEMS = [{ name: 'Fideos', quantity: 2, sku: '61450' }];
const ORDER = 'o'.repeat(64);

describe('sandbox mode comes from the config flags, not the environment', () => {
  it('sandbox_mock forces the mock even with SANDBOX_URL set', () => {
    assert.equal(sandboxMode({ mock: true, mockFail: false }, URL_SET), 'mock');
  });

  it('without the flag, SANDBOX_URL means remote and no URL means off', () => {
    assert.equal(sandboxMode(OFF, URL_SET), 'remote');
    assert.equal(sandboxMode(OFF, NO_URL), 'off');
  });

  it('ignores the old SANDBOX_MOCK variable', () => {
    assert.equal(sandboxMode(OFF, { SANDBOX_MOCK: '1' } as unknown as Env), 'off');
  });

  it('refuses to start a job when checkout is off', async () => {
    await assert.rejects(startJob(ORDER, ITEMS, SHOPPER, undefined, OFF, NO_URL));
  });

  it('a mock job walks to a placed order', async () => {
    const id = await startJob(ORDER, ITEMS, SHOPPER, undefined, { mock: true, mockFail: false }, URL_SET);
    assert.match(id, /^mock-k-/);
    const job = await readJob(id.replace(/^mock-k-\d+/, `mock-k-${Date.now() - 30_000}`));
    assert.equal(job.status, 'done');
    assert.equal(job.result?.payment, 'placed');
  });

  it('sandbox_mock_fail makes the card come back declined', async () => {
    const id = await startJob(ORDER, ITEMS, SHOPPER, undefined, { mock: true, mockFail: true }, NO_URL);
    assert.match(id, /^mock-f-/);
    const job = await readJob(id.replace(/^mock-f-\d+/, `mock-f-${Date.now() - 30_000}`));
    assert.equal(job.result?.payment, 'declined');
  });

  it('a running mock job reports its phase', async () => {
    const job = await readJob(`mock-k-${Date.now() - 8_000}-1`);
    assert.equal(job.status, 'running');
    assert.equal(job.phase, 'shop');
  });
});
