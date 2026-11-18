/**
 * Host half of the token-billing bundle.
 *
 * The host owns the reads that a browser cannot make reliably by itself:
 *
 *   - the DeepSeek account wallet through the optional `deepseekAccount`
 *     service (the same service Settings → Account uses);
 *   - a small balance-delta ledger in $DSH_HOME/storages/token-billing so
 *     today's spend survives page reloads and has a local history;
 *   - today's token usage, folded from the committed session logs;
 *   - an optional cost-meter ledger snapshot when that plugin is installed
 *     but disabled (read-only, and only used to fill gaps).
 *
 * One same-origin GET route hands all of this to `client.js`. The route is
 * loopback-only and contains no credentials or provider keys.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

export const inject = ['webServer'];

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const ZSTD_MAGIC = 0xfd2fb528;
const LEDGER_VERSION = 1;
const ROUTE = '/api/token-billing/summary';
const SNAPSHOT_TTL_MS = 12000;
const TOKEN_TTL_MS = 30000;
const COST_LEDGER_TTL_MS = 30000;

let snapshotCache = null;
let snapshotInflight = null;
let tokenCache = null;
let tokenInflight = null;
let costLedgerCache = null;
let costLedgerInflight = null;
let warned = false;

function warnOnce(message, error) {
  if (warned) return;
  warned = true;
  try {
    console.warn('[token-billing] ' + message, error && error.message ? error.message : error || '');
  } catch {
    /* logging must never break the route */
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function dayKey(time = Date.now()) {
  return DAY_FMT.format(new Date(time));
}

function startOfDay(day) {
  return Date.parse(day + 'T00:00:00+08:00');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round8(value) {
  return Math.round(value * 1e8) / 1e8;
}

function withTimeout(promise, ms) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, value: null });
    }, ms);
    Promise.resolve(promise).then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value: null, error });
      }
    );
  });
}

/* ------------------------------------------------------------------------- */
/* Wallet                                                                    */
/* ------------------------------------------------------------------------- */

function parseWallets(value) {
  if (!value || value.status !== 'ready') return null;
  const normal = Array.isArray(value.value) ? value.value : [];
  const bonus = Array.isArray(value.bonusWallets) ? value.bonusWallets : [];
  const normalWallets = normal
    .map(wallet => ({
      currency: String((wallet && wallet.currency) || 'CNY').toUpperCase(),
      balance: Number(wallet && wallet.balance)
    }))
    .filter(wallet => Number.isFinite(wallet.balance));
  const bonusWallets = bonus
    .map(wallet => ({
      currency: String((wallet && wallet.currency) || 'CNY').toUpperCase(),
      balance: Number(wallet && wallet.balance)
    }))
    .filter(wallet => Number.isFinite(wallet.balance));
  const wallets = normalWallets.concat(bonusWallets);
  if (wallets.length === 0) return null;
  const preferred =
    wallets.find(wallet => wallet.currency === 'CNY' && wallet.balance > 0) ||
    wallets.find(wallet => wallet.balance > 0) ||
    wallets.find(wallet => wallet.currency === 'CNY') ||
    wallets[0];
  const currency = preferred.currency;
  const sum = list =>
    list
      .filter(wallet => wallet.currency === currency)
      .reduce((total, wallet) => total + wallet.balance, 0);
  const recharge = sum(normalWallets);
  const bonusTotal = sum(bonusWallets);
  return {
    currency,
    total: round8(recharge + bonusTotal),
    recharge: round8(recharge),
    bonus: round8(bonusTotal),
    stale: false,
    source: 'account',
    observedAt: Date.now()
  };
}

function parseCachedBalance(ref) {
  if (!ref || !Number.isFinite(Number(ref.total))) return null;
  return {
    currency: String(ref.currency || 'CNY').toUpperCase(),
    total: round8(Number(ref.total)),
    recharge: Number.isFinite(Number(ref.topped)) ? round8(Number(ref.topped)) : null,
    bonus: Number.isFinite(Number(ref.granted)) ? round8(Number(ref.granted)) : null,
    stale: true,
    source: 'ledger-cache',
    observedAt: Number(ref.at) || null,
    date: typeof ref.date === 'string' ? ref.date : null
  };
}

async function readAccount(ctx) {
  const account = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!account) return { state: null, balance: null };
  let state = null;
  try {
    state = await account.getState();
  } catch {
    state = null;
  }
  let balance = null;
  try {
    const metadata = {
      version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '0.2.2-rc.1'),
      locale: String(process.env.DSH_LOCALE || 'zh_CN'),
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
    };
    const result = await withTimeout(account.getBalance(metadata), 9000);
    if (!result.timedOut && result.value && result.value.status === 'ready') {
      balance = parseWallets(result.value);
    }
  } catch (error) {
    warnOnce('account balance failed', error);
  }
  return { state, balance };
}

