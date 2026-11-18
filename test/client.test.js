import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('browser fallback keeps missing price unknown and marks cached balance', async () => {
  const effects = [];
  let hookIndex = 0;
  let snapshot = null;
  let resolveSnapshot;
  const snapshotReady = new Promise(resolve => { resolveSnapshot = resolve; });
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: value => ({ current: value }),
    useState(initial) {
      const index = hookIndex++;
      if (index === 0) {
        return [snapshot ?? initial, next => {
          snapshot = typeof next === 'function' ? next(snapshot) : next;
          resolveSnapshot(snapshot);
        }];
      }
      return [initial, () => {}];
    },
    useCallback: callback => callback,
    useEffect: callback => { effects.push(callback); }
  };
  let factory;
  const storage = new Map();
  const document = { baseURI: 'http://localhost:3000/' };
  const window = { __ModuleLoader__: { load: module => { factory = module.factory; } } };
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    window, document,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    fetch: async () => ({ ok: false }),
    AbortController, URL, Intl, Date, Number, String, Math, Promise,
    setTimeout, clearTimeout,
    globalThis: { __DSH_BOOT__: { version: '0.2.2-rc.1' } }
  });
  assert.equal(typeof factory, 'function');
  const plugin = factory(name => name === 'react' ? React : {});
  let Action;
  const ctx = {
    effect: () => {},
    locale: {
      bind: () => (key, params) => key === 'hint.balanceStale' ? `Cached at ${params.time}` : key,
      getSnapshot: () => ({ active: 'en' })
    },
    slots: {
      inject: (_name, register) => register(),
      register: (_config, component) => { Action = component; }
    },
    get: name => {
      if (name === 'remote') return {
        account: {
          getState: async () => ({ ok: true, value: { status: 'credential-stored' } }),
          getBalance: async () => ({ ok: true, value: {
            status: 'ready', value: [{ currency: 'CNY', balance: 100 }]
          } })
        }
      };
      if (name === 'remote.costMeter') return {
        getState: async () => ({ ok: true, value: {
          config: { currency: 'CNY' }, today: { input: 2, output: 3 }, history: []
        } })
      };
      return undefined;
    }
  };
  plugin.apply(ctx);
  assert.equal(typeof Action, 'function');
  const wrapper = Action({});
  wrapper.type(wrapper.props);
  effects[0]();
  await snapshotReady;
  assert.equal(snapshot.source, 'balance');
  assert.equal(snapshot.todayCost, 0);
  assert.equal(snapshot.todayTokens, 5);

  snapshot = {
    ...snapshot,
    balance: { ...snapshot.balance, stale: true, observedAt: Date.now() - 60_000 }
  };
  hookIndex = 0;
  effects.length = 0;
  const tree = wrapper.type(wrapper.props);
  const pill = tree.children[0];
  assert.equal(pill.props['data-stale'], 'true');
  assert.match(pill.props['aria-label'], /Cached at/);
  assert.ok(pill.children.some(child => child && child.props.className === 'tb-pill-stale-badge'));
});
