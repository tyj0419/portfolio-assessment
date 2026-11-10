import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('AC-01 through AC-05 over HTTP, including service restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'portfolio-test-'));
  let child;
  let origin;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  }
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: '0', PLAN_DIR: dir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    origin = String((await once(child.stdout, 'data'))[0]).trim();
  }
  async function call(path, payload, status = 200) {
    const response = await fetch(origin + '/api/' + path, payload === undefined ? {} : {
      method: 'POST', body: JSON.stringify(payload),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  await start();
  const sell = { code: 'A01', side: 'sell', quantity: 100 };
  const buy = { code: 'A02', side: 'buy', quantity: 100 };
  const operations = [sell, buy];
  const alerts = state => [...state.holdings, ...state.sectors]
    .filter(row => row.over).map(row => row.code ?? row.sector);
  const initial = await call('portfolio');
  await t.test('AC-01 初始组合', () => {
    assert.equal(initial.snapshotId, 'SNAP-20261102');
    assert.equal(initial.holdings[0].limit, 30);
    assert.equal(initial.sectors[0].limit, 50);
    assert.equal(initial.total, 10000000);
    assert.equal(initial.cash, 2000000);
    assert.equal(initial.holdings[0].percent, 40);
    assert.equal(initial.sectors[0].percent, 60);
    assert.deepEqual(alerts(initial), ['A01', '科技']);
  });
  const boundary = (await call('simulate', { operations: [sell] })).after;
  await t.test('AC-02 等阈值', () => {
    assert.equal(boundary.cash, 3000000);
    assert.equal(boundary.total, initial.total);
    assert.equal(boundary.holdings[0].value, 3000000);
    assert.equal(boundary.holdings[0].percent, 30);
    assert.equal(boundary.sectors[0].percent, 50);
    assert.deepEqual(alerts(boundary), []);
  });
  const result = await call('simulate', { operations });
  await t.test('AC-03 连续操作', () => {
    assert.equal(result.after.cash, 2500000);
    assert.equal(result.after.total, initial.total);
    assert.equal(result.after.holdings[1].quantity, 500);
    assert.equal(result.after.holdings[1].value, 2500000);
    assert.equal(result.after.sectors[0].percent, 55);
    assert.deepEqual(alerts(result.after), ['科技']);
  });
  await t.test('AC-04 拒绝无效操作且保留有效结果', async () => {
    for (const [operation, error] of [
      [{ ...sell, side: 'buy', quantity: 201 }, /现金不足/],
      [{ ...sell, quantity: 401 }, /超过当前持仓/],
      ...[0, -1, 0.5, '1'].map(quantity => [{ ...sell, quantity }, /正整数/]),
      [{ ...sell, code: 'A99' }, /不在行情快照/],
    ]) {
      assert.match((await call('simulate', { operations: [operation] }, 400)).error, error);
    }
    assert.match((await call('simulate', { operations: [sell, { ...sell, quantity: 301 }] }, 400)).error, /第 2 笔/);
    assert.deepEqual(await call('simulate', { operations }), result);
    assert.deepEqual(await call('portfolio'), initial);
  });
  await t.test('AC-05 保存、重启、重开与隔离', async () => {
    const name = '科技仓位调整';
    await call('plans', { name, operations: [] }, 400);
    await call('plans', { name, operations: [{ ...sell, quantity: 401 }] }, 400);
    assert.deepEqual(await call('plans'), []);
    const saved = await call('plans', { name, operations }, 201);
    await stop();
    await start();
    assert.equal((await call('plans'))[0].name, name);
    assert.deepEqual(await call('plans/' + saved.id), saved);
    assert.deepEqual(await call('portfolio'), initial);
  });
});
