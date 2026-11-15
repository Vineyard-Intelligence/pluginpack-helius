// Unit tests for the pure modules — value conversions (src/values.ts), transfer extraction
// (src/transfers.ts), link figures (src/flows.ts) and owner attribution (src/attribution.ts).
// No network, no host.
//   Run: node test/pure.test.mjs
//
// The modules are bundled to a temp directory with the same pinned esbuild the pack uses, because
// they are TypeScript and this runs on plain Node.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as F from './fixtures.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'helius-pure-'));
const load = async (name) => {
    const out = join(dir, `${name}.mjs`);
    execFileSync('npx', ['--yes', 'esbuild@0.25.12', join(root, 'src', `${name}.ts`), '--bundle', '--format=esm', '--platform=neutral', '--log-level=warning', `--outfile=${out}`], { cwd: root });
    return import(pathToFileURL(out).href);
};
const v = await load('values');
const tr = await load('transfers');
const fl = await load('flows');
const at = await load('attribution');

const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);

// ---- values ------------------------------------------------------------------------------------

check('isSolanaAddress: a real wallet', v.isSolanaAddress('HXsKP7wrBWaQ8T2Vtjry3Nj3oUgwYcqq9vrHDM12G664'));
check('isSolanaAddress: the System Program (32 ones = 32 zero bytes)', v.isSolanaAddress('11111111111111111111111111111111'));
check('isSolanaAddress: a made-up 32-byte value', v.isSolanaAddress(F.addr(5)));
check('isSolanaAddress: not a TRON address (25 bytes)', !v.isSolanaAddress('TZG47zhb8kcriWQ2rE719yHs1KqgzwMrvF'));
check('isSolanaAddress: not an EVM address', !v.isSolanaAddress('0x8d53903625b8e839b9df4bd28b0efb1cd6b8639a'));
check('isSolanaAddress: 0, O, I, l are not Base58', !v.isSolanaAddress('HXsKP7wrBWaQ8T2Vtjry3Nj3oUgwYcqq9vrHDM12G660') && !v.isSolanaAddress('OXsKP7wrBWaQ8T2Vtjry3Nj3oUgwYcqq9vrHDM12G664'));
check('isSolanaAddress: a 64-byte signature is not an address', !v.isSolanaAddress(F.sig(1)));

check('formatUnits: lamports to SOL', v.formatUnits('98119720', 9) === '0.09811972');
check('formatUnits: whole numbers lose the point', v.formatUnits(1500000000n, 9) === '1.5' && v.formatUnits(2000000000n, 9) === '2' && v.formatUnits(0n, 6) === '0');
check('formatUnits: one base unit', v.formatUnits('1', 9) === '0.000000001');
check('formatUnits: zero decimals', v.formatUnits('42', 0) === '42');
check('toBigInt: digits, safe integers, bigints; not floats or negatives', v.toBigInt('12345678901234567890') === 12345678901234567890n && v.toBigInt(5) === 5n && v.toBigInt(5n) === 5n && v.toBigInt(1.5) === null && v.toBigInt(-1) === null && v.toBigInt('1e9') === null);
check('isoTime: Unix seconds to ISO without milliseconds', v.isoTime(1642625194) === '2022-01-19T20:46:34Z' && v.isoTime(null) === undefined && v.isoTime(0) === undefined);

{
    const j = v.parseExact('{"a":12345678901234567891,"b":5,"c":1.5,"d":[9007199254740993],"e":1e21}');
    check('parseExact: an integer above 2^53 keeps its digits as a string', j.a === '12345678901234567891' && j.d[0] === '9007199254740993');
    check('parseExact: safe integers, floats and exponents are left as numbers', j.b === 5 && j.c === 1.5 && j.e === 1e21);
}

// ---- transfers ---------------------------------------------------------------------------------

const W = F.addr(1);
const X = F.addr(2);
const WTA = F.addr(10);
const XTA = F.addr(11);

