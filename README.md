# Helius — a Vineyard plugin pack

Follows funds on Solana through [Helius](https://www.helius.dev/): an address's SOL and SPL token
transfers, the wallet that sent it its first SOL, and, on paid Helius plans, Helius's identity
labels for known wallets.

The keyless Solana RPCs answer `getSignaturesForAddress` for the wallet itself, and an SPL token
does not sit in the wallet: it sits in a token account the wallet owns. A USDC payment to a wallet
is therefore missing from the wallet's own history. Helius's `getTransactionsForAddress` can include
the transactions that change the balance of the wallet's token accounts, and can read a history
oldest first, which is what finding a first funding takes.

## Plugins

| Plugin | Takes | Adds | Plan |
| --- | --- | --- | --- |
| **Solana Address History** | Crypto Address on `solana` | `sent to` links to and from every wallet on the other side of a SOL or SPL token transfer, with `summary_helius` (per asset: count, total, first, last, and the window read) and, on a link it creates, the latest 20 transfers in `recent`. On the address: `balance`, `last_seen`, `history_examined`, `history_complete`, and `first_seen` when the whole history was read | Free |
| **Solana First Funder** | Crypto Address on `solana` | `first_funder`, `first_funding_tx` and `activated_at` on the address; the funder as a Crypto Address; `first_funding` on the funder's `sent to` link to it | Free (earliest deposit); paid for `funded-by` |
| **Solana Wallet Identity** | Crypto Address on `solana` | Helius's name as `public_label` (or `helius_label`), `helius_category`, `helius_type`, `helius_tags`, `helius_domains`; `attributed to` an Exchange, Crypto Service or Organization when the category names who holds the address | Paid only |

Requires the Cryptocurrency type pack; Wallet Identity also writes Financial's `exchange` and
Identity's `organization`.

## Setup

1. Get an API key at [dashboard.helius.dev](https://dashboard.helius.dev). The free plan gives
   1 million credits a month at 10 RPC requests a second and 2 Wallet API requests a second.
2. In Vineyard, open **Run plugins**, pick a Helius plugin and paste the key into its settings. All
   three plugins call the same two Helius hosts, so the key is entered once.

Works in the web app and the desktop app. Both hosts answer a browser's preflight with
`access-control-allow-origin: *` and allow every request header, measured 2026-11-15 without a key
(a 200 was not seen, since that needs one).

### What needs a paid plan

Helius's Wallet API `identity` and `funded-by` endpoints are paid-plan only (Developer, $49 a month,
or above): a free plan's key gets `403 Forbidden` (Helius, *Wallet API overview, Plan
requirements*). So:

- **Solana Wallet Identity** fails on a free key, with a message that says so.
- **Solana First Funder** asks `funded-by` first, and on a 403 switches, for the rest of the run, to
  reading the address's history from the start and taking the earliest incoming SOL transfer. That
  is the definition Helius gives `funded-by` itself ("traced to its first incoming SOL transfer").
  Set **Method** to `earliest_deposit` to skip the `funded-by` call altogether.
- A `funded-by` 404 is read the same way on a paid key. Helius answers 404 for a wallet that never
  received SOL, but also for one it holds no record of: its *Limitations* say historical data covers
  only wallets created after the endpoint was deployed. So the 404 is not taken as "never funded";
  the history is read from the start, and the summary counts those addresses.

### Credits

| Call | Credits |
| --- | --- |
| `getTransactionsForAddress`, full transactions | 10 per 100 returned, at least 10 |
| `getBalance` | 1 |
| `funded-by`, `identity` | 100 each |

A history run of 300 transactions per address costs about 31 credits; each run's summary gives its
own estimate. Reading from the start for a first funder goes 100 transactions a page, because a
page of 25 costs the same 10 credits.

## Terms

- Helius's [Cloud Services Agreement](https://www.helius.dev/terms) (last updated 2026-09-28)
  licenses use for a lawful business purpose and excludes use "in any personal, household, or
  familial capacity" (§3.2(xi)), and holds the customer to keeping its access credentials
  confidential (§6.1). It says nothing specific about storing or caching results.
- Helius receives every address looked up, with your key. Helius RPC takes the key only as the
  `api-key` query parameter, so it travels in the request URL; the Wallet API gets it in the
  `X-Api-Key` header.

## Why it is shaped this way

**Transfers are read from instructions, not from balance changes.** A transaction's balance changes
say who gained and who lost, not who paid whom: a swap, a fee and a payout in one transaction are
three unrelated movements. The parsed System Program and SPL Token transfer instructions name both
sides, top level and inner (CPI) alike. Token accounts are resolved to their owners from the
transaction's own token balances, and from the instructions that create a token account in it.

