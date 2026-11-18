import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

const FIXED_TIME = Date.parse('2026-11-18T10:00:00+08:00');

async function fixture(name, account) {
  const home = await fs.mkdtemp(join(tmpdir(), 'dsh-token-billing-'));
  process.env.DSH_HOME = home;
  const { apply } = await import(`../index.js?test=${name}-${Math.random()}`);
  let handler;
  apply({
    effect: register => register(),
    webServer: { register: route => { handler = route.handler; } },
    get: service => service === 'deepseekAccount' ? account : undefined
  });
  return {
    home,
    async summary() {
      let status;
      let body;
      await handler(
        { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' } },
        { writeHead: code => { status = code; }, end: json => { body = JSON.parse(json); } }
      );
      assert.equal(status, 200);
      return body;
    }
  };
}

function accountWithBalance(getBalance) {
  return {
    getState: async () => ({ status: 'credential-stored' }),
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: getBalance() }] })
  };
}

function usageEvent(time, input, output) {
  return JSON.stringify({
    type: 'assistant/message',
    time,
    data: { usage: { inputTokens: input, outputTokens: output } }
  });
}

test('host summary regression cases', async t => {
  const originalNow = Date.now;
  const originalHome = process.env.DSH_HOME;
  let now = FIXED_TIME;
  Date.now = () => now;
  try {
    await t.test('missing priced cost uses observed balance change', async () => {
      let balance = 100;
      const app = await fixture('cost', accountWithBalance(() => balance));
      try {
        const day = '2026-11-18';
        const path = join(app.home, 'storages', 'cost-meter');
        await fs.mkdir(path, { recursive: true });
        await fs.writeFile(join(path, 'ledger.json'), JSON.stringify({
          config: { currency: 'CNY' }, days: { [day]: { input: 12, output: 3 } }
        }));
        const first = await app.summary();
        assert.equal(first.cost.source, 'balance');
        assert.equal(first.cost.cost, 0);
        now += 31_000;
        balance = 95;
        const second = await app.summary();
        assert.equal(second.cost.source, 'balance');
        assert.equal(second.cost.cost, 5);
      } finally {
        await fs.rm(app.home, { recursive: true, force: true });
      }
    });

    await t.test('plain JSONL append and unfinished line are counted once', async () => {
      now = FIXED_TIME;
      const app = await fixture('plain', accountWithBalance(() => 100));
      try {
        const dir = join(app.home, 'sessions', 'one');
        await fs.mkdir(dir, { recursive: true });
        const path = join(dir, 'session.v1.jsonl');
        await fs.writeFile(path, usageEvent(now, 3, 2) + '\n');
        assert.equal((await app.summary()).tokens.total, 5);
        const secondLine = usageEvent(now, 4, 1);
        now += 31_000;
        await fs.appendFile(path, secondLine.slice(0, 40));
        assert.equal((await app.summary()).tokens.total, 5);
        now += 31_000;
        await fs.appendFile(path, secondLine.slice(40) + '\n');
        const result = await app.summary();
        assert.equal(result.tokens.total, 10);
        assert.equal(result.tokens.calls, 2);
        now += 31_000;
        assert.equal((await app.summary()).tokens.total, 10);
      } finally {
        await fs.rm(app.home, { recursive: true, force: true });
      }
    });

    await t.test('appended zstd frames are counted once', {
      skip: typeof zlib.zstdCompressSync !== 'function' ? 'Node lacks built-in zstd' : false
    }, async () => {
      now = FIXED_TIME;
      const app = await fixture('zstd', accountWithBalance(() => 100));
      try {
        const dir = join(app.home, 'sessions', 'two');
        await fs.mkdir(dir, { recursive: true });
        const path = join(dir, 'session.v1.jsonl.zstd');
        await fs.writeFile(path, zlib.zstdCompressSync(Buffer.from(usageEvent(now, 2, 1) + '\n')));
        assert.equal((await app.summary()).tokens.total, 3);
        now += 31_000;
        await fs.appendFile(path, zlib.zstdCompressSync(Buffer.from(usageEvent(now, 5, 2) + '\n')));
        const result = await app.summary();
        assert.equal(result.tokens.total, 10);
        assert.equal(result.tokens.calls, 2);
        now += 31_000;
        assert.equal((await app.summary()).tokens.total, 10);
      } finally {
        await fs.rm(app.home, { recursive: true, force: true });
      }
    });

    await t.test('account state timeout does not block balance', async () => {
      now = FIXED_TIME;
      const app = await fixture('timeout', {
        getState: () => new Promise(() => {}),
        getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: 42 }] })
      });
      try {
        const started = originalNow();
        const result = await app.summary();
        assert.equal(result.balance.total, 42);
        assert.ok(originalNow() - started < 4_500);
      } finally {
        await fs.rm(app.home, { recursive: true, force: true });
      }
    });

    await t.test('Node without zstd keeps balance and marks tokens unavailable', {
      skip: typeof zlib.zstdDecompressSync === 'function' ? 'Built-in zstd is available' : false
    }, async () => {
      now = FIXED_TIME;
      const app = await fixture('old-node', accountWithBalance(() => 42));
      try {
        const dir = join(app.home, 'sessions', 'three');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, 'session.v1.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
        const result = await app.summary();
        assert.equal(result.balance.total, 42);
        assert.equal(result.tokens, null);
        assert.ok(result.errors.includes('tokens'));
      } finally {
        await fs.rm(app.home, { recursive: true, force: true });
      }
    });
  } finally {
    Date.now = originalNow;
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
  }
});
