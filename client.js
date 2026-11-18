/**
 * Browser half of the token-billing bundle.
 *
 * The control is a normal header utility: it occupies the space immediately
 * left of the right-sidebar expand button and opens a portaled popover so the
 * conversation header can never clip it.
 *
 * Reads:
 *   - account.getBalance / account.getState from the account Remote for the
 *     live wallet and the Platform links;
 *   - the optional cost-meter Remote (`getState` / `getStateSince`) for the
 *     priced local ledger, token mix and seven-day history;
 *   - when cost-meter is absent, a local balance-delta ledger in localStorage
 *     so the control still reports something useful.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-billing',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const NS = 'token-billing';
    const STYLE_ID = 'dsh-token-billing-style';
    const LEDGER_KEY = 'dsh-token-billing.ledger.v1';
    const PANEL_WIDTH = 356;
    const CACHE_MS = 45000;
    const POLL_MS = 90000;
    const VERSION = (() => {
      try {
        return globalThis.__DSH_BOOT__ && globalThis.__DSH_BOOT__.version
          ? String(globalThis.__DSH_BOOT__.version)
          : '0.2.2-rc.1';
      } catch {
        return '0.2.2-rc.1';
      }
    })();
    const DEFAULT_LINKS = {
      usageUrl: 'https://platform.deepseek.com/usage',
      topUpUrl: 'https://platform.deepseek.com/top_up'
    };

    /* --------------------------------------------------------------------- */
    /* Locale                                                                */
    /* --------------------------------------------------------------------- */

    const zh = {
      'pill.aria': '查看用量与计费',
      'pill.title': '今日消费',
      'pill.balanceTitle': '账户余额',
      'panel.title': '用量与计费',
      'panel.subtitle': 'DeepSeek 账户',
      'panel.signedOut': '未登录 DeepSeek 账号',
      'today': '今日消费',
      'balance': '账户余额',
      'balanceCachedSub': '余额为上次观测值',
      'recharge': '充值',
      'bonus': '赠金',
      'tokens': '今日 Token',
      'calls': '{count} 次调用',
      'noCalls': '今日暂无调用',
      'cacheHit': '缓存命中 {percent}%',
      'week': '近 7 天',
      'weekTotal': '合计 {amount}',
      'noHistory': '近 7 天暂无消费',
      'updated': '{time} 更新',
      'source.ledger': 'DSH 账本',
      'source.balance': '余额变动估算',
      'refresh': '刷新数据',
      'usage': '用量详情',
      'topUp': '去充值',
      'loading': '正在读取…',
      'error.all': '暂时无法读取用量与余额',
      'error.balance': '余额读取失败',
      'error.cost': '今日消费统计暂不可用',
      'error.signedOut': '登录后可查看账户余额',
      'hint.signIn': '请在 设置 → 账号 中登录',
      'hint.partial': '自 {time} 起观测',
      'hint.costFallback': '未找到计费账本，显示余额变动估算',
      'hint.balanceEstimate': '按账户余额变动估算',
      'hint.seeded': '以 {date} 的余额为起点估算',
      'hint.balanceStale': '余额为 {time} 的缓存',
      'hint.tokensUnavailable': '暂时无法读取 Token 用量',
      'input': '输入',
      'cache': '缓存',
      'output': '输出',
      'retry': '重试',
      'close': '关闭'
    };

    const en = {
      'pill.aria': 'View usage and billing',
      'pill.title': "Today's spend",
      'pill.balanceTitle': 'Account balance',
      'panel.title': 'Usage & billing',
      'panel.subtitle': 'DeepSeek account',
      'panel.signedOut': 'Not signed in to DeepSeek',
      'today': "Today's spend",
      'balance': 'Account balance',
      'balanceCachedSub': 'Last observed balance',
      'recharge': 'Recharge',
      'bonus': 'Bonus',
      'tokens': "Today's tokens",
      'calls': '{count} calls',
      'noCalls': 'No calls today',
      'cacheHit': 'Cache hit {percent}%',
      'week': 'Last 7 days',
      'weekTotal': 'Total {amount}',
      'noHistory': 'No spend in the last 7 days',
      'updated': 'Updated {time}',
      'source.ledger': 'DSH ledger',
      'source.balance': 'Observed balance change',
      'refresh': 'Refresh data',
      'usage': 'Usage details',
      'topUp': 'Top up',
      'loading': 'Reading…',
      'error.all': 'Usage and balance are unavailable',
      'error.balance': 'Could not read balance',
      'error.cost': "Today's spend is unavailable",
      'error.signedOut': 'Sign in to see the account balance',
      'hint.signIn': 'Sign in from Settings → Account',
      'hint.partial': 'Observed since {time}',
      'hint.costFallback': 'No cost ledger found; showing the observed balance change',
      'hint.balanceEstimate': 'Estimated from account balance changes',
      'hint.seeded': 'Estimated from the {date} balance',
      'hint.balanceStale': 'Balance cached at {time}',
      'hint.tokensUnavailable': 'Token usage is unavailable',
      'input': 'Input',
      'cache': 'Cache',
      'output': 'Output',
      'retry': 'Retry',
      'close': 'Close'
    };

    /* --------------------------------------------------------------------- */
    /* Small utilities                                                       */
    /* --------------------------------------------------------------------- */

    const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    function shanghaiDay(time = Date.now()) {
      return DAY_FMT.format(new Date(time));
    }

    function num(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }

    function round8(value) {
      return Math.round(value * 1e8) / 1e8;
    }

    function moneySymbol(currency) {
      const code = String(currency || 'CNY').toUpperCase();
      if (code === 'CNY') return '¥';
      if (code === 'USD') return '$';
      if (code === 'EUR') return '€';
      return code + ' ';
    }

    function truncateMoney(value) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return null;
      /* Truncate at two decimals instead of rounding. The tiny tolerance keeps
         binary representations such as 1.999999999 from becoming 1.99. */
      const adjusted = amount + (amount < 0 ? -1e-9 : 1e-9);
      return Math.trunc(adjusted * 100) / 100;
    }

    function formatMoney(value, currency) {
      if (value === null || value === undefined) return '—';
      const amount = truncateMoney(value);
      if (amount === null) return '—';
      return (
        moneySymbol(currency) +
        new Intl.NumberFormat(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(amount)
      );
    }

    function formatTokens(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
      const n = Number(value);
      if (n === 0) return '0';
      const compact = (divisor, suffix) => {
        const text = (n / divisor).toFixed(1);
        return (text.endsWith('.0') ? text.slice(0, -2) : text) + suffix;
      };
      if (n >= 1e9) return compact(1e9, 'B');
      if (n >= 1e6) return compact(1e6, 'M');
      if (n >= 1e3) return compact(1e3, 'K');
      return String(Math.round(n));
    }

    function formatCount(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
      return new Intl.NumberFormat(undefined).format(Number(value));
    }

    function formatTime(value) {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch {
        return '—';
      }
    }

    function formatDateTime(value) {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleString(undefined, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch {
        return '—';
      }
    }

    function dayLabel(key) {
      const parts = String(key || '').slice(5).split('-');
      if (parts.length !== 2) return key;
      return Number(parts[0]) + '/' + Number(parts[1]);
    }

    function safeGet(ctx, name) {
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
      } catch {
        return undefined;
      }
    }

    async function callRemote(fn) {
      try {
        return await fn();
      } catch (error) {
        return {
          ok: false,
          error: { message: String((error && error.message) || error || 'remote call failed') }
        };
      }
    }

    function withTimeout(promise, ms) {
      return new Promise(resolve => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: { message: 'timeout' } });
        }, ms);
        promise.then(
          value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, error: { message: String((error && error.message) || error) } });
          }
        );
      });
    }

    function accountMeta(ctx) {
      let locale = 'zh-CN';
      try {
        locale = ctx.locale.getSnapshot().active || locale;
      } catch {
        /* keep the fallback */
      }
      return {
        version: VERSION,
        locale,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
      };
    }

    /* --------------------------------------------------------------------- */
    /* Local balance-delta ledger (fallback when cost-meter is absent)       */
    /* --------------------------------------------------------------------- */

    function readLedger() {
      try {
        const raw = localStorage.getItem(LEDGER_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.version === 1 && parsed.books && typeof parsed.books === 'object') {
            return parsed;
          }
        }
      } catch {
        /* storage can be disabled; keep the in-memory fallback */
      }
      return { version: 1, books: {} };
    }

    function writeLedger(ledger) {
      try {
        localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
      } catch {
        /* a read-only store must not break the panel */
      }
    }

    function observeBalance(balance) {
      if (!balance || !Number.isFinite(Number(balance.total))) return null;
      try {
        const now = Date.now();
        const day = shanghaiDay(now);
        const currency = String(balance.currency || 'CNY').toUpperCase();
        const ledger = readLedger();
        const book = ledger.books[currency] || (ledger.books[currency] = { currency, days: {} });
        let row = book.days[day];
        if (!row) {
          row = {
            day,
            firstAt: now,
            lastAt: now,
            opening: round8(balance.total),
            last: round8(balance.total),
            spent: 0
          };
        } else {
          const previous = Number(row.last);
          const current = Number(balance.total);
          if (Number.isFinite(previous) && Number.isFinite(current)) {
            const delta = previous - current;
            if (delta > 0) row.spent = round8(Number(row.spent || 0) + delta);
          }
          row.last = round8(Number(balance.total));
          row.lastAt = now;
        }
        book.days[day] = row;
        const keys = Object.keys(book.days).sort();
        while (keys.length > 90) delete book.days[keys.shift()];
        const kept = Object.keys(book.days).sort();
        writeLedger(ledger);
        const start = Date.parse(day + 'T00:00:00+08:00');
        const partial = Number.isFinite(row.firstAt) && row.firstAt - start > 10 * 60 * 1000;
        return {
          row,
          partial,
          history: kept
            .slice()
            .reverse()
            .map(key => ({ date: key, cost: Number(book.days[key].spent) || 0 }))
        };
      } catch {
        return null;
      }
    }

    /* --------------------------------------------------------------------- */
    /* Remote snapshot                                                       */
    /* --------------------------------------------------------------------- */

    let snapshotCache = null;
    let pricesRev = null;

    function parseAccountBalance(value) {
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
        bonus: round8(bonusTotal)
      };
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

    function parseCostBalance(balance, fallbackCurrency) {
      if (!balance || balance.status !== 'ok') return null;
      const total = Number(balance.totalBalance);
      if (!Number.isFinite(total)) return null;
      return {
        currency: String(balance.currency || fallbackCurrency || 'CNY').toUpperCase(),
        total: round8(total),
        recharge: Number.isFinite(Number(balance.toppedUpBalance)) ? round8(Number(balance.toppedUpBalance)) : null,
        bonus: Number.isFinite(Number(balance.grantedBalance)) ? round8(Number(balance.grantedBalance)) : null
      };
    }

    function parseCostMeter(state) {
      if (!state || !state.today) return null;
      const config = state.config || {};
      const currency = String(config.currency || 'CNY').toUpperCase();
      const today = state.today;
      const input = num(today.input);
      const cache = num(today.cacheRead) + num(today.cacheWrite);
      const output = num(today.output) + num(today.reasoning);
      const todayKey = String((state.meta && state.meta.dayKey) || shanghaiDay());
      const history = Array.isArray(state.history)
        ? state.history
            .map(entry => ({
              date: String((entry && entry.date) || ''),
              cost: pickCost(entry, config)
            }))
            .filter(entry => entry.date && entry.cost !== null)
        : [];
      const cost = pickCost(today, config);
      if (!history.some(entry => entry.date === todayKey) && cost !== null) {
        history.push({ date: todayKey, cost });
      }
      return {
        currency,
        cost: cost === null ? 0 : cost,
        tokens: input + cache + output,
        input,
        cache,
        output,
        calls: num(today.calls),
        todayKey,
        history,
        balance: parseCostBalance(state.balance, currency)
      };
    }

    async function fetchSummaryRoute() {
      if (typeof fetch !== 'function') return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const url = new URL('api/token-billing/summary', document.baseURI).toString();
        const response = await fetch(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          headers: { accept: 'application/json' }
        });
        if (!response.ok) return null;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.indexOf('application/json') < 0) return null;
        const data = await response.json();
        return data && data.ok === true ? data : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    function snapshotFromRoute(route) {
      const account = route.account || {};
      let balance = null;
      if (route.balance && Number.isFinite(Number(route.balance.total))) {
        balance = {
          currency: String(route.balance.currency || 'CNY').toUpperCase(),
          total: Number(route.balance.total),
          recharge:
            route.balance.recharge === null || route.balance.recharge === undefined
              ? null
              : Number(route.balance.recharge),
          bonus:
            route.balance.bonus === null || route.balance.bonus === undefined
              ? null
              : Number(route.balance.bonus),
          stale: route.balance.stale === true,
          source: route.balance.source || 'account',
          observedAt: route.balance.observedAt || null
        };
      }
      const cost = route.cost || null;
      const tokens = route.tokens || null;
      const todayCurrency = (cost && cost.currency) || (balance && balance.currency) || 'CNY';
      const todayCost = cost && Number.isFinite(Number(cost.cost)) ? Number(cost.cost) : null;
      const todayTokens = tokens && Number.isFinite(Number(tokens.total)) ? Number(tokens.total) : null;
      let error = null;
      if (!balance && !cost) error = 'all';
      else if (!balance) error = 'balance';
      else if (!cost) error = 'cost';
      return {
        fetchedAt: Number(route.fetchedAt) || Date.now(),
        signedIn: account.signedIn === true,
        links: {
          usageUrl: (account.links && account.links.usageUrl) || DEFAULT_LINKS.usageUrl,
          topUpUrl: (account.links && account.links.topUpUrl) || DEFAULT_LINKS.topUpUrl
        },
        balance,
        balanceSource: balance ? balance.source : null,
        balanceStale: Boolean(balance && balance.stale),
        balanceObservedAt: balance ? balance.observedAt : null,
        todayCost,
        todayCurrency,
        todayTokens,
        todayInput: tokens ? num(tokens.input) : 0,
        todayCache: tokens ? num(tokens.cache) : 0,
        todayOutput: tokens ? num(tokens.output) : 0,
        calls: tokens ? num(tokens.calls) : null,
        history: cost && Array.isArray(cost.history) ? cost.history : [],
        todayKey: (cost && cost.todayKey) || route.day || shanghaiDay(),
        source: (cost && cost.source) || 'balance',
        partial: Boolean(cost && cost.partial),
        observedFrom: cost ? cost.observedFrom : null,
        seededFrom: cost ? cost.seededFrom || null : null,
        error
      };
    }

    async function fetchSnapshot(ctx, force) {
      const now = Date.now();
      if (!force && snapshotCache && now - snapshotCache.fetchedAt < CACHE_MS) {
        return snapshotCache;
      }

      const routed = await fetchSummaryRoute();
      if (routed) {
        snapshotCache = snapshotFromRoute(routed);
        return snapshotCache;
      }

      const remote = safeGet(ctx, 'remote');
      const account = remote && remote.account ? remote.account : undefined;
      const costMeter = safeGet(ctx, 'remote.costMeter');
      const meta = accountMeta(ctx);

      const [stateRes, balanceRes, costRes] = await Promise.all([
        account && typeof account.getState === 'function'
          ? withTimeout(callRemote(() => account.getState()), 10000)
          : Promise.resolve(null),
        account && typeof account.getBalance === 'function'
          ? withTimeout(callRemote(() => account.getBalance(meta)), 12000)
          : Promise.resolve(null),
        costMeter && typeof costMeter.getState === 'function'
          ? withTimeout(
              callRemote(async () => {
                let res = null;
                if (pricesRev && typeof costMeter.getStateSince === 'function') {
                  try {
                    res = await costMeter.getStateSince(pricesRev);
                  } catch {
                    res = null;
                  }
                  if (!res || res.ok !== true) {
                    pricesRev = null;
                    res = await costMeter.getState();
                  }
                } else {
                  res = await costMeter.getState();
                }
                if (res && res.ok === true && res.value && typeof res.value.pricesRev === 'string') {
                  pricesRev = res.value.pricesRev;
                }
                return res;
              }),
              8000
            )
          : Promise.resolve(null)
      ]);

      const accountState = stateRes && stateRes.ok ? stateRes.value : null;
      const signedIn = Boolean(accountState && accountState.status === 'credential-stored');
      const links = {
        usageUrl:
          (accountState && accountState.links && accountState.links.usageUrl) || DEFAULT_LINKS.usageUrl,
        topUpUrl:
          (accountState && accountState.links && accountState.links.topUpUrl) || DEFAULT_LINKS.topUpUrl
      };

      const parsedAccountBalance = balanceRes && balanceRes.ok ? parseAccountBalance(balanceRes.value) : null;
      const parsedCost = costRes && costRes.ok ? parseCostMeter(costRes.value) : null;
      const costBalance = parsedCost && parsedCost.balance ? parsedCost.balance : null;
      const balance = parsedAccountBalance || costBalance;

      let todayCost = null;
      let todayCurrency = (balance && balance.currency) || 'CNY';
      let todayTokens = null;
      let todayInput = 0;
      let todayCache = 0;
      let todayOutput = 0;
      let calls = null;
      let history = [];
      let todayKey = shanghaiDay();
      let source = 'ledger';
      let partial = false;
      let observedFrom = null;

      if (parsedCost) {
        todayCost = parsedCost.cost;
        todayCurrency = parsedCost.currency;
        todayTokens = parsedCost.tokens;
        todayInput = parsedCost.input;
        todayCache = parsedCost.cache;
        todayOutput = parsedCost.output;
        calls = parsedCost.calls;
        history = parsedCost.history;
        todayKey = parsedCost.todayKey;
        source = 'ledger';
      } else if (balance) {
        const observed = observeBalance(balance);
        source = 'balance';
        if (observed) {
          todayCost = Number(observed.row.spent) || 0;
          todayCurrency = balance.currency;
          history = observed.history;
          todayKey = observed.row.day;
          partial = observed.partial;
          observedFrom = observed.row.firstAt;
        }
      }

      let error = null;
      if (!parsedCost && !balance) error = 'all';
      else if (!balance) error = 'balance';
      else if (!parsedCost) error = null;

      snapshotCache = {
        fetchedAt: now,
        signedIn,
        links,
        balance,
        balanceSource: parsedAccountBalance ? 'account' : costBalance ? 'cost-meter' : null,
        todayCost,
        todayCurrency,
        todayTokens,
        todayInput,
        todayCache,
        todayOutput,
        calls,
        history,
        todayKey,
        source,
        partial,
        observedFrom,
        error
      };
      return snapshotCache;
    }

    /* --------------------------------------------------------------------- */
    /* Icons                                                                 */
    /* --------------------------------------------------------------------- */

    function IconCoin({ size = 16, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          className,
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('circle', { cx: 8, cy: 8, r: 6.15, fill: '#F2B84B' }),
        h('circle', { cx: 8, cy: 8, r: 6.15, stroke: '#FFE3A3', strokeOpacity: 0.55, strokeWidth: 0.7 }),
        h('path', {
          d: 'M8 4.7v6.6M5.8 6.45 8 9.1l2.2-2.65M5.75 9.95h4.5',
          stroke: '#3B2A10',
          strokeWidth: 1.15,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      );
    }

    function IconWallet({ size = 14, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          className,
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('rect', {
          x: 2.1,
          y: 4.1,
          width: 11.8,
          height: 8.7,
          rx: 2.2,
          stroke: 'currentColor',
          strokeWidth: 1.25
        }),
        h('path', { d: 'M2.4 6.4h11.2', stroke: 'currentColor', strokeWidth: 1.25 }),
        h('circle', { cx: 11.25, cy: 9.55, r: 0.95, fill: 'currentColor' })
      );
    }

    function IconRefresh({ size = 14, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          className,
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.55-3.65M13 3.4v3.3h-3.3',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      );
    }

    function IconArrow({ size = 12, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          className,
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('path', {
          d: 'M5.2 10.8 10.8 5.2M6.5 5.2h4.3v4.3',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      );
    }

    /* --------------------------------------------------------------------- */
    /* Positioning and interaction                                           */
    /* --------------------------------------------------------------------- */

    function panelPosition(button) {
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(PANEL_WIDTH, vw - 24);
      const left = Math.max(12, Math.min(rect.right - width, vw - width - 12));
      let top = rect.bottom + 10;
      let maxHeight = Math.max(220, vh - top - 12);
      if (maxHeight < 260 && rect.top > 300) {
        const height = Math.min(470, rect.top - 22);
        top = rect.top - 10 - height;
        maxHeight = height;
      }
      const origin = Math.max(22, Math.min(width - 22, rect.left + rect.width / 2 - left));
      return { left, top, width, maxHeight, origin };
    }

    function useOutsideClose(open, panelRef, buttonRef, close) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
        };
        const onPointer = event => {
          if (panelRef.current && panelRef.current.contains(event.target)) return;
          if (buttonRef.current && buttonRef.current.contains(event.target)) return;
          close(false);
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onPointer, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('pointerdown', onPointer, true);
        };
      }, [open, panelRef, buttonRef, close]);
    }

    /* --------------------------------------------------------------------- */
    /* Presentational pieces                                                 */
    /* --------------------------------------------------------------------- */

    function Skeleton({ className, style }) {
      return h('span', { className: 'tb-skel ' + (className || ''), style });
    }

    function LiveDot({ state }) {
      return h('span', { className: 'tb-live', 'data-state': state || 'ok', 'aria-hidden': 'true' });
    }

    function Notice({ kind, children, title }) {
      return h(
        'div',
        { className: 'tb-notice', 'data-kind': kind || 'info', title: title || undefined },
        h('span', { className: 'tb-notice-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'tb-notice-text' }, children)
      );
    }

    function Header({ snapshot, refreshing, onRefresh, t }) {
      const state = snapshot
        ? snapshot.error === 'all'
          ? 'error'
          : snapshot.error
            ? 'warn'
            : refreshing
              ? 'busy'
              : 'ok'
        : 'busy';
      const subtitle = snapshot && snapshot.signedIn === false ? t('panel.signedOut') : t('panel.subtitle');
      return h(
        'div',
        { className: 'tb-head' },
        h(LiveDot, { state }),
        h(
          'div',
          { className: 'tb-title-wrap' },
          h('div', { className: 'tb-title' }, t('panel.title')),
          h('div', { className: 'tb-subtitle' }, subtitle)
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'tb-icon-btn',
            onClick: onRefresh,
            disabled: refreshing,
            'aria-label': t('refresh'),
            title: t('refresh')
          },
          h(IconRefresh, { className: refreshing ? 'tb-spin' : undefined })
        )
      );
    }

    function HeroCard({ label, value, sub, icon, tone, index }) {
      return h(
        'div',
        {
          className: 'tb-card tb-hero',
          style: { '--i': index },
          'data-tone': tone || 'default'
        },
        h(
          'div',
          { className: 'tb-hero-top' },
          h('span', { className: 'tb-label' }, label),
          h('span', { className: 'tb-hero-icon' }, icon)
        ),
        h('div', { className: 'tb-hero-value' }, value),
        sub !== null && sub !== undefined ? h('div', { className: 'tb-hero-sub' }, sub) : null
      );
    }

    function heroCards(snapshot, t, loading) {
      if (loading || !snapshot) {
        return [
          h(
            'div',
            { key: 'today', className: 'tb-card tb-hero', style: { '--i': 0 } },
            h('div', { className: 'tb-hero-top' }, h(Skeleton, { className: 'tb-skel-label' })),
            h(Skeleton, { className: 'tb-skel-value' }),
            h(Skeleton, { className: 'tb-skel-sub' })
          ),
          h(
            'div',
            { key: 'balance', className: 'tb-card tb-hero', style: { '--i': 1 } },
            h('div', { className: 'tb-hero-top' }, h(Skeleton, { className: 'tb-skel-label' })),
            h(Skeleton, { className: 'tb-skel-value' }),
            h(Skeleton, { className: 'tb-skel-sub' })
          )
        ];
      }

      const costText = formatMoney(snapshot.todayCost, snapshot.todayCurrency);
      const balanceText = snapshot.balance ? formatMoney(snapshot.balance.total, snapshot.balance.currency) : '—';
      const balanceSub = snapshot.balance
        ? snapshot.balance.recharge === null && snapshot.balance.bonus === null
          ? t('balanceCachedSub')
          : [
              t('recharge') + ' ' + formatMoney(snapshot.balance.recharge, snapshot.balance.currency),
              t('bonus') + ' ' + formatMoney(snapshot.balance.bonus, snapshot.balance.currency)
            ].join(' · ')
        : snapshot.signedIn === false
          ? t('error.signedOut')
          : t('error.balance');

      const tokenSub = snapshot.todayTokens === null
        ? t('source.balance')
        : snapshot.calls === null
          ? t('tokens')
          : snapshot.calls > 0
            ? t('calls', { count: formatCount(snapshot.calls) })
            : t('noCalls');

      return [
        h(HeroCard, {
          key: 'today',
          label: t('today'),
          value: costText,
          sub: tokenSub,
          tone: 'cost',
          index: 0,
          icon: h(IconCoin, { size: 15 })
        }),
        h(HeroCard, {
          key: 'balance',
          label: t('balance'),
          value: balanceText,
          sub: balanceSub,
          tone: 'balance',
          index: 1,
          icon: h(IconWallet, { size: 14 })
        })
      ];
    }

    function TokenCard({ snapshot, t, loading }) {
      if (loading || !snapshot) {
        return h(
          'div',
          { className: 'tb-card tb-token', style: { '--i': 2 } },
          h('div', { className: 'tb-token-head' }, h(Skeleton, { className: 'tb-skel-label' }), h(Skeleton, { className: 'tb-skel-total' })),
          h(Skeleton, { className: 'tb-skel-bar' }),
          h('div', { className: 'tb-legend' }, h(Skeleton, { className: 'tb-skel-legend' }), h(Skeleton, { className: 'tb-skel-legend' }), h(Skeleton, { className: 'tb-skel-legend' }))
        );
      }

      const total = snapshot.todayTokens;
      const hasTokens = total !== null && total > 0;
      const segments = hasTokens
        ? [
            { kind: 'input', value: snapshot.todayInput, label: t('input') },
            { kind: 'cache', value: snapshot.todayCache, label: t('cache') },
            { kind: 'output', value: snapshot.todayOutput, label: t('output') }
          ].filter(segment => segment.value > 0)
        : [];

      return h(
        'div',
        { className: 'tb-card tb-token', style: { '--i': 2 } },
        h(
          'div',
          { className: 'tb-token-head' },
          h(
            'div',
            null,
            h('div', { className: 'tb-label' }, t('tokens')),
            h('div', { className: 'tb-token-total' }, total === null ? '—' : formatTokens(total))
          ),
          h(
            'div',
            { className: 'tb-token-side' },
            snapshot.todayInput + snapshot.todayCache > 0
              ? t('cacheHit', {
                  percent: ((snapshot.todayCache / (snapshot.todayInput + snapshot.todayCache)) * 100).toFixed(1)
                })
              : snapshot.calls === null
                ? t('source.balance')
                : snapshot.calls > 0
                  ? t('calls', { count: formatCount(snapshot.calls) })
                  : t('noCalls')
          )
        ),
        h(
          'div',
          { className: 'tb-token-bar', role: 'img', 'aria-label': t('tokens') },
          hasTokens
            ? segments.map(segment =>
                h('span', {
                  key: segment.kind,
                  className: 'tb-token-seg',
                  'data-kind': segment.kind,
                  style: { width: Math.max(2, (segment.value / total) * 100) + '%' },
                  title: segment.label + ' ' + formatTokens(segment.value)
                })
              )
            : h('span', { className: 'tb-token-empty' })
        ),
        hasTokens
          ? h(
              'div',
              { className: 'tb-legend' },
              h(
                'span',
                { className: 'tb-legend-item' },
                h('i', { className: 'tb-legend-dot', 'data-kind': 'input' }),
                t('input'),
                h('b', null, formatTokens(snapshot.todayInput))
              ),
              h(
                'span',
                { className: 'tb-legend-item' },
                h('i', { className: 'tb-legend-dot', 'data-kind': 'cache' }),
                t('cache'),
                h('b', null, formatTokens(snapshot.todayCache))
              ),
              h(
                'span',
                { className: 'tb-legend-item' },
                h('i', { className: 'tb-legend-dot', 'data-kind': 'output' }),
                t('output'),
                h('b', null, formatTokens(snapshot.todayOutput))
              )
            )
          : h('div', { className: 'tb-token-empty-note' }, total === null ? t('hint.tokensUnavailable') : t('noCalls'))
      );
    }

    function buildWeek(snapshot) {
      const map = new Map();
      for (const entry of (snapshot && snapshot.history) || []) {
        if (entry && entry.date) map.set(entry.date, Number(entry.cost) || 0);
      }
      const todayKey = (snapshot && snapshot.todayKey) || shanghaiDay();
      const base = new Date(todayKey + 'T12:00:00+08:00');
      const days = [];
      for (let index = 6; index >= 0; index -= 1) {
        const date = new Date(base.getTime() - index * 86400000);
        const key = DAY_FMT.format(date);
        days.push({
          key,
          label: dayLabel(key),
          cost: map.get(key) || 0,
          today: key === todayKey
        });
      }
      const max = days.reduce((value, day) => Math.max(value, day.cost), 0);
      const total = days.reduce((value, day) => value + day.cost, 0);
      return { days, max, total };
    }

    function WeekCard({ snapshot, t, loading }) {
      if (loading || !snapshot) {
        return h(
          'div',
          { className: 'tb-card tb-week', style: { '--i': 3 } },
          h('div', { className: 'tb-week-head' }, h(Skeleton, { className: 'tb-skel-label' })),
          h('div', { className: 'tb-chart' }, [0, 1, 2, 3, 4, 5, 6].map(index => h(Skeleton, { key: index, className: 'tb-skel-bar tb-skel-day' })))
        );
      }

      const week = buildWeek(snapshot);
      return h(
        'div',
        { className: 'tb-card tb-week', style: { '--i': 3 } },
        h(
          'div',
          { className: 'tb-week-head' },
          h('div', { className: 'tb-label' }, t('week')),
          h(
            'div',
            { className: 'tb-week-total' },
            week.total > 0 ? t('weekTotal', { amount: formatMoney(week.total, snapshot.todayCurrency) }) : t('noHistory')
          )
        ),
        h(
          'div',
          { className: 'tb-chart' },
          week.days.map(day => {
            const height = week.max > 0 ? Math.max(3, Math.round((day.cost / week.max) * 36)) : 2;
            return h(
              'div',
              { key: day.key, className: 'tb-day', title: day.key + ' · ' + formatMoney(day.cost, snapshot.todayCurrency) },
              h(
                'div',
                { className: 'tb-bar-wrap' },
                h('span', {
                  className: 'tb-bar',
                  'data-today': day.today ? 'true' : undefined,
                  'data-zero': day.cost <= 0 ? 'true' : undefined,
                  style: { height: height + 'px' }
                })
              ),
              h('span', { className: 'tb-day-label', 'data-today': day.today ? 'true' : undefined }, day.label)
            );
          })
        )
      );
    }

    function Footer({ snapshot, t, loading }) {
      if (loading || !snapshot) {
        return h('div', { className: 'tb-foot' }, h(Skeleton, { className: 'tb-skel-foot' }));
      }
      const noteParts = [];
      if (snapshot.fetchedAt) noteParts.push(t('updated', { time: formatTime(snapshot.fetchedAt) }));
      noteParts.push(snapshot.source === 'balance' ? t('source.balance') : t('source.ledger'));
      return h(
        'div',
        { className: 'tb-foot' },
        h('div', { className: 'tb-foot-note', title: noteParts.join(' · ') }, noteParts.join(' · ')),
        snapshot.links && snapshot.links.usageUrl
          ? h(
              'a',
              {
                className: 'tb-foot-link',
                href: snapshot.links.usageUrl,
                target: '_blank',
                rel: 'noreferrer'
              },
              t('usage'),
              h(IconArrow, { size: 11 })
            )
          : null,
        snapshot.links && snapshot.links.topUpUrl
          ? h(
              'a',
              {
                className: 'tb-foot-link tb-foot-link-primary',
                href: snapshot.links.topUpUrl,
                target: '_blank',
                rel: 'noreferrer'
              },
              t('topUp'),
              h(IconArrow, { size: 11 })
            )
          : null
      );
    }

    function PanelBody({ snapshot, refreshing, onRefresh, t, loading }) {
      const notices = [];
      if (!loading && snapshot) {
        if (snapshot.error === 'all') {
          notices.push(h(Notice, { key: 'all', kind: 'error' }, t('error.all')));
        } else if (snapshot.error === 'balance') {
          notices.push(
            h(
              Notice,
              { key: 'balance', kind: 'warn' },
              snapshot.signedIn === false ? t('error.signedOut') + ' · ' + t('hint.signIn') : t('error.balance')
            )
          );
        } else if (snapshot.error === 'cost') {
          notices.push(h(Notice, { key: 'cost', kind: 'warn' }, t('error.cost')));
        } else if (snapshot.source === 'balance') {
          const text = snapshot.seededFrom
            ? t('hint.seeded', { date: dayLabel(snapshot.seededFrom) })
            : snapshot.partial
              ? t('hint.partial', { time: formatTime(snapshot.observedFrom) })
              : t('hint.balanceEstimate');
          notices.push(h(Notice, { key: 'fallback', kind: 'info' }, text));
        }
        if (snapshot.balance && snapshot.balance.stale) {
          notices.push(
            h(
              Notice,
              { key: 'stale-balance', kind: 'info' },
              t('hint.balanceStale', {
                time: formatDateTime(snapshot.balanceObservedAt || snapshot.balance.observedAt)
              })
            )
          );
        }
      }

      return h(
        React.Fragment,
        null,
        h(Header, { snapshot, refreshing, onRefresh, t }),
        h('div', { className: 'tb-hero-grid' }, heroCards(snapshot, t, loading)),
        notices,
        h(TokenCard, { snapshot, t, loading }),
        h(WeekCard, { snapshot, t, loading }),
        h(Footer, { snapshot, t, loading })
      );
    }

    function ErrorBody({ t, onRetry, refreshing }) {
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'tb-head' },
          h(LiveDot, { state: 'error' }),
          h(
            'div',
            { className: 'tb-title-wrap' },
            h('div', { className: 'tb-title' }, t('panel.title')),
            h('div', { className: 'tb-subtitle' }, t('error.all'))
          ),
          h(
            'button',
            { type: 'button', className: 'tb-icon-btn', onClick: onRetry, disabled: refreshing, 'aria-label': t('retry') },
            h(IconRefresh, { className: refreshing ? 'tb-spin' : undefined })
          )
        ),
        h(
          'div',
          { className: 'tb-empty' },
          h('span', { className: 'tb-empty-orb', 'aria-hidden': 'true' }, h(IconCoin, { size: 22 })),
          h('span', { className: 'tb-empty-title' }, t('error.all')),
          h('button', { type: 'button', className: 'tb-retry', onClick: onRetry, disabled: refreshing }, t('retry'))
        )
      );
    }

    /* --------------------------------------------------------------------- */
    /* Root component                                                        */
    /* --------------------------------------------------------------------- */

    function TokenBillingAction(props) {
      const { t } = props;
      const buttonRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const ticketRef = React.useRef(0);
      const [snapshot, setSnapshot] = React.useState(snapshotCache);
      const [open, setOpen] = React.useState(false);
      const [position, setPosition] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);

      const load = React.useCallback(
        async force => {
          const ticket = ++ticketRef.current;
          setRefreshing(true);
          try {
            const next = await fetchSnapshot(props.ctx, force);
            if (ticket === ticketRef.current) setSnapshot(next);
          } catch (error) {
            if (ticket === ticketRef.current) {
              setSnapshot(previous => ({
                ...(previous || {}),
                fetchedAt: Date.now(),
                error: 'all',
                todayCost: previous ? previous.todayCost : null,
                todayCurrency: (previous && previous.todayCurrency) || 'CNY',
                history: (previous && previous.history) || [],
                todayKey: (previous && previous.todayKey) || shanghaiDay(),
                source: (previous && previous.source) || 'balance',
                links: (previous && previous.links) || DEFAULT_LINKS
              }));
            }
          } finally {
            if (ticket === ticketRef.current) setRefreshing(false);
          }
        },
        [props.ctx]
      );

      React.useEffect(() => {
        load(!snapshotCache);
      }, [load]);

      React.useEffect(() => {
        const tick = () => {
          if (!document.hidden) load(false);
        };
        const timer = window.setInterval(tick, POLL_MS);
        document.addEventListener('visibilitychange', tick);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', tick);
        };
      }, [load]);

      const close = React.useCallback(restoreFocus => {
        setOpen(false);
        if (restoreFocus) {
          window.requestAnimationFrame(() => {
            if (buttonRef.current) buttonRef.current.focus({ preventScroll: true });
          });
        }
      }, []);

      useOutsideClose(open, panelRef, buttonRef, close);

      React.useEffect(() => {
        if (!open) return undefined;
        const onResize = () => {
          const next = panelPosition(buttonRef.current);
          if (next) setPosition(next);
        };
        window.addEventListener('resize', onResize);
        const frame = window.requestAnimationFrame(() => {
          if (panelRef.current) panelRef.current.focus({ preventScroll: true });
        });
        return () => {
          window.removeEventListener('resize', onResize);
          window.cancelAnimationFrame(frame);
        };
      }, [open]);

      const toggle = React.useCallback(() => {
        if (open) {
          close(true);
          return;
        }
        const next = panelPosition(buttonRef.current);
        if (!next) return;
        setPosition(next);
        setOpen(true);
        load(false);
      }, [open, close, load]);

      const loading = !snapshot;
      const costText = snapshot ? formatMoney(snapshot.todayCost, snapshot.todayCurrency) : null;
      const balanceText = snapshot && snapshot.balance ? formatMoney(snapshot.balance.total, snapshot.balance.currency) : null;
      const pillText = balanceText;
      const ariaLabel = snapshot
        ? t('pill.aria') + ': ' + t('balance') + ' ' + (balanceText || '—') + ', ' + t('today') + ' ' + (costText || '—')
        : t('pill.aria');
      const pillTitle = snapshot
        ? t('pill.balanceTitle') + ' ' + (balanceText || '—')
        : t('loading');

      const panel =
        open && position
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  ref: panelRef,
                  className: 'tb-panel',
                  role: 'dialog',
                  'aria-label': t('panel.title'),
                  tabIndex: -1,
                  style: {
                    left: position.left + 'px',
                    top: position.top + 'px',
                    width: position.width + 'px',
                    maxHeight: position.maxHeight + 'px',
                    '--tb-origin': position.origin + 'px'
                  }
                },
                snapshot && snapshot.error === 'all' && !snapshot.todayTokens && !snapshot.balance
                  ? h(ErrorBody, { t, onRetry: () => load(true), refreshing })
                  : h(PanelBody, { snapshot, refreshing, onRefresh: () => load(true), t, loading })
              ),
              document.body
            )
          : null;

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'tb-pill',
            'data-open': open ? 'true' : 'false',
            'aria-label': ariaLabel,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            title: pillTitle,
            onClick: toggle
          },
          h(IconCoin, { size: 16, className: 'tb-pill-icon' }),
          snapshot
            ? h('span', { className: 'tb-pill-text' }, pillText || '—')
            : h('span', { className: 'tb-pill-skeleton', 'aria-hidden': 'true' })
        ),
        panel
      );
    }

    /* --------------------------------------------------------------------- */
    /* Styles                                                                */
    /* --------------------------------------------------------------------- */

    const CSS = `
.tb-pill{height:28px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px 0 7px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;line-height:1;cursor:pointer;white-space:nowrap;flex:none;-webkit-app-region:no-drag;user-select:none;transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}
.tb-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tb-pill:active{transform:scale(.97)}
.tb-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.tb-pill[data-open="true"]{background:var(--dsw-alias-button-ghost-active-fill);border-color:var(--dsw-alias-button-ghost-active-border);color:var(--dsw-alias-label-primary)}
.tb-pill-icon{display:block;flex:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.16))}
.tb-pill-text{min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.tb-pill-skeleton{display:block;width:38px;height:7px;border-radius:4px;background:linear-gradient(90deg,var(--dsw-alias-bg-skeleton) 25%,var(--dsw-alias-bg-layer-3) 45%,var(--dsw-alias-bg-skeleton) 65%);background-size:220% 100%;animation:tb-shimmer 1.6s linear infinite}
.tb-panel{position:fixed;z-index:1000;box-sizing:border-box;display:flex;flex-direction:column;gap:9px;padding:13px 14px;overflow-y:auto;overscroll-behavior:contain;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 72%,transparent);border-radius:22px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 86%,transparent);box-shadow:0 28px 70px rgba(0,0,0,.34),0 4px 18px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.13);backdrop-filter:blur(30px) saturate(1.65);-webkit-backdrop-filter:blur(30px) saturate(1.65);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.35;outline:none;-webkit-app-region:no-drag;animation:tb-pop .3s cubic-bezier(.18,1.18,.34,1) both;transform-origin:var(--tb-origin,100%) 0}
@supports not (backdrop-filter:blur(1px)){.tb-panel{background:var(--dsw-alias-bg-layer-2)}}
.tb-panel>*{flex:none}
.tb-panel::-webkit-scrollbar{width:8px}
.tb-panel::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:8px}
.tb-head{display:flex;align-items:center;gap:8px;min-height:30px;padding:1px 1px 0}
.tb-live{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.tb-live[data-state="busy"],.tb-live[data-state="warn"]{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);animation:tb-pulse 1.4s ease-in-out infinite}
.tb-live[data-state="error"]{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.tb-title-wrap{display:flex;flex-direction:column;gap:1px;min-width:0}
.tb-title{font-size:14px;font-weight:650;letter-spacing:.005em;color:var(--dsw-alias-label-primary);white-space:nowrap}
.tb-subtitle{font-size:10px;font-weight:500;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-left:auto;flex:none;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease,transform .2s ease;-webkit-app-region:no-drag}
.tb-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tb-icon-btn:active{transform:scale(.94)}
.tb-icon-btn:disabled{cursor:default;opacity:.82}
.tb-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tb-spin{animation:tb-spin .9s linear infinite}
.tb-hero-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}
.tb-card{position:relative;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 76%,transparent);overflow:hidden;animation:tb-rise .38s cubic-bezier(.18,1,.3,1) both;animation-delay:calc(var(--i,0) * 32ms)}
.tb-hero{display:flex;flex-direction:column;gap:5px;min-height:88px;padding:10px 11px 9px}
.tb-hero::after{content:"";position:absolute;inset:-40% -30% auto auto;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--tb-tone,var(--dsw-alias-brand-primary)) 22%,transparent),transparent 68%);pointer-events:none}
.tb-hero[data-tone="cost"]{--tb-tone:var(--dsw-alias-state-warn-primary)}
.tb-hero[data-tone="balance"]{--tb-tone:var(--dsw-alias-state-business-primary)}
.tb-hero-top{display:flex;align-items:center;gap:6px;position:relative;z-index:1}
.tb-label{font-size:10px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.tb-hero-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:auto;border-radius:7px;background:color-mix(in srgb,var(--tb-tone,var(--dsw-alias-brand-primary)) 13%,transparent);color:var(--tb-tone,var(--dsw-alias-brand-primary));flex:none}
.tb-hero-value{position:relative;z-index:1;font-size:22px;font-weight:650;letter-spacing:-.035em;line-height:1.1;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}
.tb-hero-sub{position:relative;z-index:1;font-size:9.5px;font-weight:500;line-height:1.3;color:var(--dsw-alias-label-tertiary);min-height:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-token{display:flex;flex-direction:column;gap:8px;padding:10px 12px 9px}
.tb-token-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.tb-token-total{margin-top:2px;font-size:18px;font-weight:650;letter-spacing:-.03em;line-height:1.1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.tb-token-side{padding-top:3px;font-size:9.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);text-align:right;white-space:nowrap}
.tb-token-bar{display:flex;width:100%;height:8px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-border-l2) 48%,transparent);gap:1px}
.tb-token-seg{display:block;height:100%;min-width:2px;border-radius:999px;transition:width .45s cubic-bezier(.2,.8,.2,1)}
.tb-token-seg[data-kind="input"]{background:var(--dsw-alias-state-business-primary)}
.tb-token-seg[data-kind="cache"]{background:var(--dsw-alias-state-warn-primary)}
.tb-token-seg[data-kind="output"]{background:var(--dsw-alias-state-success-primary)}
.tb-token-empty{display:block;width:100%;height:100%;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-border-l2) 42%,transparent),color-mix(in srgb,var(--dsw-alias-border-l1) 32%,transparent))}
.tb-token-empty-note{font-size:9.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:12px}
.tb-legend-item{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.tb-legend-item b{font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.tb-legend-dot{display:inline-block;width:5px;height:5px;border-radius:50%;flex:none}
.tb-legend-dot[data-kind="input"]{background:var(--dsw-alias-state-business-primary)}
.tb-legend-dot[data-kind="cache"]{background:var(--dsw-alias-state-warn-primary)}
.tb-legend-dot[data-kind="output"]{background:var(--dsw-alias-state-success-primary)}
.tb-week{display:flex;flex-direction:column;gap:7px;padding:10px 12px 9px}
.tb-week-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.tb-week-total{font-size:9.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-chart{display:flex;align-items:flex-end;gap:5px;height:54px;padding:0 1px}
.tb-day{display:flex;flex:1 1 0;min-width:0;flex-direction:column;align-items:center;gap:4px}
.tb-bar-wrap{position:relative;display:flex;align-items:flex-end;justify-content:center;width:100%;height:38px}
.tb-bar-wrap::before{content:"";position:absolute;left:50%;bottom:0;width:100%;max-width:17px;height:100%;transform:translateX(-50%);border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-border-l1) 18%,transparent);pointer-events:none}
.tb-bar{position:relative;z-index:1;display:block;width:100%;max-width:17px;border-radius:5px 5px 3px 3px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent),color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent));transition:height .4s cubic-bezier(.2,.8,.2,1);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.tb-bar[data-today="true"]{background:linear-gradient(180deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent));box-shadow:0 0 12px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent),inset 0 1px 0 rgba(255,255,255,.2)}
.tb-bar[data-zero="true"]{background:color-mix(in srgb,var(--dsw-alias-border-l2) 52%,transparent);box-shadow:none}
.tb-day-label{font-size:8.5px;font-weight:500;line-height:1;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.tb-day-label[data-today="true"]{color:var(--dsw-alias-label-primary);font-weight:650}
.tb-foot{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding-top:2px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 52%,transparent);min-height:22px}
.tb-foot-note{flex:1 1 120px;min-width:0;font-size:9.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-foot-link{display:inline-flex;align-items:center;gap:2px;padding:4px 5px;border-radius:6px;font-size:10px;font-weight:600;color:var(--dsw-alias-link);text-decoration:none;white-space:nowrap;transition:background-color .15s ease,color .15s ease}
.tb-foot-link:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tb-foot-link-primary{color:var(--dsw-alias-state-business-primary)}
.tb-notice{display:flex;align-items:flex-start;gap:6px;padding:6px 8px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 66%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 52%,transparent)}
.tb-notice-dot{width:5px;height:5px;border-radius:50%;margin-top:3px;flex:none;background:var(--dsw-alias-label-tertiary)}
.tb-notice-text{font-size:9.5px;font-weight:500;line-height:1.35;color:var(--dsw-alias-label-secondary);min-width:0}
.tb-notice[data-kind="warn"] .tb-notice-dot{background:var(--dsw-alias-state-warn-primary)}
.tb-notice[data-kind="error"] .tb-notice-dot{background:var(--dsw-alias-state-error-primary)}
.tb-notice[data-kind="error"] .tb-notice-text{color:var(--dsw-alias-state-error-primary)}
.tb-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;padding:18px;text-align:center}
.tb-empty-orb{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.tb-empty-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.tb-retry{height:28px;padding:0 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:600;cursor:pointer;-webkit-app-region:no-drag}
.tb-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tb-skel{display:block;border-radius:5px;background:linear-gradient(90deg,var(--dsw-alias-bg-skeleton) 25%,var(--dsw-alias-bg-layer-3) 45%,var(--dsw-alias-bg-skeleton) 65%);background-size:220% 100%;animation:tb-shimmer 1.5s linear infinite}
.tb-skel-label{width:44px;height:9px}
.tb-skel-value{width:74%;height:20px;margin-top:9px}
.tb-skel-sub{width:58%;height:8px;margin-top:7px}
.tb-skel-total{width:64px;height:18px;margin-top:5px}
.tb-skel-bar{width:100%;height:8px;border-radius:999px}
.tb-skel-legend{width:52px;height:8px}
.tb-skel-foot{width:150px;height:8px}
.tb-skel-day{flex:1;height:28px;border-radius:5px}
@keyframes tb-pop{0%{opacity:0;transform:translateY(-7px) scale(.9)}58%{opacity:1;transform:translateY(1px) scale(1.008)}100%{opacity:1;transform:translateY(0) scale(1)}}
@keyframes tb-rise{0%{opacity:0;transform:translateY(8px) scale(.985)}100%{opacity:1;transform:translateY(0) scale(1)}}
@keyframes tb-shimmer{0%{background-position:120% 0}100%{background-position:-120% 0}}
@keyframes tb-spin{to{transform:rotate(360deg)}}
@keyframes tb-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (max-width:640px){.tb-pill-text{display:none}.tb-pill{width:28px;padding:0;justify-content:center}}
@media (prefers-reduced-motion:reduce){.tb-panel,.tb-card,.tb-bar,.tb-pill,.tb-icon-btn,.tb-token-seg{animation:none!important;transition:none!important}.tb-spin{animation:none!important}.tb-live[data-state="busy"]{animation:none!important}}
`;

    /* --------------------------------------------------------------------- */
    /* Plugin body                                                           */
    /* --------------------------------------------------------------------- */

    function installStyles(ctx) {
      ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID);
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, 'token-billing: styles');
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        installStyles(ctx);
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en
            }),
          'token-billing: dictionaries'
        );
        const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : key => key;
        const Action = props => h(TokenBillingAction, Object.assign({}, props, { ctx, t }));
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'token-billing',
              order: 100,
              locale: NS,
              inject: () => ({ t })
            },
            Action
          )
        );
      }
    };
  }
});