**What that does not see.** SOL a program moves by editing an account it owns, without a transfer
instruction, and the rent a token account returns when it is closed. Token transfers before
December 2022 (slot 111,491,819), whose transactions do not name token-account owners, are counted
in the summary and left out. Helius's `tokenAccounts` filter does not reach them either.

**Rent is not a payment.** A `createAccount` that funds a new token account or program account is
rent; a wallet that opened 300 token accounts would otherwise be linked `sent to` 300 accounts
nobody controls. It counts when the new account is a plain wallet, or is the address itself.

**Wrapping is not a payment.** A swap from SOL starts with the wallet sending SOL into its own wSOL
token account; the swap then pays that wSOL to the pool. Read as a transfer between accounts, the
first step would link the wallet `sent to` its own token account (the same address on every swap,
soon its busiest pair) and count the SOL twice. SOL sent into a token account is read as going to
the account's owner: left out and counted when that is the sender, a payment to the owner when it
is someone else.

**The first funding is where the balance first rose from zero.** Reading from the start, the
transaction that counts is the first in which the address's balance (`meta.preBalances` and
`postBalances`) goes from zero to more, and the funder is whoever sent SOL to it there. An address
whose first lamports came another way (a closed token account, a stake withdrawal, a program) gets
no funder, and neither does one whose earliest transaction already finds SOL in it: a later
transfer is never taken for the first.

**One link per pair, never relabelled.** The Cryptocurrency type pack's rule: a pair of addresses
has one link, a collector adds data to a link that is there instead of relabelling it, and each
source's figures go under a key of their own (`summary_helius`), because commit merges link data one
top-level key at a time. `recent` is shared by every collector and merged by transaction and asset,
which takes the rows a link already holds from the copy of its data the app passes, so a re-run
adds Helius's latest transfers to the list. An older app passed plugins a link's id, endpoints and
label only; there a link already in the project gets `summary_helius` but keeps the `recent` list it
has, because sending this run's rows alone would replace the whole list, and the run's summary
counts those links.
The first funding is not a link of its own: the funder sent to the address, so it is the
`first_funding` key on that pair's `sent to` link.

**The window is what was read.** Histories are read newest first up to **Most transactions per
address** (default 300). `window_from` is the oldest transaction read and `complete` says whether
that was the start; `first_seen` is written only when it was.

**Amounts are decimal strings.** SOL is 9 decimals and lamports are u64; JSON numbers lose integers
above 2^53, about 9 million SOL. Responses are parsed keeping such integers digit for digit.

**Helius's labels stay Helius's.** `public_label` is shared with every collector that has a label
for an address, so Helius's name goes there only when the address has none, or Helius's own;
otherwise in `helius_label`. Only categories that name who holds an address become an owner node:
Centralized Exchange (the exchange, `Binance 1` → `Binance`, `OKX Exchange 1` → `OKX`), bridges,
DeFi and casinos (Crypto Service, `Stake.com Hot Wallet` → `Stake.com`), market makers and trading
firms (Organization, `Wintermute 2` → `Wintermute`). Only a trailing number or wallet kind (and, for an
exchange, a trailing "Exchange") is cut from the label, so one owner's wallets meet on one node; the
link keeps the label as Helius wrote it. Scammer, Hacker and the like are claims
about the address, and Key Opinion Leader names a person whose name alone would merge strangers;
those stay labels. The link's `label_kind` is `public_tag`: Helius does not grade its labels and
publishes them as tags on its Orb explorer.

**The key is never in a message.** Errors name the host, never the URL, because the RPC URL carries
the key and messages reach the Tasks panel and the AI panel's model.

## Build and test

```sh
node build.mjs          # bundles src/main.ts into dist/pack.mjs (esbuild 0.25.12, pinned)
node gen-manifest.mjs   # regenerates plugins/helius.manifest.json from the bundle
node test-plugin.mjs    # plugins against documented response shapes; no network
node test/pure.test.mjs # transfer extraction, link figures, amounts, attribution
```

`node build.mjs && git diff --exit-code dist/pack.mjs` checks the published bundle against this
source.

**The fixtures are not recordings.** This pack was written without a Helius key, so the response
shapes in `test/fixtures.mjs` are built from Helius's documentation (`getTransactionsForAddress`,
`funded-by`, `identity`) and Solana's `jsonParsed` transaction format; only the 401 that a missing
or wrong key gets was measured. `HELIUS_API_KEY=… node live-test.mjs` runs every plugin against the
live APIs on the example addresses of Helius's documentation; with a paid key it also checks that the
earliest-deposit method finds the funder `funded-by` names. The key is read from the environment
only and never printed.

## License

Apache-2.0. Data returned by Helius is subject to Helius's terms.