{
    const t = F.tx({ signature: F.sig(1), slot: 5, blockTime: 1700000000, keys: [W, X, F.SYS], ixs: [F.sysTransfer(W, X, 1000)] });
    const x = tr.transfersOf(t, '2023-11-14T22:13:20Z');
    check('transfersOf: a System transfer', x.transfers.length === 1 && x.transfers[0].from === W && x.transfers[0].to === X && x.transfers[0].asset === 'native' && x.transfers[0].raw === '1000' && x.transfers[0].decimals === 9 && x.transfers[0].tx_hash === F.sig(1) && x.transfers[0].slot === 5);
}
{
    // Owners from postTokenBalances; the instruction names token accounts only.
    const t = F.tx({
        signature: F.sig(2),
        slot: 6,
        blockTime: 1700000000,
        keys: [W, WTA, XTA, F.TOKEN],
        ixs: [F.transferChecked(WTA, XTA, W, F.USDC, 5000000, 6)],
        post: [F.tokenBalance(1, F.USDC, W, 0, 6), F.tokenBalance(2, F.USDC, X, 5000000, 6)],
    });
    const x = tr.transfersOf(t);
    check('transfersOf: transferChecked between token accounts is between their owners', x.transfers.length === 1 && x.transfers[0].from === W && x.transfers[0].to === X && x.transfers[0].asset === F.USDC && x.transfers[0].symbol === 'USDC' && x.transfers[0].decimals === 6);
}
{
    // A token account created in the same transaction: owner from the ATA instruction, as the
    // balances of a closed-then-reopened account may not list it.
    const t = F.tx({
        signature: F.sig(3),
        slot: 7,
        blockTime: 1700000000,
        keys: [W, WTA, XTA, F.TOKEN, F.ATA],
        ixs: [F.ataCreate(W, XTA, X, F.USDC), F.transfer(WTA, XTA, W, 77)],
        pre: [F.tokenBalance(1, F.USDC, W, 100, 6)],
    });
    const x = tr.transfersOf(t);
    check('transfersOf: an owner named by the ATA create instruction resolves the destination', x.transfers.length === 1 && x.transfers[0].to === X && x.transfers[0].raw === '77' && x.transfers[0].decimals === 6);
}
{
    const t = F.tx({ signature: F.sig(4), slot: 8, blockTime: 1700000000, keys: [W, WTA, F.SYS, F.TOKEN], ixs: [F.createAccount(W, WTA, 2039280, F.TOKEN), F.createAccount(W, X, 1000000, F.SYS)] });
    const x = tr.transfersOf(t);
    check('transfersOf: createAccount reports the new account and its owner program', x.transfers.length === 2 && x.transfers[0].created_owner === F.TOKEN && x.transfers[1].created_owner === F.SYS);
}
{
    const t = F.tx({ signature: F.sig(5), slot: 9, blockTime: 1700000000, keys: [W, X], ixs: [F.sysTransfer(W, X, 0), F.sysTransfer(X, F.addr(3), 0), F.sysTransfer(W, W, 5)] });
    const x = tr.transfersOf(t, undefined, W);
    check('transfersOf: zero amounts are dropped, and counted only for the focus address', x.transfers.length === 0 && x.zero === 1);
}
{
    const t = F.tx({ signature: F.sig(6), slot: 9, blockTime: 1700000000, keys: [W, X], ixs: [F.sysTransfer(W, X, 5)], err: { InstructionError: [0, 'Custom'] } });
    check('transfersOf: a failed transaction moves nothing', tr.transfersOf(t).transfers.length === 0);
}
{
    // Plain `json` encoding: string account keys, loaded addresses continue the index.
    const t = {
        slot: 1,
        blockTime: 1700000000,
        transaction: { signatures: [F.sig(7)], message: { accountKeys: [W, F.TOKEN], instructions: [] } },
        meta: { err: null, loadedAddresses: { writable: [WTA], readonly: [XTA] } },
    };
    check('accountKeys: json form appends lookup-table addresses, writable then readonly', JSON.stringify(tr.accountKeys(t)) === JSON.stringify([W, F.TOKEN, WTA, XTA]));
}
{
    const t = F.tx({
        signature: F.sig(8),
        slot: 10,
        blockTime: 1700000000,
        keys: [X, F.addr(20), W, F.SYS],
        ixs: [F.ataCreate(X, F.addr(20), W, F.USDC), F.sysTransfer(X, W, 50000000), F.sysTransfer(F.addr(3), W, 1)],
    });
    const f = tr.fundingIn(t, W, '2023-11-14T22:13:20Z');
    check('fundingIn: the first SOL into the address in the transaction', f && f.from === X && f.raw === '50000000');
    const onlyToken = F.tx({ signature: F.sig(9), slot: 11, blockTime: 1700000000, keys: [X, F.addr(20), W, F.ATA], ixs: [F.ataCreate(X, F.addr(20), W, F.USDC)] });
    check('fundingIn: being named a token account owner is not funding', tr.fundingIn(onlyToken, W) === null);
    const created = F.tx({ signature: F.sig(10), slot: 12, blockTime: 1700000000, keys: [X, W], ixs: [F.createAccount(X, W, 2000000, 'Stake11111111111111111111111111111111111111')] });
    check('fundingIn: the createAccount that made the address is its funding', tr.fundingIn(created, W)?.from === X);
}