/* ------------------------------------------------------------------------- */
/* Own balance-delta ledger                                                  */
/* ------------------------------------------------------------------------- */

function ledgerPath() {
  return join(dshHome(), 'storages', 'token-billing', 'ledger.json');
}

async function readOwnLedger() {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath(), 'utf8'));
    if (parsed && parsed.version === LEDGER_VERSION && parsed.books && typeof parsed.books === 'object') {
      return parsed;
    }
  } catch {
    /* first run or an unreadable store */
  }
  return { version: LEDGER_VERSION, books: {} };
}

async function writeOwnLedger(ledger) {
  const path = ledgerPath();
  const dir = join(path, '..');
  await fs.mkdir(dir, { recursive: true });
  const temp = path + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temp, JSON.stringify(ledger), 'utf8');
  await fs.rename(temp, path);
}

function previousDayKey(book, day) {
  const keys = Object.keys(book.days || {}).filter(key => key < day).sort();
  return keys.length > 0 ? keys[keys.length - 1] : null;
}

async function observeBalance(balance, previousHint = null) {
  if (!balance || balance.stale || !Number.isFinite(Number(balance.total))) return null;
  const now = Date.now();
  const day = dayKey(now);
  const currency = String(balance.currency || 'CNY').toUpperCase();
  const ledger = await readOwnLedger();
  const book = ledger.books[currency] || (ledger.books[currency] = { currency, days: {} });
  let row = book.days[day];
  if (!row) {
    const midnight = startOfDay(day);
    const previous = previousDayKey(book, day);
    const previousRow = previous ? book.days[previous] : null;
    let opening = Number(balance.total);
    let partial = true;
    let seededFrom = null;
    if (previousRow && Number.isFinite(Number(previousRow.lastAt))) {
      const gap = Math.abs(midnight - Number(previousRow.lastAt));
      if (gap <= 10 * 60 * 1000) {
        opening = Number(previousRow.last);
        partial = false;
      }
    }
    if (partial && previousHint && previousHint.date === dayKey(midnight - 86400000) &&
        previousHint.currency === currency && Number.isFinite(Number(previousHint.total))) {
      opening = Number(previousHint.total);
      seededFrom = previousHint.date;
    }
    row = {
      day,
      firstAt: now,
      lastAt: now,
      opening: round8(opening),
      last: round8(Number(balance.total)),
      spent: 0,
      partial,
      seededFrom
    };
    const delta = opening - Number(balance.total);
    if (delta > 0) row.spent = round8(delta);
  } else {
    const previous = Number(row.last);
    const current = Number(balance.total);
    const spentBefore = Number(row.spent) || 0;
    if (Number.isFinite(previous) && Number.isFinite(current)) {
      const delta = previous - current;
      if (delta > 0) row.spent = round8(spentBefore + delta);
    }
    if (!row.seededFrom && spentBefore === 0 && previousHint &&
        previousHint.date === dayKey(startOfDay(day) - 86400000) &&
        previousHint.currency === currency && Number.isFinite(Number(previousHint.total))) {
      const seededDelta = Number(previousHint.total) - current;
      if (seededDelta > 0 && seededDelta > spentBefore) {
        row.opening = round8(Number(previousHint.total));
        row.spent = round8(seededDelta);
        row.seededFrom = previousHint.date;
        row.partial = true;
      }
    }
    row.last = round8(Number(balance.total));
    row.lastAt = now;
  }
  book.days[day] = row;
  const keys = Object.keys(book.days).sort();
  while (keys.length > 90) delete book.days[keys.shift()];
  await writeOwnLedger(ledger);
  return { row, book, ledger };
}

function historyOfBook(book) {
  return Object.keys(book.days || {})
    .sort()
    .reverse()
    .slice(0, 90)
    .map(key => ({ date: key, cost: Number(book.days[key].spent) || 0 }));
}

/* ------------------------------------------------------------------------- */
/* Optional cost-meter ledger (read-only fallback)                           */
/* ------------------------------------------------------------------------- */

async function readCostLedger() {
  if (costLedgerCache && Date.now() - costLedgerCache.at < COST_LEDGER_TTL_MS) {
    return costLedgerCache.value;
  }
  if (costLedgerInflight) return costLedgerInflight;
  costLedgerInflight = (async () => {
    try {
      const path = join(dshHome(), 'storages', 'cost-meter', 'ledger.json');
      const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
      const value = parsed && parsed.days ? parsed : null;
      costLedgerCache = { at: Date.now(), value };
      return value;
    } catch {
      costLedgerCache = { at: Date.now(), value: null };
      return null;
    } finally {
      costLedgerInflight = null;
    }
  })();
  return costLedgerInflight;
}

