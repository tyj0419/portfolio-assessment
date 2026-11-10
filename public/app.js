const byId = id => document.getElementById(id);
const trade = byId('trade');
const save = byId('save');
let result;
let opened = false;
const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = number => number.toFixed(2) + '%';
const localTime = value => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value));

async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

// Tables and badges only interpolate fields from the bundled fixture or server-calculated numbers.
function badges(state) {
  const warnings = [
    ...state.holdings.filter(row => row.over).map(row => [row.code + ' ' + row.name, row]),
    ...state.sectors.filter(row => row.over).map(row => [row.sector + '行业', row]),
  ];
  return '<div class="badges">' + (warnings.length
    ? warnings.map(([label, row]) => `<span>${label} ${pct(row.percent)} ＞ ${pct(row.limit)}</span>`).join('')
    : '<span class="clear">无集中度超限</span>') + '</div>';
}
function table(headings, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headings.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(row => '<tr>' + row.map(value => `<td>${value}</td>`).join('') + '</tr>').join('')}</tbody></table></div>`;
}
function sectors(state) {
  return state.sectors.map(row => `${row.sector} ${money(row.value)} 元 · ${pct(row.percent)}`).join('　/　') || '无行业持仓';
}
function renderOverview(state) {
  byId('snapshot').textContent = `${state.id} · ${state.currency} · ${localTime(state.asOf)} 北京时间`;
  byId('overview').className = 'panel';
  byId('overview').innerHTML = `<h1>原始组合</h1><div class="metrics">
    <div class="metric">总资产 · 元<strong>${money(state.total)}</strong></div>
    <div class="metric">现金 · 元<strong>${money(state.cash)}</strong></div>
    <div class="metric">持仓标的<strong>${state.count} 只</strong></div></div>
    ${badges(state)}
    ${table(['标的','行业','价格 / 元','股数','市值 / 元','占比'], state.holdings.map(row =>
      [row.code + ' ' + row.name, row.sector, money(row.price), row.quantity, money(row.value), pct(row.percent)]))}
    <h3>行业分布</h3><p class="muted">${sectors(state)}</p>`;
}
function renderResult() {
  byId('operations').replaceChildren(...(result?.operations ?? []).map(operation => {
    const item = document.createElement('li');
    item.textContent = `${operation.side === 'buy' ? '买入' : '卖出'} ${operation.code} · ${operation.quantity} 股`;
    return item;
  }));
  if (!result) {
    byId('comparison').textContent = '添加第一笔操作后查看模拟结果。';
    return;
  }
  const { before, after } = result;
  const oldSectors = new Map(before.sectors.map(row => [row.sector, row]));
  const newSectors = new Map(after.sectors.map(row => [row.sector, row]));
  const sectorNames = new Set([...oldSectors.keys(), ...newSectors.keys()]);
  byId('comparison').innerHTML = `<h3>模拟对比</h3>
    <p>现金（元） ${money(before.cash)} → <strong>${money(after.cash)}</strong>　总资产（元） ${money(before.total)} → ${money(after.total)}</p>
    <div>调仓前 ${badges(before)}</div><div>调仓后 ${badges(after)}</div>
    ${table(['标的','股数 前 → 后','市值 / 元 前 → 后','占比 前 → 后'], after.holdings.map((row, i) => {
      const old = before.holdings[i];
      return [row.code + ' ' + row.name, `${old.quantity} → ${row.quantity}`,
        `${money(old.value)} → ${money(row.value)}`, `${pct(old.percent)} → ${pct(row.percent)}`];
    }))}
    <h3>行业集中度</h3>
    ${table(['行业','市值 / 元 前 → 后','占比 前 → 后'], [...sectorNames].map(name => {
      const old = oldSectors.get(name), next = newSectors.get(name);
      return [name, `${money(old?.value ?? 0)} → ${money(next?.value ?? 0)}`,
        `${pct(old?.percent ?? 0)} → ${pct(next?.percent ?? 0)}`];
    }))}`;
}
let ready = false;
function controls(busy) {
  document.querySelectorAll('button, input, select').forEach(el => { el.disabled = busy; });
  [...trade.elements].forEach(el => { el.disabled = busy || !ready || opened; });
  byId('clear-operations').disabled = busy || !ready || !result;
  [...save.elements].forEach(el => { el.disabled = busy || !result || opened; });
}
async function run(action) {
  controls(true);
  byId('error').hidden = true;
  byId('status').textContent = '处理中…';
  try {
    byId('status').textContent = await action();
  } catch (error) {
    byId('error').textContent = error.message;
    byId('error').hidden = false;
    byId('status').textContent = '';
  } finally {
    controls(false);
  }
}
async function loadPlans() {
  const plans = await api('/api/plans');
  const list = byId('plans');
  list.textContent = plans.length ? '' : '暂无方案。';
  for (const plan of plans) {
    const row = document.createElement('div');
    row.className = 'plan';
    const label = document.createElement('span');
    label.textContent = `${plan.name} · ${localTime(plan.createdAt)}`;
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = '重新打开';
    button.addEventListener('click', () => run(async () => {
      result = await api('/api/plans/' + plan.id);
      opened = true;
      renderResult();
      return `已打开方案「${result.name}」 · 只读。点击清空操作开始新的模拟。`;
    }));
    row.append(label, button);
    list.append(row);
  }
}
trade.addEventListener('submit', event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(trade));
  run(async () => {
    const operation = { ...values, quantity: Number(values.quantity) };
    result = await api('/api/simulate', { operations: [...(result?.operations ?? []), operation] });
    trade.elements.quantity.value = '';
    renderResult();
    return `已模拟 ${result.operations.length} 笔操作。`;
  });
});
byId('clear-operations').addEventListener('click', () => run(async () => {
  result = undefined;
  opened = false;
  trade.reset();
  save.reset();
  renderResult();
  return '已清空操作。';
}));
save.addEventListener('submit', event => {
  event.preventDefault();
  const name = save.elements.name.value;
  run(async () => {
    const plan = await api('/api/plans', { name, operations: result.operations });
    save.reset();
    try {
      await loadPlans();
    } catch (error) {
      byId('error').textContent = '方案已保存，列表更新失败，请刷新页面。';
      byId('error').hidden = false;
    }
    return `已保存方案「${plan.name}」。`;
  });
});
run(async () => {
  const state = await api('/api/portfolio');
  renderOverview(state);
  for (const row of state.holdings) trade.elements.code.add(new Option(row.code + ' ' + row.name, row.code));
  ready = true;
  renderResult();
  await loadPlans();
  return '';
});