{
    // A Jupiter-shaped SOL → USDC swap: open the wallet's own wSOL account, send SOL into it,
    // syncNative, then the program swaps the wSOL to the pool and pays USDC back.
    const WSOL_TA = F.addr(21);
    const POOL = F.addr(22);
    const POOL_WSOL = F.addr(23);
    const POOL_USDC = F.addr(24);
    const W_USDC = F.addr(25);
    const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const swap = F.tx({
        signature: F.sig(11),
        slot: 13,
        blockTime: 1700000000,
        keys: [W, WSOL_TA, W_USDC, POOL_WSOL, POOL_USDC, POOL, F.SYS, F.TOKEN, F.ATA, JUP],
        ixs: [F.ataCreate(W, WSOL_TA, W, F.WSOL, 'createIdempotent'), F.sysTransfer(W, WSOL_TA, 1000000000), F.syncNative(WSOL_TA), { programId: JUP, accounts: [W], data: '3Bxs4' }],
        inner: [{ index: 3, instructions: [F.transferChecked(WSOL_TA, POOL_WSOL, W, F.WSOL, 1000000000, 9), F.transferChecked(POOL_USDC, W_USDC, POOL, F.USDC, 150000000, 6)] }],
        pre: [F.tokenBalance(3, F.WSOL, POOL, 5000000000000, 9), F.tokenBalance(4, F.USDC, POOL, 9000000000000, 6), F.tokenBalance(2, F.USDC, W, 0, 6)],
        post: [F.tokenBalance(1, F.WSOL, W, 0, 9), F.tokenBalance(3, F.WSOL, POOL, 5001000000000, 9), F.tokenBalance(4, F.USDC, POOL, 8999850000000, 6), F.tokenBalance(2, F.USDC, W, 150000000, 6)],
    });
    const x = tr.transfersOf(swap, undefined, W);
    check("transfersOf: SOL wrapped into the wallet's own wSOL account is no transfer, and is counted", !x.transfers.some((t) => t.to === WSOL_TA || t.asset === 'native') && x.wrapped === 1);
    check("transfersOf: the swap's wSOL and USDC legs stay, once each", x.transfers.length === 2 && x.transfers.some((t) => t.from === W && t.to === POOL && t.asset === F.WSOL && t.raw === '1000000000') && x.transfers.some((t) => t.from === POOL && t.to === W && t.asset === F.USDC));
    check('transfersOf: a wrap is counted only for the focus address', tr.transfersOf(swap, undefined, X).wrapped === 0);

    // SOL into ANOTHER wallet's wSOL account pays that wallet, and is not its own SOL.
    const X_WSOL = F.addr(26);
    const gift = F.tx({ signature: F.sig(12), slot: 14, blockTime: 1700000000, keys: [W, X_WSOL, F.SYS], ixs: [F.sysTransfer(W, X_WSOL, 5000), F.syncNative(X_WSOL)], post: [F.tokenBalance(1, F.WSOL, X, 5000, 9)] });
    const g = tr.transfersOf(gift).transfers;
    check("transfersOf: SOL into another wallet's wSOL account is a payment to its owner", g.length === 1 && g[0].from === W && g[0].to === X && g[0].asset === 'native' && g[0].via_token_account === X_WSOL);
    check("fundingIn: SOL into a token account the address owns is not the address's funding", tr.fundingIn(gift, X) === null);
    const anon = F.tx({ signature: F.sig(13), slot: 15, blockTime: 1640000000, keys: [W, X_WSOL, F.SYS], ixs: [F.sysTransfer(W, X_WSOL, 5000)], post: [F.tokenBalance(1, F.WSOL, null, 5000, 9)] });
    const xa = tr.transfersOf(anon);
    check("transfersOf: SOL into a token account whose owner is not named is unresolved, not a counterparty", xa.transfers.length === 0 && xa.unresolved === 1);
}
{
    // When the address first held SOL, from its balances.
    const closed = F.tx({ signature: F.sig(14), slot: 16, blockTime: 1600000000, keys: [X, XTA, W, F.TOKEN], ixs: [F.closeAccount(XTA, W, X)], balances: { [W]: [0, 2039280] } });
    const a = tr.activationIn(closed, W);
    check('activationIn: a closed token account paying out to a fresh wallet activates it, with no funder', a.state === 'activated' && a.funding === null && a.by === 'spl-token closeAccount');
    const paid = F.tx({ signature: F.sig(15), slot: 17, blockTime: 1600000000, keys: [X, W, F.SYS], ixs: [F.sysTransfer(X, W, 5000)], balances: { [W]: [0, 5000] } });
    const b = tr.activationIn(paid, W);
    check('activationIn: a System transfer that takes it from zero names the funder', b.state === 'activated' && b.funding?.from === X && b.funding.raw === '5000');
    const named = F.tx({ signature: F.sig(16), slot: 18, blockTime: 1600000000, keys: [X, F.addr(20), W, F.ATA], ixs: [F.ataCreate(X, F.addr(20), W, F.USDC)], balances: { [W]: [0, 0] } });
    check('activationIn: named but holding nothing is unfunded', tr.activationIn(named, W).state === 'unfunded');
    const later = F.tx({ signature: F.sig(17), slot: 19, blockTime: 1600000000, keys: [X, W, F.SYS], ixs: [F.sysTransfer(X, W, 5000)], balances: { [W]: [7, 5007] } });
    check('activationIn: SOL already there when the transaction began', tr.activationIn(later, W).state === 'already');
    check('activationIn: an address the transaction does not name is unknown', tr.activationIn(paid, F.addr(3)).state === 'unknown');
    const big = F.tx({ signature: F.sig(18), slot: 20, blockTime: 1600000000, keys: [X, W], ixs: [], balances: { [W]: ['0', '12345678901234567891'] } });
    check('activationIn: balances parsed past 2^53 (digit strings) are read', tr.activationIn(big, W).state === 'activated');
}

