# Usage & billing

A DeepSeek Harness bundle that puts a compact usage pill in the conversation
header, immediately left of the right-sidebar expand control.

Clicking the pill opens a Control Center-style popover with:

- today's spend and the current account balance;
- today's token total, cache-hit rate, and input / cache / output composition;
- a seven-day spend chart;
- refresh, usage-page, and top-up actions.

## How the numbers are made

The bundle has a small host half and a browser half.

- **Account balance** comes from the optional `deepseekAccount` host service,
  the same service Settings → Account uses. If that call fails, the control
  falls back to the last balance cached in the cost-meter or token-billing
  ledger and marks it as cached in the title-bar pill and popover.
- **Today's spend** comes from a balance-delta ledger maintained by the host
  at `$DSH_HOME/storages/token-billing/ledger.json`. When the previous day's
  balance is available near midnight, today's opening balance is seeded from
  it; otherwise the control reports the change since the first observation
  and labels the estimate.
- **Token usage** is folded from today's committed session logs
  (`$DSH_HOME/sessions/**/session.v*.jsonl[.zstd]`), summing the usage
  reported by completed Assistant messages. The scanner reads only appended
  data after its first pass. On Node 20 or Node 22 before 22.15, compressed
  `.zstd` logs cannot be decoded by Node itself; token usage is shown as
  unavailable unless cost-meter supplies it. Balance and spending still work.
- **Cost-meter** is optional. If its ledger exists, its exact priced day is
  preferred for today's spend, and its history is available to the chart.

The browser reads one same-origin endpoint, `GET /api/token-billing/summary`.
The route is loopback-only and returns no credentials or provider keys.

## Install

Download the [v0.1.1 package](https://github.com/lucasnixf-hash/dsh-token-billing/releases/download/v0.1.1/dsh-token-billing-0.1.1.tgz),
or install the package directory as a bundle in the current profile. The row in
`cordis.patch.yml` mounts the host route; the browser module registers itself
in `conversation.session.header.utilities`.

After installing or updating the host half, restart the desktop application
(or toggle the bundle off and on) so the Host loads the new module. Refresh
the Web GUI after a browser-module change; a client-only hot reload may not
pick up a new route.

## Share, test, publish

The package is dependency-free and needs no build step: `npm pack` is the
complete artifact. For a private test build, send the tarball and install it
with `dsh plugin --profile web add <tarball>`, or extract it and install the
directory through the desktop Plugin Manager.

For npm publishing, a GitHub Release, and submitting the plugin to
awesome-dsh-plugin / dshmarket, see [PUBLISHING.md](PUBLISHING.md). The
package name is `dsh-token-billing`; keep the package name, the patch row
name, and the client module id in sync if you rename it.