function pickCost(entry, config) {
  if (!entry) return null;
  const currency = String((config && config.currency) || 'CNY').toUpperCase();
  const rate = Number(config && config.exchangeRate) || 1;
  let value = null;
  if (currency === 'CNY') value = entry.costCny ?? entry.apiCostCny ?? null;
  else if (currency === 'EUR') value = entry.costEur ?? entry.apiCostEur ?? null;
  if (value === null || value === undefined) {
    if (entry.cost !== null && entry.cost !== undefined) {
      if (currency === 'CNY') value = Number(entry.cost) * rate;
      else if (currency === 'EUR') value = Number(entry.cost) * (Number(config && config.fxRates && config.fxRates.EUR) || 1);
      else value = entry.cost;
    }
  }
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function costLedgerView(ledger, day) {
  if (!ledger) return null;
  const config = ledger.config || {};
  const currency = String(config.currency || 'CNY').toUpperCase();
  const row = ledger.days && ledger.days[day];
  const history = Object.keys(ledger.days || {})
    .sort()
    .reverse()
    .slice(0, 90)
    .map(key => ({ date: key, cost: pickCost(ledger.days[key], config) }))
    .filter(entry => entry.cost !== null);
  return {
    currency,
    todayCost: row ? pickCost(row, config) : null,
    todayTokens: row
      ? num(row.input) + num(row.output) + num(row.cacheRead) + num(row.cacheWrite) + num(row.reasoning)
      : null,
    todayInput: row ? num(row.input) : 0,
    todayCache: row ? num(row.cacheRead) + num(row.cacheWrite) : 0,
    todayOutput: row ? num(row.output) + num(row.reasoning) : 0,
    calls: row ? num(row.calls) : 0,
    history,
    balance: parseCachedBalance(ledger.balanceRef)
  };
}

/* ------------------------------------------------------------------------- */
/* Session-log token fold                                                    */
/* ------------------------------------------------------------------------- */

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let complete = false;
    while (buffer.length - offset >= 3) {
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break;
      const blockBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < blockBytes) break;
      offset += blockBytes;
      if (lastBlock) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

async function readSessionText(path) {
  if (path.endsWith('.jsonl.zstd')) {
    const buffer = await fs.readFile(path);
    const frames = scanZstdFrames(buffer);
    if (frames.length === 0) return '';
    const parts = [];
    for (const frame of frames) {
      try {
        parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
      } catch {
        /* a torn final frame is expected while a session is being written */
      }
    }
    return Buffer.concat(parts).toString('utf8');
  }
  if (path.endsWith('.jsonl')) return fs.readFile(path, 'utf8');
  return '';
}

async function walkSessionFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSessionFiles(path, out);
    } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd'))) {
      out.push(path);
    }
  }
  return out;
}

async function scanTokens(day) {
  const now = Date.now();
  if (tokenCache && tokenCache.day === day && now - tokenCache.at < TOKEN_TTL_MS) {
    return tokenCache.value;
  }
  if (tokenInflight) return tokenInflight;
  tokenInflight = (async () => {
    const start = startOfDay(day);
    const cutoff = start - 2 * 60 * 60 * 1000;
    const root = join(dshHome(), 'sessions');
    const files = await walkSessionFiles(root);
    const totals = { input: 0, cache: 0, output: 0, reasoning: 0, calls: 0 };
    for (const path of files) {
      let stat;
      try {
        stat = await fs.stat(path);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      let text;
      try {
        text = await readSessionText(path);
      } catch {
        continue;
      }
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line || line.indexOf('"assistant/message"') < 0) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!event || event.type !== 'assistant/message') continue;
        const time = Number(event.time) || stat.mtimeMs;
        if (time < start) continue;
        const usage = event.data && event.data.usage;
        if (!usage) continue;
        totals.input += num(usage.inputTokens);
        totals.cache += num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
        totals.output += num(usage.outputTokens);
        totals.reasoning += num(usage.reasoningTokens);
        totals.calls += 1;
      }
    }
    const value = {
      total: totals.input + totals.cache + totals.output + totals.reasoning,
      input: totals.input,
      cache: totals.cache,
      output: totals.output + totals.reasoning,
      calls: totals.calls
    };
    tokenCache = { at: Date.now(), day, value };
    return value;
  })().finally(() => {
    tokenInflight = null;
  });
  return tokenInflight;
}

/* ------------------------------------------------------------------------- */
/* Snapshot                                                                  */
/* ------------------------------------------------------------------------- */

