import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { STOCKS, INITIAL_CASH_CENTS } from '@stock/shared';
import { createMemoryStore } from '../apps/server/dist/store/memory-store.js';
import { createTradingService } from '../apps/server/dist/services/trading.service.js';
import { PriceTreeOrderBook } from '../apps/server/dist/matching/price-tree-book.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const scenarios = ['resting-sparse', 'fifo-dense', 'sweep-sparse'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const key = (index) => '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
const user = (side, index) => side.toLowerCase() + '-' + (index % 100);

function request(side, priceCents, quantity, index, owner = index) {
  return {
    userId: user(side, owner),
    input: { clientOrderId: key(index), symbol: 'SIM001', side, priceCents, quantity },
  };
}
function commands(scenario, depth, samples) {
  return Array.from({ length: samples }, (_, i) => {
    const id = depth + i;
    if (scenario === 'resting-sparse') return request('BUY', 9000 - (i % 2000), 1, id, i);
    if (scenario === 'fifo-dense')
      return request(i % 2 === 0 ? 'BUY' : 'SELL', 10000, 1, id, Math.floor(i / 2));
    const cycle = Math.floor(i / 17);
    const phase = i % 17;
    return phase === 0
      ? request('BUY', 20000 + depth + samples, 16, id, cycle)
      : request('SELL', 10000 + depth + cycle * 16 + phase - 1, 1, id, cycle * 16 + phase - 1);
  });
}
function setup(engine, scenario, depth, capacity) {
  const store = createMemoryStore({ matchingEngine: engine, now: () => 1700000000000 });
  // This constructs benchmark participants, not production registration or free inventory APIs.
  for (const side of ['BUY', 'SELL']) {
    for (let i = 0; i < 100; i++) {
      const id = user(side, i);
      store.users.set(id, {
        id,
        username: id,
        kind: 'USER',
        passwordHash: '',
        passwordSalt: '',
        createdAt: new Date(store.now()).toISOString(),
      });
      store.accounts.set(id, {
        userId: id,
        cashBalanceCents: INITIAL_CASH_CENTS,
        frozenCashCents: 0,
        version: 0,
      });
      store.positions.set(
        id,
        new Map(
          STOCKS.map(({ symbol }) => [
            symbol,
            {
              userId: id,
              symbol,
              quantity: side === 'SELL' ? 1000000 : 0,
              frozenQuantity: 0,
            },
          ]),
        ),
      );
    }
  }
  // Both arms use the same larger caps so the growth workload can exceed the demo cap.
  const service = createTradingService(store, {
    maxActiveOrders: capacity + 100,
    maxActiveOrdersPerUser: capacity + 100,
  });
  for (let i = 0; i < depth; i++) {
    const seed = request('SELL', scenario === 'fifo-dense' ? 10000 : 10000 + i, 1, i);
    service.submitOrder(seed.userId, seed.input);
  }
  return { store, service };
}
function economicState(store) {
  const orderId = (id) => store.orders.get(id).sequence;
  const tradeId = (id) => store.trades.get(id).sequence;
  return {
    accounts: [...store.accounts],
    positions: [...store.positions].map(([id, positions]) => [id, [...positions]]),
    quotes: [...store.stocks],
    orders: [...store.orders.values()].map((o) => ({ ...o, id: o.sequence })),
    trades: [...store.trades.values()].map((t) => ({
      ...t,
      id: t.sequence,
      buyOrderId: orderId(t.buyOrderId),
      sellOrderId: orderId(t.sellOrderId),
    })),
    books: [...store.orderBooks].map(([symbol, book]) => [
      symbol,
      book.buyOrderIds.map(orderId),
      book.sellOrderIds.map(orderId),
    ]),
    ordersByUser: [...store.ordersByUser].map(([id, ids]) => [id, ids.map(orderId)]),
    activeOrdersByUser: [...store.activeOrdersByUser].map(([id, ids]) => [
      id,
      [...ids].map(orderId),
    ]),
    tradesByUser: [...store.tradesByUser].map(([id, ids]) => [id, ids.map(tradeId)]),
    marketTrades: store.marketTradeIds.map(tradeId),
    idempotency: [...store.idempotentOrdersByUser].map(([id, values]) => [
      id,
      [...values].map(([k, v]) => [k, { ...v, orderId: orderId(v.orderId) }]),
    ]),
    orderSequence: store.orderSequence,
    tradeSequence: store.tradeSequence,
    marketVersion: store.marketVersion,
    activeOrderCount: store.activeOrderCount,
    liquiditySeeded: store.liquiditySeeded,
  };
}
function totals(store) {
  return {
    cash: [...store.accounts.values()].reduce((n, a) => n + BigInt(a.cashBalanceCents), 0n),
    shares: STOCKS.map(({ symbol }) =>
      [...store.positions.values()].reduce((n, p) => n + BigInt(p.get(symbol)?.quantity ?? 0), 0n),
    ),
  };
}
function bookShape(store) {
  const book = store.orderBooks.get('SIM001');
  const ids = [...book.buyOrderIds, ...book.sellOrderIds];
  return {
    activeOrders: ids.length,
    buyLevels: new Set(book.buyOrderIds.map((id) => store.orders.get(id).priceCents)).size,
    sellLevels: new Set(book.sellOrderIds.map((id) => store.orders.get(id).priceCents)).size,
  };
}
function warmUp(config) {
  const { engine, scenario, depth, warmup } = config;
  const { service } = setup(engine, scenario, depth, depth + warmup);
  for (const command of commands(scenario, depth, warmup))
    service.submitOrder(command.userId, command.input);
}
function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function worker(config) {
  warmUp(config);
  global.gc();
  const { engine, scenario, depth, samples } = config;
  const { store, service } = setup(engine, scenario, depth, depth + samples);
  const stream = commands(scenario, depth, samples);
  const before = bookShape(store);
  const initialTotals = totals(store);
  const latencies = new Float64Array(samples);
  global.gc();
  // Timing covers the public synchronous command, including validation and settlement.
  // Setup, warmup, HTTP/WS, sorting timings and full-state audits are outside this window.
  const started = performance.now();
  for (let i = 0; i < stream.length; i++) {
    const command = stream[i];
    const start = performance.now();
    service.submitOrder(command.userId, command.input);
    latencies[i] = (performance.now() - start) * 1000;
  }
  const elapsedMs = performance.now() - started;
  latencies.sort();
  assert.deepEqual(totals(store), initialTotals, 'Cash and shares must be conserved');
  for (const book of store.orderBooks.values()) {
    if (book instanceof PriceTreeOrderBook) book.assertValid((id) => store.orders.get(id));
  }
  return {
    elapsedMs,
    opsPerSecond: (samples * 1000) / elapsedMs,
    latencyUs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.at(-1),
    },
    before,
    after: bookShape(store),
    trades: store.trades.size,
    inputDigest: digest(JSON.stringify(stream)),
    stateDigest: digest(JSON.stringify(economicState(store))),
  };
}
function options() {
  const result = {
    sizes: [100, 1000, 4000],
    samples: 2040,
    warmup: 680,
    rounds: 3,
    output: '.deliverables/matching-ab.json',
  };
  for (const argument of process.argv.slice(2)) {
    const match = /^--(sizes|samples|warmup|rounds|output)=(.+)$/.exec(argument);
    if (!match)
      throw new Error(
        'Use --sizes=100,1000,4000 --samples=2040 --warmup=680 --rounds=3 --output=path',
      );
    const [, name, value] = match;
    result[name] =
      name === 'output' ? value : name === 'sizes' ? value.split(',').map(Number) : Number(value);
  }
  for (const depth of result.sizes)
    assert(Number.isSafeInteger(depth) && depth >= 32 && depth <= 20000, 'Depth must be 32..20000');
  assert(
    result.sizes.length >= 1 &&
      result.sizes.length <= 6 &&
      new Set(result.sizes).size === result.sizes.length,
  );
  for (const name of ['samples', 'warmup'])
    assert(
      Number.isSafeInteger(result[name]) && result[name] >= 34 && result[name] <= 10000,
      name + ' must be 34..10000',
    );
  assert(Number.isSafeInteger(result.rounds) && result.rounds >= 1 && result.rounds <= 10);
  return result;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
async function main() {
  const config = options();
  const sourcePaths = [
    'scripts/benchmark-matching.mjs',
    'apps/server/src/services/trading.service.ts',
    'apps/server/src/legacy/trading-array.service.ts',
    'apps/server/src/matching/avl-price-tree.ts',
    'apps/server/src/matching/price-tree-book.ts',
    'apps/server/src/matching/order-book.ts',
    'apps/server/src/matching/settlement.ts',
    'apps/server/src/matching/checked.ts',
    'apps/server/src/store/memory-store.ts',
  ];
  const sources = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [path, digest(await readFile(resolve(root, path)))]),
    ),
  );
  const { stdout: revision } = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  const startedAt = new Date().toISOString();
  const runs = [];
  for (const scenario of scenarios) {
    for (const depth of config.sizes) {
      for (let round = 1; round <= config.rounds; round++) {
        const pair = [];
        const engines = round % 2 === 1 ? ['array', 'price-tree'] : ['price-tree', 'array'];
        for (const engine of engines) {
          const { stdout } = await execute(
            process.execPath,
            [
              '--expose-gc',
              script,
              '--worker',
              JSON.stringify({ ...config, engine, scenario, depth }),
            ],
            { cwd: root, maxBuffer: 2 * 1024 * 1024, timeout: 600000 },
          );
          const run = { scenario, depth, round, engine, ...JSON.parse(stdout) };
          runs.push(run);
          pair.push(run);
          process.stdout.write(
            `${scenario} depth=${depth} round=${round} ${engine}: ${run.opsPerSecond.toFixed(0)} ops/s, p99=${run.latencyUs.p99.toFixed(1)} us\n`,
          );
        }
        assert.equal(pair[0].inputDigest, pair[1].inputDigest, 'A/B inputs differ');
        assert.equal(pair[0].stateDigest, pair[1].stateDigest, 'A/B economic states differ');
      }
    }
  }
  const summary = scenarios.flatMap((scenario) =>
    config.sizes.map((depth) => {
      const arms = Object.fromEntries(
        ['array', 'price-tree'].map((engine) => {
          const group = runs.filter(
            (r) => r.scenario === scenario && r.depth === depth && r.engine === engine,
          );
          return [
            engine,
            {
              opsPerSecond: median(group.map((r) => r.opsPerSecond)),
              p50Us: median(group.map((r) => r.latencyUs.p50)),
              p95Us: median(group.map((r) => r.latencyUs.p95)),
              p99Us: median(group.map((r) => r.latencyUs.p99)),
            },
          ];
        }),
      );
      return {
        scenario,
        depth,
        ...arms,
        throughputRatio: arms['price-tree'].opsPerSecond / arms.array.opsPerSecond,
      };
    }),
  );
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      node: process.version,
      v8: process.versions.v8,
    },
    baseRevision: revision.trim(),
    sourceSha256: sources,
    config,
    method:
      'Fresh sequential child per arm/run; alternate AB/BA; independent warmup store; GC before setup and timing, natural GC during timing; public submitOrder including settlement, excluding HTTP/WS; 100 buyers + 100 sellers; increased identical order caps; summary is median of per-run metrics, ratio of median throughputs.',
    matchingStateDigests: true,
    summary,
    runs,
  };
  const output = resolve(root, config.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('All A/B input and state digests match. Report: ' + output + '\n');
}
if (process.argv[2] === '--worker') {
  process.stdout.write(JSON.stringify(worker(JSON.parse(process.argv[3]))));
} else {
  await main();
}