// ---- flows ------------------------------------------------------------------------------------

{
    const T = (n, from, to, raw, extra = {}) => ({ tx_hash: F.sig(n), time: `2026-01-0${n}T00:00:00Z`, slot: n, from, to, asset: 'native', symbol: 'SOL', decimals: 9, raw, ...extra });
    const ts = [T(1, W, X, '1000000000'), T(2, W, X, '500000000'), T(2, W, X, '1'), T(3, X, W, '7'), T(4, F.addr(3), F.addr(4), '9'), T(5, W, X, '5', { asset: F.USDC, symbol: 'USDC', decimals: 6 }), T(6, W, X, '5', { asset: F.addr(30), symbol: undefined, decimals: null })];
    const pairs = fl.aggregate(W, ts);
    const out = pairs.find((p) => p.from === W && p.to === X);
    check('aggregate: one pair per direction, busiest first, unrelated transfers ignored', pairs.length === 2 && pairs[0] === out);
    const sol = out.assets.find((a) => a.asset === 'native');
    check('aggregate: per-asset count, total, first, last', sol.count === 3 && sol.total === '1.500000001' && sol.first === '2026-01-01T00:00:00Z' && sol.last === '2026-01-02T00:00:00Z');
    check('aggregate: two transfers of one asset in one transaction are one recent row of the sum', out.recent.filter((r) => r.tx_hash === F.sig(2)).length === 1 && out.recent.find((r) => r.tx_hash === F.sig(2)).amount === '0.500000001');
    check('aggregate: recent is newest first', out.recent[0].tx_hash === F.sig(6));
    const unk = out.assets.find((a) => a.asset === F.addr(30));
    check('aggregate: unknown decimals keep base units and say so', unk.total === '5' && unk.base_units === true);
}
{
    const mine = Array.from({ length: 25 }, (_, i) => ({ tx_hash: `s${String(i).padStart(2, '0')}`, asset: 'native', amount: '1', time: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
    const theirs = [{ tx_hash: 'old', asset: 'native', amount: '2', time: '2020-01-01T00:00:00Z' }, { tx_hash: 's24', asset: 'native', amount: 'stale', time: '2026-02-25T00:00:00Z' }, 'junk', { asset: 'native' }];
    const m = fl.mergeRecent(theirs, mine);
    check('mergeRecent: capped at 20, newest first', m.length === 20 && m[0].tx_hash === 's24' && m[19].tx_hash === 's05');
    check('mergeRecent: our row replaces the same transaction and asset', m[0].amount === '1');
    const small = fl.mergeRecent(theirs, mine.slice(0, 2));
    check('mergeRecent: rows the link had are kept; junk rows dropped', small.length === 4 && small.some((r) => r.tx_hash === 'old'));
    const cased = fl.mergeRecent([{ tx_hash: 'AbC', asset: 'native', amount: '1', time: '2026-01-01T00:00:00Z' }], [{ tx_hash: 'abc', asset: 'native', amount: '2', time: '2026-01-02T00:00:00Z' }]);
    check('mergeRecent: Base58 hashes are compared exactly (case is part of the value)', cased.length === 2);
}

// ---- attribution --------------------------------------------------------------------------------

check('ownerName: "Binance 1" → Binance', at.ownerName('Binance 1') === 'Binance');
check('ownerName: "Bybit Hot Wallet" → Bybit', at.ownerName('Bybit Hot Wallet') === 'Bybit');
check('ownerName: "OKX Exchange 1" is OKX for an exchange, kept for anything else', at.ownerName('OKX Exchange 1', true) === 'OKX' && at.ownerName('OKX Exchange 1') === 'OKX Exchange');
check('ownerName: "OKX Hot Wallet" and "OKX Exchange 1" meet on one exchange', at.targetFor('OKX Hot Wallet', 'Centralized Exchange')?.data.name === 'OKX' && at.targetFor('OKX Exchange 1', 'Centralized Exchange')?.data.name === 'OKX');
check('ownerName: an exchange named only "Exchange" keeps its name', at.ownerName('Exchange 1', true) === 'Exchange');
check('ownerName: "Kraken" unchanged', at.ownerName('Kraken') === 'Kraken');
check('ownerName: never empties a name', at.ownerName('Wallet') === 'Wallet');
check('targetFor: Centralized Exchange → financial.exchange', at.targetFor('Coinbase 1', 'Centralized Exchange', 'exchange')?.type === 'financial.exchange');
check('targetFor: funderType "exchange" alone → financial.exchange', at.targetFor('Coinbase 2', undefined, 'exchange')?.data.name === 'Coinbase');
check('targetFor: bridge, DeFi, casino → crypto_service of that kind', at.targetFor('Wormhole Bridge', 'Cross-chain Bridge')?.data.service_type === 'bridge' && at.targetFor('Jupiter', 'DeFi')?.data.service_type === 'defi' && at.targetFor('Rollbit', 'Casino & Gambling')?.data.service_type === 'gambling' && at.targetFor('Marinade', undefined, 'defi-protocol')?.data.service_type === 'defi');
check('targetFor: market maker → organization (company)', at.targetFor('Wintermute', 'Market Maker')?.type === 'identity.organization');
// Helius's documented category examples (wallet-api/identity, "Identity categories"), and numbered
// variants of them: an owner's wallets meet on one owner node.
check('targetFor: "Stake.com Hot Wallet" is the Crypto Service Stake.com', at.targetFor('Stake.com Hot Wallet', 'Casino & Gambling')?.data.name === 'Stake.com');
check('targetFor: "Wintermute 2" is the Organization Wintermute', at.targetFor('Wintermute 2', 'Market Maker')?.data.name === 'Wintermute' && at.targetFor('Jump Trading', 'Market Maker')?.data.name === 'Jump Trading');
check('targetFor: documented names without a wallet ending are kept as written', ['Binance 1', 'Coinbase 1', 'Kraken', 'Bybit Hot Wallet'].map((n) => at.targetFor(n, 'Centralized Exchange')?.data.name).join('|') === 'Binance|Coinbase|Kraken|Bybit' && at.targetFor('Rollbit', 'Casino & Gambling')?.data.name === 'Rollbit' && at.targetFor('Wormhole Bridge', 'Cross-chain Bridge')?.data.name === 'Wormhole Bridge');
check('targetFor: a claim about the address is not an owner', at.targetFor('Fake Airdrop Scammer', 'Scammer') === null && at.targetFor('Mango Exploiter', 'Exploiter, Hackers & Scams') === null);
check('targetFor: a person is not attributed (names alone would merge strangers)', at.targetFor('toly', 'Key Opinion Leader', 'wallet') === null);
check('targetFor: infrastructure labels are not owners', at.targetFor('Jito Tip 1', 'Jito') === null && at.targetFor('Coinbase Validator', 'Validator') === null);

for (const n of fail) console.log('FAIL', n);
console.log(`\n${fail.length ? 'FAIL' : 'PASS'} ${ok.length} / ${ok.length + fail.length}`);
if (fail.length) process.exit(1);