async function buildSnapshot(ctx) {
  const now = Date.now();
  const day = dayKey(now);
  const accountTask = readAccount(ctx);
  const tokenTask = withTimeout(scanTokens(day), 7000);
  const [account, tokenResult] = await Promise.all([accountTask, tokenTask]);
  const costLedger = await readCostLedger();
  const costView = costLedgerView(costLedger, day);
  let ownLedger = null;
  try {
    ownLedger = await readOwnLedger();
  } catch {
    ownLedger = null;
  }

  const preferredCurrency = (account.balance && account.balance.currency) ||
    (costView && costView.currency) ||
    'CNY';
  const ownBook = ownLedger && ownLedger.books ? ownLedger.books[preferredCurrency] : null;
  const ownRow = ownBook && ownBook.days ? ownBook.days[day] : null;

  let balance = account.balance;
  let usedOwnBalance = false;
  if ((!balance || balance.stale) && ownRow && Number.isFinite(Number(ownRow.last))) {
    balance = {
      currency: preferredCurrency,
      total: round8(Number(ownRow.last)),
      recharge: null,
      bonus: null,
      stale: true,
      source: 'own-ledger',
      observedAt: Number(ownRow.lastAt) || null
    };
    usedOwnBalance = true;
  }
  if (!usedOwnBalance && (!balance || balance.stale) && costView && costView.balance) {
    balance = { ...costView.balance, stale: true };
    if (!balance.observedAt && costLedger && costLedger.balanceRef) {
      balance.observedAt = Number(costLedger.balanceRef.at) || null;
    }
  }

  let observation = null;
  if (balance && !balance.stale) {
    const previousDay = dayKey(startOfDay(day) - 86400000);
    const hint = costLedger && costLedger.balanceRef && costLedger.balanceRef.date === previousDay
      ? {
          date: previousDay,
          currency: String(costLedger.balanceRef.currency || 'CNY').toUpperCase(),
          total: Number(costLedger.balanceRef.total)
        }
      : null;
    try {
      observation = await observeBalance(balance, hint);
    } catch (error) {
      warnOnce('balance observation failed', error);
    }
  }

  const ledgerRow = (observation && observation.row) || ownRow;
  const ledgerBook = (observation && observation.book) || ownBook;
  const exactCost = Boolean(costView && costView.todayCost !== null);
  const currency = (exactCost ? costView.currency : balance && balance.currency) ||
    (costView && costView.currency) ||
    'CNY';
  const history = exactCost
    ? costView.history
    : ledgerBook
      ? historyOfBook(ledgerBook)
      : costView && costView.history
        ? costView.history
        : [];
  const todayCost = exactCost
    ? costView.todayCost
    : ledgerRow
      ? Number(ledgerRow.spent) || 0
      : null;
  const tokens = tokenResult && !tokenResult.timedOut && tokenResult.value
    ? tokenResult.value
    : costView && costView.todayTokens !== null
      ? {
          total: costView.todayTokens,
          input: costView.todayInput,
          cache: costView.todayCache,
          output: costView.todayOutput,
          calls: costView.calls
        }
      : null;

  const state = account.state;
  const links = (state && state.links) || null;
  const signedIn = Boolean(state && state.status === 'credential-stored');
  const errors = [];
  if (!balance) errors.push('balance');
  if (!tokens) errors.push('tokens');
  if (todayCost === null) errors.push('cost');

  return {
    ok: true,
    fetchedAt: now,
    day,
    account: { signedIn, links },
    balance,
    cost: todayCost === null
      ? null
      : {
          currency,
          cost: todayCost,
          partial: exactCost ? false : ledgerRow ? Boolean(ledgerRow.partial) : true,
          observedFrom: ledgerRow ? ledgerRow.firstAt : null,
          seededFrom: ledgerRow ? ledgerRow.seededFrom || null : null,
          source: exactCost ? 'cost-ledger' : 'balance',
          todayKey: day,
          history
        },
    tokens,
    errors
  };
}

async function summary(ctx) {
  if (snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return snapshotCache.value;
  }
  if (snapshotInflight) return snapshotInflight;
  snapshotInflight = (async () => {
    try {
      const value = await buildSnapshot(ctx);
      snapshotCache = { at: Date.now(), value };
      return value;
    } finally {
      snapshotInflight = null;
    }
  })();
  return snapshotInflight;
}

/* ------------------------------------------------------------------------- */
/* Route                                                                     */
/* ------------------------------------------------------------------------- */

function isLoopbackPeer(req) {
  const address = String((req.socket && req.socket.remoteAddress) || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function isAllowedHost(req) {
  const host = String((req.headers && req.headers.host) || '');
  if (!host) return true;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  const lower = name.toLowerCase();
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(value));
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          if (!isLoopbackPeer(req) || !isAllowedHost(req)) {
            sendJson(res, 403, { ok: false, error: 'loopback only' });
            return;
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          try {
            const value = await summary(ctx);
            sendJson(res, 200, value);
          } catch (error) {
            warnOnce('summary failed', error);
            sendJson(res, 500, { ok: false, error: 'summary failed' });
          }
        }
      }),
    'token-billing: summary route'
  );
}
