export class InputError extends Error {}

export function summarize(snapshot, quantities, cash) {
  const holdings = snapshot.assets.map((asset, i) => ({
    ...asset, quantity: quantities[i], value: asset.price * quantities[i],
  }));
  const total = holdings.reduce((sum, row) => sum + row.value, cash);
  const sectorValues = new Map();
  for (const row of holdings) {
    if (row.quantity) sectorValues.set(row.sector, (sectorValues.get(row.sector) ?? 0) + row.value);
  }
  const measure = (row, limit) => ({
    ...row, percent: total ? row.value * 100 / total : 0,
    limit, over: row.value * 100 > total * limit,
  });
  return {
    cash, total, count: holdings.filter(row => row.quantity > 0).length,
    holdings: holdings.map(row => measure(row, snapshot.singleLimit)),
    sectors: [...sectorValues].map(([sector, value]) => measure({ sector, value }, snapshot.sectorLimit)),
  };
}

export function simulate(snapshot, operations) {
  if (!Array.isArray(operations) || operations.length > 100) {
    throw new InputError('操作必须是数组，最多 100 笔。');
  }
  const quantities = snapshot.assets.map(asset => asset.quantity);
  let cash = snapshot.cash;
  const before = summarize(snapshot, quantities, cash);
  const trades = operations.map((operation, index) => {
    const { code, side, quantity } = operation ?? {};
    const i = snapshot.assets.findIndex(asset => asset.code === code);
    const fail = message => { throw new InputError(`第 ${index + 1} 笔：${message}`); };
    if (i < 0) fail('标的不在行情快照中。');
    if (side !== 'buy' && side !== 'sell') fail('方向必须为买入或卖出。');
    if (!Number.isSafeInteger(quantity) || quantity <= 0) fail('数量必须为正整数。');
    const { price } = snapshot.assets[i];
    if (side === 'buy') {
      if (quantity > Math.floor(cash / price)) fail('可用现金不足。');
      cash -= quantity * price;
      quantities[i] += quantity;
    } else {
      if (quantity > quantities[i]) fail('卖出数量超过当前持仓。');
      cash += quantity * price;
      quantities[i] -= quantity;
    }
    return { code, side, quantity };
  });
  return { operations: trades, before, after: summarize(snapshot, quantities, cash) };
}
