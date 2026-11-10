import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, simulate } from './portfolio.js';

const source = JSON.parse((await readFile(new URL('./data/portfolio.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
// The bundled fixture expresses money and thresholds as decimal strings with two places.
const hundredths = value => Number(value.replace('.', ''));
const snapshot = {
  id: source.portfolio_id,
  snapshotId: source.snapshot_id,
  // Keep the existing replay version: the official fixture confirms identical inputs and rules.
  version: 'demo-2026-11-02-v1',
  asOf: source.snapshot_at,
  currency: source.currency,
  cash: hundredths(source.cash),
  singleLimit: hundredths(source.rules.single_instrument_threshold),
  sectorLimit: hundredths(source.rules.industry_threshold),
  assets: source.instruments.map(({ symbol, name, industry, price, quantity }) => ({
    code: symbol, name, sector: industry, price: hundredths(price), quantity,
  })),
};
const storage = process.env.PLAN_DIR ?? fileURLToPath(new URL('./runtime/', import.meta.url));
await mkdir(storage, { recursive: true });

const staticFiles = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
};

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 32768) chunks.push(chunk);
  }
  if (size > 32768) throw new InputError('请求体超过 32 KiB。');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    throw new InputError('请求体必须是合法 JSON。');
  }
  throw new InputError('请求体必须是 JSON 对象。');
}

function loadPlan(id) {
  return readFile(join(storage, id + '.json'), 'utf8').then(JSON.parse);
}

const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

const server = createServer(async (request, response) => {
  const send = (status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (request.method === 'GET' && Object.hasOwn(staticFiles, path)) {
      const [file, type] = staticFiles[path];
      const content = await readFile(new URL('./public/' + file, import.meta.url));
      response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      return response.end(content);
    }
    if (request.method === 'GET' && path === '/api/portfolio') {
      const { id, snapshotId, version, asOf, currency } = snapshot;
      return send(200, { id, snapshotId, version, asOf, currency, ...simulate(snapshot, []).before });
    }
    if (request.method === 'POST' && path === '/api/simulate') {
      return send(200, simulate(snapshot, (await body(request)).operations));
    }
    if (path === '/api/plans' && request.method === 'POST') {
      const { name, operations } = await body(request);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
        throw new InputError('方案名称须为 1 至 60 个字符。');
      }
      const result = simulate(snapshot, operations);
      if (!result.operations.length) throw new InputError('请先添加至少一笔有效操作。');
      const plan = {
        id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString(),
        snapshotVersion: snapshot.version, operations: result.operations,
      };
      const temporary = join(storage, plan.id + '.tmp');
      await writeFile(temporary, JSON.stringify(plan, null, 2), { flag: 'wx' });
      await rename(temporary, join(storage, plan.id + '.json'));
      return send(201, { ...plan, ...result });
    }
    if (path === '/api/plans' && request.method === 'GET') {
      const ids = (await readdir(storage)).filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -5)).filter(id => idPattern.test(id));
      const plans = await Promise.all(ids.map(loadPlan));
      return send(200, plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ id, name, createdAt }) => ({ id, name, createdAt })));
    }
    const id = path.startsWith('/api/plans/') && path.slice(11);
    if (request.method === 'GET' && id && idPattern.test(id)) {
      const plan = await loadPlan(id).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!plan) return send(404, { error: '方案不存在。' });
      if (plan.snapshotVersion !== snapshot.version) {
        return send(409, { error: '该方案的行情快照版本已不可用。' });
      }
      return send(200, { ...plan, ...simulate(snapshot, plan.operations) });
    }
    return send(404, { error: '接口不存在。' });
  } catch (error) {
    if (error instanceof InputError) return send(400, { error: error.message });
    console.error(error);
    return send(500, { error: '服务器处理失败，请重试。' });
  }
});
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});
