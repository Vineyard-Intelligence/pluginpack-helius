// Mock tests for the Helius pack — no network, no app.
//   Run: node test-plugin.mjs [bundle]      (and node test/pure.test.mjs for the pure modules)
//
// Response shapes come from Helius's and Solana's public documentation, not from recorded answers:
// see test/fixtures.mjs for what each is built from. The API key here is a placeholder; a real key
// never comes near this file.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as F from './test/fixtures.mjs';

const pack = (await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : './dist/pack.mjs')).default;
const P = Object.fromEntries(pack.plugins.map((p) => [p.manifest.identifier.replace('run.vineyard.plugins.helius_', ''), p]));

const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);

const KEY_VALUE = 'test-key-not-real-0000';
const KEY = { api_key: `  ${KEY_VALUE}  ` };
const ADDRESS = 'cryptocurrency.crypto_address';

const node = (id, address, network = 'solana', extra = {}) => ({ id, type: ADDRESS, data: { network, address, ...extra } });

// ---- the mock host ---------------------------------------------------------------------------

/**
 * `edgeData`: whether edges() hands back each link's data. The app does (host-bridge.ts toEdge,
 * frontend main 2026-11-16), so the default is the app's; false is an older app, whose toEdge gave
 * id, endpoints and label only.
 */
function makeGraph(nodeById, edges = [], { edgeData = true } = {}) {
    const createdNodes = [];
    const createdEdges = [];
    const updatedEdges = [];
    const updates = [];
    // Mirrors the host's de-dup closely enough for these tests: same type and identity → same node.
    const idOf = (t, d) => (t === ADDRESS ? `${d.network}|${d.address}|${d.memo ?? ''}` : d?.name);
    return {
        createdNodes,
        createdEdges,
        updatedEdges,
        updates,
        async get(id) {
            return nodeById[id] || null;
        },
        async list(o) {
            const all = Object.values(nodeById);
            return { nodes: o?.type ? all.filter((n) => n.type === o.type) : all };
        },
        async edges() {
            return edges.map((e) => (edgeData ? structuredClone(e) : { id: e.id, from_node_id: e.from_node_id, to_node_id: e.to_node_id, label: e.label }));
        },
        async createNode(d) {
            const k = idOf(d.type, d.data);
            const existing = [...Object.values(nodeById), ...createdNodes].find((n) => n.type === d.type && idOf(n.type, n.data) === k);
            if (existing) return { ...existing, data: { ...existing.data, ...d.data } };
            const n = { id: `n${createdNodes.length + 1}`, type: d.type, data: d.data };
            createdNodes.push(n);
            return n;
        },
        async updateNode(id, data) {
            updates.push({ id, data });
        },
        async createEdge(e) {
            createdEdges.push(e);
        },
        async updateEdge(id, patch) {
            updatedEdges.push({ id, ...patch });
        },
    };
}

/** respond(call) → { status, body } (body an object, serialised) or { status, text }. */
function makeNet(respond) {
    const calls = [];
    return {
        calls,
        async fetch(url, init) {
            const body = init?.body ? JSON.parse(init.body) : null;
            const call = { url, method: init?.method, headers: init?.headers ?? {}, body, rawBody: init?.body ?? '' };
            calls.push(call);
            const r = respond(call);
            const text = r.text ?? JSON.stringify(r.body ?? {});
            return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: r.headers ?? {}, async text() { return text; }, async json() { return JSON.parse(text); } };
        },
    };
}
const ctxFor = ({ nodes = {}, edges = [], edgeData = true, selection = Object.keys(nodes), respond = () => ({ status: 500 }), config = KEY, params = {}, platform = 'web' }) => {
    const graph = makeGraph(nodes, edges, { edgeData });
    const net = makeNet(respond);
    const logs = [];
    const ctx = { run: { platform }, config, params, input: { selection }, graph, net, progress: { set() {}, log: (m) => logs.push(m) }, signal: new AbortController().signal };
    return { ctx, graph, net, logs };
};
const run = async (p, t) => {
    try {
        return await p.run(t.ctx);
    } catch (e) {
        return { error: e };
    }
};
const isRpc = (c) => c.url.startsWith('https://mainnet.helius-rpc.com/');
const rpcMethod = (c) => (isRpc(c) ? c.body?.method : null);
const OK = (c, result) => ({ status: 200, body: F.rpcResult(c.body.id, result) });
const balance = (c, lamports = 1500000000) => OK(c, { context: { slot: 300000000 }, value: lamports });

/** Everything the plugin said or sent, for the "the key never leaks" checks. */
const everything = (t, r) => JSON.stringify({ summary: r?.summary, error: r?.error?.message, logs: t.logs, nodes: t.graph.createdNodes, updates: t.graph.updates, edges: t.graph.createdEdges, updated: t.graph.updatedEdges });

// ---- manifest invariants -----------------------------------------------------------------------

{
    const origins = (m) => [...new Set(m.scopes.network.map((n) => new URL(n.endpoint).origin))].sort().join(' ');
    const sets = new Set(pack.plugins.map((p) => origins(p.manifest)));
    // One slot for the key (config-slot.ts files settings by pack + origin set): a member that
    // declared a different set would ask for the same key again.
    check('manifest: every member declares the same network origins', sets.size === 1 && [...sets][0] === 'https://api.helius.xyz https://mainnet.helius-rpc.com');
    check('manifest: the key is one secret, required, named api_key, in every member', pack.plugins.every((p) => p.manifest.scopes.config.length === 1 && p.manifest.scopes.config[0].key === 'api_key' && p.manifest.scopes.config[0].secret === true && p.manifest.scopes.config[0].optional === false));
    check('manifest: every member reads links before writing them (edge:read)', pack.plugins.every((p) => p.manifest.scopes.graph.includes('edge:read') && p.manifest.scopes.graph.includes('edge:create') && !p.manifest.scopes.graph.some((s) => s.endsWith(':delete'))));
    check('manifest: identifiers end in [a-z0-9_]+', /^run\.vineyard\.pluginpacks\.[a-z0-9_]+$/.test(pack.identifier) && pack.plugins.every((p) => /^run\.vineyard\.plugins\.[a-z0-9_]+$/.test(p.manifest.identifier)));
    check('manifest: every member consumes crypto_address from the Cryptocurrency pack', pack.plugins.every((p) => p.manifest.io.consumes.length === 1 && p.manifest.io.consumes[0].typepack === 'run.vineyard.typepacks.cryptocurrency' && p.manifest.io.consumes[0].name === 'crypto_address'));
    check('manifest: web and desktop, web first (CORS * measured)', pack.plugins.every((p) => p.manifest.platforms.primary === 'web' && p.manifest.platforms.web && p.manifest.platforms.desktop));
    check('manifest: member descriptions fit the 1024-character cap', pack.plugins.every((p) => p.manifest.description.length <= 1024));
    check(`manifest: summary fits 250 characters, the page 1,500 (${pack.description.length})`, pack.summary.length <= 250 && pack.description.length <= 1500);
    check('manifest: pack and members are 1.0.0', pack.version === '1.0.0' && pack.plugins.every((p) => p.manifest.version === '1.0.0'));
}

// ---- Solana Address History --------------------------------------------------------------------

const SEED = 'HXsKP7wrBWaQ8T2Vtjry3Nj3oUgwYcqq9vrHDM12G664';
const ALICE = F.addr(1);
const BOB = F.addr(2);
const CAROL = F.addr(3);
const SEED_USDC = F.addr(10); // the seed's USDC token account
const BOB_USDC = F.addr(11);
const CAROL_TA = F.addr(12);
const NEW_TA = F.addr(13);

// Newest first, as sortOrder "desc" returns them.
const HISTORY = [
    // 3. The seed pays Alice 1.5 SOL.
    F.tx({ signature: F.sig(3), slot: 300, blockTime: 1767225600, keys: [SEED, ALICE, F.SYS], ixs: [F.sysTransfer(SEED, ALICE, 1500000000)] }),
    // 2. Bob pays the seed 25 USDC, token account to token account; owners only in the balances.
    F.tx({
        signature: F.sig(2),
        slot: 200,
        blockTime: 1764547200,
        keys: [BOB, BOB_USDC, SEED_USDC, F.TOKEN],
        ixs: [F.transferChecked(BOB_USDC, SEED_USDC, BOB, F.USDC, 25000000, 6)],
        pre: [F.tokenBalance(1, F.USDC, BOB, 100000000, 6), F.tokenBalance(2, F.USDC, SEED, 0, 6)],
        post: [F.tokenBalance(1, F.USDC, BOB, 75000000, 6), F.tokenBalance(2, F.USDC, SEED, 25000000, 6)],
    }),
    // 1. The seed opens a token account (rent, not a payment) and, in an inner instruction, pays
    //    Carol 0.25 SOL; a zero-amount poisoning transfer from Carol rides along.
    F.tx({
        signature: F.sig(1),
        slot: 100,
        blockTime: 1761955200,
        keys: [SEED, NEW_TA, CAROL, F.SYS, F.TOKEN],
        ixs: [F.createAccount(SEED, NEW_TA, 2039280, F.TOKEN), { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [SEED], data: '3Bxs4' }],
        inner: [{ index: 1, instructions: [F.sysTransfer(SEED, CAROL, 250000000), F.sysTransfer(CAROL, SEED, 0)] }],
    }),
];

{
    const nodes = { s: node('s', SEED) };
    const t = ctxFor({
        nodes,
        respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page(HISTORY, null))),
    });
    const r = await run(P.address_history, t);
    check('history: runs', !r.error && /1 of 1 Solana address\(es\) read/.test(r.summary));
    const gt = t.net.calls.find((c) => rpcMethod(c) === 'getTransactionsForAddress');
    const opts = gt?.body?.params?.[1] ?? {};
    check('history: asks for full jsonParsed transactions, newest first', gt?.body?.params?.[0] === SEED && opts.transactionDetails === 'full' && opts.encoding === 'jsonParsed' && opts.sortOrder === 'desc');
    check('history: includes v0 transactions (maxSupportedTransactionVersion set)', opts.maxSupportedTransactionVersion === 1);
    check("history: token accounts on by default (balanceChanged), successful transactions only", opts.filters?.tokenAccounts === 'balanceChanged' && opts.filters?.status === 'succeeded');
    check('history: the key rides only in the RPC query string', t.net.calls.filter(isRpc).every((c) => new URL(c.url).searchParams.get('api-key') === KEY_VALUE && !JSON.stringify(c.headers).includes(KEY_VALUE) && !c.rawBody.includes(KEY_VALUE)));

    const byAddr = Object.fromEntries(t.graph.createdNodes.map((n) => [n.data.address, n]));
    check('history: counterparties become Solana Crypto Addresses', ['solana'].includes(byAddr[ALICE]?.data.network) && byAddr[BOB] && byAddr[CAROL] && byAddr[ALICE].type === ADDRESS);
    check('history: a token account the seed opened is not a counterparty', !byAddr[NEW_TA] && /1 rent payment/.test(r.summary));
    const edge = (from, to) => t.graph.createdEdges.find((e) => e.from === from && e.to === to);
    const toAlice = edge('s', byAddr[ALICE]?.id);
    check("history: seed 'sent to' Alice with summary_helius native 1.5", toAlice?.label === 'sent to' && toAlice.data.network === 'solana' && toAlice.data.summary_helius.assets[0].asset === 'native' && toAlice.data.summary_helius.assets[0].symbol === 'SOL' && toAlice.data.summary_helius.assets[0].total === '1.5' && toAlice.data.summary_helius.assets[0].count === 1);
    check('history: the summary states its window and that it is complete', toAlice?.data.summary_helius.window_from === '2025-11-01T00:00:00Z' && toAlice.data.summary_helius.complete === true && /Z$/.test(toAlice.data.summary_helius.window_to));
    check('history: recent row for the Alice payment', toAlice?.data.recent.length === 1 && toAlice.data.recent[0].tx_hash === F.sig(3) && toAlice.data.recent[0].amount === '1.5' && toAlice.data.recent[0].time === '2026-01-01T00:00:00Z');
    const fromBob = edge(byAddr[BOB]?.id, 's');
    check("history: Bob 'sent to' the seed 25 USDC, found through token accounts", fromBob?.data.summary_helius.assets[0].asset === F.USDC && fromBob.data.summary_helius.assets[0].symbol === 'USDC' && fromBob.data.summary_helius.assets[0].total === '25');
    const toCarol = edge('s', byAddr[CAROL]?.id);
    check('history: an inner (CPI) transfer counts', toCarol?.data.summary_helius.assets[0].total === '0.25');
    check('history: a zero-amount transfer makes no link, and is counted', !edge(byAddr[CAROL]?.id, 's') && /1 zero-amount transfer/.test(r.summary));
    const upd = t.graph.updates.find((u) => u.id === 's')?.data ?? {};
    check('history: seed gets balance, last_seen, first_seen and history fields', upd.balance === '1.5' && upd.balance_source === 'Helius RPC getBalance' && upd.last_seen === '2026-01-01T00:00:00Z' && upd.first_seen === '2025-11-01T00:00:00Z' && upd.history_examined === 3 && upd.history_complete === true);
    check('history: the key appears nowhere it could be read back', !everything(t, r).includes(KEY_VALUE));
    check('history: the summary names the credit cost', /about 11 credit/.test(r.summary));
}

{
    // Paging stops at the limit: history_complete false, no first_seen, and the summary says so.
    const pages = [F.page(HISTORY.slice(0, 1), '250:0'), F.page(HISTORY.slice(1), null)];
    let i = 0;
    const t = ctxFor({
        nodes: { s: node('s', SEED) },
        params: { max_transactions: 100 },
        respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, pages[i++])),
    });
    const r = await run(P.address_history, t);
    const upd = t.graph.updates.find((u) => u.id === 's')?.data ?? {};
    // max_transactions 100 with one transaction on the first page: the token says there is more, so
    // the second page is asked for, carrying the token.
    const gts = t.net.calls.filter((c) => rpcMethod(c) === 'getTransactionsForAddress');
    check('history: follows paginationToken', gts.length === 2 && gts[1].body.params[1].paginationToken === '250:0' && !('paginationToken' in gts[0].body.params[1]));
    check('history: a full read is complete', upd.history_complete === true && upd.history_examined === 3);
    const pages2 = [F.page(HISTORY.slice(0, 1), '250:0')];
    let j = 0;
    const t2 = ctxFor({
        nodes: { s: node('s', SEED) },
        params: { max_transactions: 1 }, // clamped to the minimum of 100: page asks for 100
        respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, j++ === 0 ? F.page(Array.from({ length: 100 }, () => HISTORY[0]), '1:0') : F.page([], null))),
    });
    const r2 = await run(P.address_history, t2);
    const upd2 = t2.graph.updates.find((u) => u.id === 's')?.data ?? {};
    check('history: stopping at the limit leaves history_complete false and no first_seen', upd2.history_complete === false && !('first_seen' in upd2) && upd2.history_examined === 100 && /history_complete: false/.test(r2.summary));
    check('history: the limit is clamped to its minimum of 100 per request', t2.net.calls.filter((c) => rpcMethod(c) === 'getTransactionsForAddress').length === 1 && t2.net.calls.find((c) => rpcMethod(c) === 'getTransactionsForAddress').body.params[1].limit === 100);
    void pages2;
    void r;
}

{
    // An existing link is amended by id, never relabelled. An older app did not pass a link's
    // data, so its `recent` list could not be merged with this run's rows and is left as it is:
    // commit replaces a top-level key whole, and this run's one row would replace the twenty the
    // link holds.
    const nodes = { s: node('s', SEED), a: node('a', ALICE) };
    const old = Array.from({ length: 20 }, (_, k) => ({ tx_hash: F.sig(100 + k), asset: 'native', symbol: 'SOL', amount: '3', time: `2025-01-${String(k + 1).padStart(2, '0')}T00:00:00Z` }));
    const edges = [{ id: 'e1', from_node_id: 's', to_node_id: 'a', label: 'paid', data: { recent: old, summary_blockscout: { complete: true } } }];
    const respond = (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page(HISTORY.slice(0, 1), null)));
    const t = ctxFor({ nodes, edges, edgeData: false, selection: ['s'], respond });
    const r = await run(P.address_history, t);
    const u = t.graph.updatedEdges.find((e) => e.id === 'e1');
    check("history: an existing link is amended with updateEdge, label untouched", !!u && u.label === undefined && !t.graph.createdEdges.some((e) => e.from === 's' && e.to === 'a'));
    check("history: a link whose data an older app does not pass keeps its recent list (no recent sent)", !!u && !('recent' in u.data) && 'summary_helius' in u.data && /1 existing link\(s\) kept the recent list they had/.test(r.summary));
    check("history: …and the summary says why without blaming the app as it is now", /their data was not passed to this run \(an older Vineyard does not pass a link's data to plugins\)/.test(r.summary) && !/the app does not pass/.test(r.summary));
    check("history: another source's summary key is not sent (commit merges top-level keys)", u && !('summary_blockscout' in u.data));
    check('history: no second node for an address already in the project', t.graph.createdNodes.length === 0 && /1 existing link/.test(r.summary));
    // The app as it is now passes the link's data, so it gets the merge: the twenty rows plus ours,
    // capped at 20.
    const t2 = ctxFor({ nodes, edges, selection: ['s'], respond });
    const r2 = await run(P.address_history, t2);
    const u2 = t2.graph.updatedEdges.find((e) => e.id === 'e1');
    check('history: with the link data in hand, recent keeps its rows and adds ours, newest first', u2?.data.recent.length === 20 && u2.data.recent[0].tx_hash === F.sig(3) && u2.data.recent[1].tx_hash === F.sig(119) && !/kept the recent list/.test(r2.summary));
}

{
    // A re-run refreshes the links an earlier run drew: the second run reads a later payment from
    // Bob, and the Bob → seed link gets it in `recent` beside the row it held, with a new summary.
    const first = ctxFor({ nodes: { s: node('s', SEED) }, respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page(HISTORY.slice(1), null))) });
    await run(P.address_history, first);
    const later = F.tx({ signature: F.sig(4), slot: 400, blockTime: 1767312000, keys: [BOB, SEED, F.SYS], ixs: [F.sysTransfer(BOB, SEED, 2000000000)] });
    // Commit lands the first run's nodes and links in the project (under ids of their own), with the
    // data they were drawn with.
    const id = (x) => (x === 's' ? 's' : `live-${x}`);
    const nodes = { s: node('s', SEED) };
    for (const n of first.graph.createdNodes) nodes[id(n.id)] = { ...n, id: id(n.id) };
    const bob = Object.values(nodes).find((n) => n.data.address === BOB);
    const drawn = first.graph.createdEdges.map((e, i) => ({ id: `d${i}`, from_node_id: id(e.from), to_node_id: id(e.to), label: e.label, data: structuredClone(e.data) }));
    const before = drawn.find((e) => e.from_node_id === bob.id && e.to_node_id === 's');
    const t = ctxFor({ nodes, edges: drawn, selection: ['s'], respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page([later, ...HISTORY], null))) });
    const r = await run(P.address_history, t);
    check("history: a re-run draws the new pair and no second link for the old ones", t.graph.createdEdges.length === 1 && t.graph.createdEdges.every((e) => !drawn.some((d) => d.from_node_id === e.from && d.to_node_id === e.to)) && t.graph.updatedEdges.length === drawn.length);
    const fromBob = t.graph.updatedEdges.find((u) => u.id === before.id);
    check("history: a re-run adds the new transfer to an existing link's recent list, keeping the row it held", fromBob?.data.recent.length === 2 && fromBob.data.recent[0].tx_hash === F.sig(4) && fromBob.data.recent[1].tx_hash === before.data.recent[0].tx_hash && fromBob.label === undefined);
    check("history: …and its summary_helius counts both payments", fromBob?.data.summary_helius.assets.length === 2 && before.data.summary_helius.assets.length === 1);
    check('history: a re-run on the app as it is now says nothing about kept lists', !/kept the recent list/.test(r.summary) && /2 existing link\(s\) given Helius's figures/.test(r.summary));
}

{
    // SPL `transfer` (unchecked): mint and decimals come from the token balances. A token transfer
    // whose owners the transaction does not name (before December 2022) is left out and counted.
    const tUnchecked = F.tx({
        signature: F.sig(4),
        slot: 400,
        blockTime: 1767225600,
        keys: [SEED, SEED_USDC, BOB_USDC, F.TOKEN],
        ixs: [F.transfer(SEED_USDC, BOB_USDC, SEED, 1234567)],
        pre: [F.tokenBalance(1, F.USDC, SEED, 5000000, 6), F.tokenBalance(2, F.USDC, BOB, 0, 6)],
        post: [F.tokenBalance(1, F.USDC, SEED, 3765433, 6), F.tokenBalance(2, F.USDC, BOB, 1234567, 6)],
    });
    const tOld = F.tx({
        signature: F.sig(5),
        slot: 50,
        blockTime: 1640995200,
        keys: [SEED, SEED_USDC, CAROL_TA, F.TOKEN],
        ixs: [F.transfer(SEED_USDC, CAROL_TA, SEED, 1000)],
        pre: [F.tokenBalance(1, F.USDC, null, 5000, 6), F.tokenBalance(2, F.USDC, null, 0, 6)],
        post: [F.tokenBalance(1, F.USDC, null, 4000, 6), F.tokenBalance(2, F.USDC, null, 1000, 6)],
    });
    const t = ctxFor({ nodes: { s: node('s', SEED) }, respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page([tUnchecked, tOld], null))) });
    const r = await run(P.address_history, t);
    const bob = t.graph.createdNodes.find((n) => n.data.address === BOB);
    const e = t.graph.createdEdges.find((x) => x.from === 's' && x.to === bob?.id);
    check('history: an unchecked SPL transfer takes mint and decimals from the token balances', e?.data.summary_helius.assets[0].asset === F.USDC && e.data.summary_helius.assets[0].total === '1.234567');
    check('history: a token transfer with unnamed owners is left out and counted', t.graph.createdNodes.length === 1 && /1 token transfer\(s\) in these transactions could not be tied to wallets/.test(r.summary));
}

{
    // A SOL → USDC swap, Jupiter-shaped: the seed wraps SOL into its own wSOL account, the program
    // pays the wSOL to the pool and USDC back. The seed's own token account is no counterparty.
    const WSOL_TA = F.addr(80);
    const POOL = F.addr(81);
    const POOL_WSOL = F.addr(82);
    const POOL_USDC = F.addr(83);
    const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const swap = (n, slot) =>
        F.tx({
            signature: F.sig(n),
            slot,
            blockTime: 1767225600 + slot,
            keys: [SEED, WSOL_TA, SEED_USDC, POOL_WSOL, POOL_USDC, POOL, F.SYS, F.TOKEN, F.ATA, JUP],
            ixs: [F.ataCreate(SEED, WSOL_TA, SEED, F.WSOL, 'createIdempotent'), F.sysTransfer(SEED, WSOL_TA, 1000000000), F.syncNative(WSOL_TA), { programId: JUP, accounts: [SEED], data: '3Bxs4' }],
            inner: [{ index: 3, instructions: [F.transferChecked(WSOL_TA, POOL_WSOL, SEED, F.WSOL, 1000000000, 9), F.transferChecked(POOL_USDC, SEED_USDC, POOL, F.USDC, 150000000, 6)] }],
            pre: [F.tokenBalance(3, F.WSOL, POOL, 5000000000000, 9), F.tokenBalance(4, F.USDC, POOL, 9000000000000, 6), F.tokenBalance(2, F.USDC, SEED, 0, 6)],
            post: [F.tokenBalance(1, F.WSOL, SEED, 0, 9), F.tokenBalance(3, F.WSOL, POOL, 5001000000000, 9), F.tokenBalance(4, F.USDC, POOL, 8999850000000, 6), F.tokenBalance(2, F.USDC, SEED, 150000000, 6)],
        });
    const t = ctxFor({ nodes: { s: node('s', SEED) }, respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page([swap(60, 3), swap(61, 2), swap(62, 1)], null))) });
    const r = await run(P.address_history, t);
    const byAddr = Object.fromEntries(t.graph.createdNodes.map((n) => [n.data.address, n]));
    check("history: SOL wrapped into the seed's own wSOL account makes no node and no link", !byAddr[WSOL_TA] && t.graph.createdEdges.length === 2 && /3 SOL wrap\(s\) into the address's own wSOL token account not counted/.test(r.summary));
    const toPool = t.graph.createdEdges.find((e) => e.from === 's' && e.to === byAddr[POOL]?.id);
    check('history: the swapped SOL is counted once, as the wSOL paid to the pool', toPool?.data.summary_helius.assets.length === 1 && toPool.data.summary_helius.assets[0].asset === F.WSOL && toPool.data.summary_helius.assets[0].total === '3');
}

{
    // A failed transaction moves nothing, even if Helius's status filter let one through.
    const failed = F.tx({ signature: F.sig(6), slot: 600, blockTime: 1767225600, keys: [SEED, ALICE, F.SYS], ixs: [F.sysTransfer(SEED, ALICE, 1000)], err: { InstructionError: [0, 'Custom'] } });
    const t = ctxFor({ nodes: { s: node('s', SEED) }, respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page([failed], null))) });
    await run(P.address_history, t);
    check('history: a failed transaction makes no link', t.graph.createdEdges.length === 0);
}

{
    // A lamport amount above 2^53 survives parsing digit for digit.
    const big = F.tx({ signature: F.sig(7), slot: 700, blockTime: 1767225600, keys: [SEED, ALICE, F.SYS], ixs: [F.sysTransfer(SEED, ALICE, '__BIG__')] });
    const t = ctxFor({
        nodes: { s: node('s', SEED) },
        respond: (c) =>
            rpcMethod(c) === 'getBalance'
                ? { status: 200, text: `{"jsonrpc":"2.0","id":${c.body.id},"result":{"context":{"slot":1},"value":12345678901234567890}}` }
                : { status: 200, text: JSON.stringify(F.rpcResult(c.body.id, F.page([big], null))).replace('"__BIG__"', '12345678901234567891') },
    });
    await run(P.address_history, t);
    const e = t.graph.createdEdges[0];
    const upd = t.graph.updates.find((u) => u.id === 's')?.data ?? {};
    check('history: a transfer above 2^53 lamports keeps every digit', e?.data.summary_helius.assets[0].total === '12345678901.234567891');
    check('history: a balance above 2^53 lamports keeps every digit', upd.balance === '12345678901.23456789');
}

{
    // Counterparty cap: the busiest pairs are linked, the rest counted.
    const many = [];
    for (let k = 0; k < 5; k++) many.push(F.tx({ signature: F.sig(20 + k), slot: 900 - k, blockTime: 1767225600 - k, keys: [SEED, F.addr(40 + k), F.SYS], ixs: [F.sysTransfer(SEED, F.addr(40 + k), 1000 + k)] }));
    many.push(F.tx({ signature: F.sig(30), slot: 800, blockTime: 1767220000, keys: [SEED, F.addr(44), F.SYS], ixs: [F.sysTransfer(SEED, F.addr(44), 7)] }));
    const t = ctxFor({ nodes: { s: node('s', SEED) }, params: { max_counterparties: 1 }, respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page(many, null))) });
    const r = await run(P.address_history, t);
    check('history: max_counterparties keeps the busiest pair', t.graph.createdEdges.length === 1 && t.graph.createdNodes[0].data.address === F.addr(44) && /4 quieter counterparties not linked/.test(r.summary));
}

{
    // Token accounts off: Helius's filter is `none`.
    const t = ctxFor({ nodes: { s: node('s', SEED) }, params: { token_accounts: false }, respond: (c) => (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page([], null))) });
    await run(P.address_history, t);
    check("history: 'Include token accounts' off asks with tokenAccounts none", t.net.calls.find((c) => rpcMethod(c) === 'getTransactionsForAddress')?.body.params[1].filters.tokenAccounts === 'none');
}

{
    // What is not looked up: other networks, malformed values, other types. Nothing is requested.
    const nodes = { e: node('e', '0x8d53903625b8e839b9df4bd28b0efb1cd6b8639a', 'ethereum'), m: node('m', 'not-a-solana-address'), d: { id: 'd', type: 'infrastructure.domain', data: { domain_name: 'example.com' } } };
    const t = ctxFor({ nodes });
    const r = await run(P.address_history, t);
    check('history: nothing to look up costs nothing and says why', !r.error && t.net.calls.length === 0 && /No Solana address was selected/.test(r.summary) && /1 Crypto Address\(es\) are not on network solana/.test(r.summary) && /1 on network solana are not Solana addresses/.test(r.summary) && /1 selected node\(s\) are not Crypto Addresses/.test(r.summary));
}

{
    // No key: refused before any request.
    const t = ctxFor({ nodes: { s: node('s', SEED) }, config: {} });
    const r = await run(P.address_history, t);
    check('history: no key fails the run before any request', !!r.error && /Helius API key is not set/.test(r.error.message) && t.net.calls.length === 0);
}

{
    // A refused key (MEASURED: HTTP 401, text "Unauthorized") fails the run when nothing was found…
    const t = ctxFor({ nodes: { s: node('s', SEED) }, respond: () => ({ status: 401, text: 'Unauthorized' }) });
    const r = await run(P.address_history, t);
    check('history: a refused key fails the run, without the key in the message', !!r.error && /HTTP 401/.test(r.error.message) && !r.error.message.includes(KEY_VALUE) && !r.error.message.includes('api-key'));
    // …and stops it, keeping what was found, when it comes later.
    let n = 0;
    const t2 = ctxFor({
        nodes: { s: node('s', SEED), s2: node('s2', BOB) },
        respond: (c) => (n++ < 2 ? (rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page(HISTORY.slice(0, 1), null))) : { status: 401, text: 'Unauthorized' }),
    });
    const r2 = await run(P.address_history, t2);
    check('history: a refusal after results returns them with a STOPPED line', !r2.error && /STOPPED: Helius refused the API key/.test(r2.summary) && t2.graph.createdEdges.length === 1);
}

{
    // 429 is retried with a wait (Retry-After honoured), then the run goes on.
    let n = 0;
    const t = ctxFor({
        nodes: { s: node('s', SEED) },
        respond: (c) => (n++ === 0 ? { status: 429, headers: { 'retry-after': '0.01' }, text: '' } : rpcMethod(c) === 'getBalance' ? balance(c) : OK(c, F.page([], null))),
    });
    const r = await run(P.address_history, t);
    check('history: a 429 is waited out and retried', !r.error && t.logs.some((l) => /rate-limiting/.test(l)) && /1 of 1 Solana address/.test(r.summary));
}

{
    // A JSON-RPC error for one address fails that address only.
    const t = ctxFor({
        nodes: { s: node('s', SEED), s2: node('s2', BOB) },
        respond: (c) =>
            rpcMethod(c) === 'getBalance'
                ? balance(c)
                : c.body.params[0] === SEED
                  ? { status: 200, body: { jsonrpc: '2.0', id: c.body.id, error: { code: -32602, message: 'Invalid params' } } }
                  : OK(c, F.page([], null)),
    });
    const r = await run(P.address_history, t);
    check('history: an RPC error fails one address, not the run', !r.error && /1 of 2 Solana address/.test(r.summary) && /1 lookup\(s\) failed/.test(r.summary) && t.logs.some((l) => /Invalid params/.test(l)));
}

// ---- Solana First Funder -----------------------------------------------------------------------

const FUNDED = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const FUNDER = F.FUNDED_BY_DOC.funder;
const isWallet = (c) => c.url.startsWith('https://api.helius.xyz/v1/wallet/');

{
    // Paid plan: funded-by answers.
    const t = ctxFor({
        nodes: { f: node('f', FUNDED) },
        respond: (c) => (isWallet(c) ? { status: 200, body: { ...F.FUNDED_BY_DOC, funderName: 'Coinbase 2', funderType: 'exchange' } } : { status: 500 }),
    });
    const r = await run(P.first_funder, t);
    const call = t.net.calls[0];
    check('funder: asks funded-by with the key in X-Api-Key, not the URL', isWallet(call) && call.url === `https://api.helius.xyz/v1/wallet/${FUNDED}/funded-by` && call.headers['X-Api-Key'] === KEY_VALUE && !call.url.includes(KEY_VALUE) && call.method === 'GET');
    const upd = t.graph.updates.find((u) => u.id === 'f')?.data ?? {};
    check('funder: writes first_funder, first_funding_tx and activated_at', upd.first_funder === FUNDER && upd.first_funding_tx === F.FUNDED_BY_DOC.signature && upd.activated_at === '2022-01-19T20:46:34Z');
    const funderNode = t.graph.createdNodes.find((n) => n.data.address === FUNDER);
    const e = t.graph.createdEdges.find((x) => x.from === funderNode?.id && x.to === 'f');
    check("funder: the funder's 'sent to' link carries first_funding from amountRaw", e?.label === 'sent to' && e.data.first_funding.amount === '0.09811972' && e.data.first_funding.source === 'helius funded-by' && e.data.first_funding.tx_hash === F.FUNDED_BY_DOC.signature && e.data.network === 'solana');
    const lab = t.graph.updates.find((u) => u.id === funderNode?.id)?.data ?? {};
    check("funder: Helius's name for the funder becomes its public_label", lab.public_label === 'Coinbase 2' && lab.label_source === 'Helius' && lab.helius_type === 'exchange');
    check('funder: one wallet call, no RPC, 100 credits', t.net.calls.length === 1 && /about 100 credit/.test(r.summary) && /1 from funded-by/.test(r.summary));
}

const fundingHistory = [
    // 1. The address is named as the owner of a token account someone else opened: no SOL yet.
    F.tx({ signature: F.sig(50), slot: 10, blockTime: 1600000000, keys: [ALICE, F.addr(60), FUNDED, F.SYS, F.ATA], ixs: [F.ataCreate(ALICE, F.addr(60), FUNDED, F.USDC)], balances: { [FUNDED]: [0, 0] } }),
    // 2. The first SOL: Bob sends 0.05.
    F.tx({ signature: F.sig(51), slot: 11, blockTime: 1600000100, keys: [BOB, FUNDED, F.SYS], ixs: [F.sysTransfer(BOB, FUNDED, 50000000)], balances: { [FUNDED]: [0, 50000000] } }),
    // 3. Later SOL from Carol.
    F.tx({ signature: F.sig(52), slot: 12, blockTime: 1600000200, keys: [CAROL, FUNDED, F.SYS], ixs: [F.sysTransfer(CAROL, FUNDED, 70000000)], balances: { [FUNDED]: [50000000, 120000000] } }),
];

{
    // Free plan: funded-by is refused (403), once; the rest of the run reads history from the start.
    const t = ctxFor({
        nodes: { f: node('f', FUNDED), f2: node('f2', CAROL) },
        respond: (c) => (isWallet(c) ? { status: 403, body: { error: 'Forbidden', code: 403 } } : OK(c, F.page(c.body.params[0] === FUNDED ? fundingHistory : [], null))),
    });
    const r = await run(P.first_funder, t);
    check('funder: after a 403 funded-by is not asked again', t.net.calls.filter(isWallet).length === 1);
    const gt = t.net.calls.find((c) => rpcMethod(c) === 'getTransactionsForAddress');
    check('funder: the fallback reads oldest first, wallet-direct transactions only', gt?.body.params[1].sortOrder === 'asc' && gt.body.params[1].filters.tokenAccounts === 'none' && gt.body.params[1].transactionDetails === 'full');
    const upd = t.graph.updates.find((u) => u.id === 'f')?.data ?? {};
    check('funder: the earliest SOL deposit is the funder, not the earlier token-account mention', upd.first_funder === BOB && upd.first_funding_tx === F.sig(51) && upd.activated_at === '2020-09-13T12:28:20Z');
    const bob = t.graph.createdNodes.find((n) => n.data.address === BOB);
    const e = t.graph.createdEdges.find((x) => x.from === bob?.id && x.to === 'f');
    check("funder: the fallback's first_funding names its method", e?.data.first_funding.source === 'helius earliest SOL deposit' && e.data.first_funding.amount === '0.05');
    check('funder: the summary says funded-by needs a paid plan', /funded-by needs a paid Helius plan/.test(r.summary) && /1 from the earliest SOL deposit/.test(r.summary));
    check('funder: a whole history with no SOL at all is "never held SOL"', /1 address\(es\) never held SOL: their whole history was read/.test(r.summary));
    check('funder: the scan reads 100 transactions a page (10 credits each, the same as 25)', gt?.body.params[1].limit === 100);
}

{
    // earliest_deposit never calls the Wallet API; an existing pair link is amended, not relabelled.
    const nodes = { f: node('f', FUNDED), b: node('b', BOB) };
    const edges = [{ id: 'e9', from_node_id: 'b', to_node_id: 'f', label: 'sent to', data: { summary_helius: { complete: false } } }];
    const t = ctxFor({ nodes, edges, selection: ['f'], params: { method: 'earliest_deposit' }, respond: (c) => OK(c, F.page(fundingHistory, null)) });
    await run(P.first_funder, t);
    check('funder: earliest_deposit makes no Wallet API call', !t.net.calls.some(isWallet));
    const u = t.graph.updatedEdges.find((x) => x.id === 'e9');
    check('funder: an existing link gets first_funding as data, label untouched', u && u.label === undefined && u.data.first_funding.tx_hash === F.sig(51) && t.graph.createdEdges.length === 0);
}

{
    // Not within max_scan: not determined, nothing written; the page token says there is more.
    // max_scan below a page is clamped to one page, which costs the same.
    const quiet = Array.from({ length: 100 }, (_, k) => F.tx({ signature: F.sig(70 + (k % 9)), slot: 20 + k, blockTime: 1600001000 + k, keys: [ALICE, FUNDED], ixs: [], balances: { [FUNDED]: [0, 0] } }));
    const t = ctxFor({ nodes: { f: node('f', FUNDED) }, params: { method: 'earliest_deposit', max_scan: 25 }, respond: (c) => OK(c, F.page(quiet, '145:0')) });
    const r = await run(P.first_funder, t);
    const gts = t.net.calls.filter((c) => rpcMethod(c) === 'getTransactionsForAddress');
    check('funder: no SOL in the first max_scan transactions is "not determined", nothing written', t.graph.updates.length === 0 && t.graph.createdEdges.length === 0 && /1 not determined: no SOL received in the first 100 transactions/.test(r.summary));
    check('funder: max_scan is at least one page of 100', gts.length === 1 && gts[0].body.params[1].limit === 100);
}

{
    // funded-by's 404 is also what a wallet older than the endpoint gets (Helius, funded-by
    // Limitations), so it is not "never funded": the history is read from the start.
    const t = ctxFor({ nodes: { f: node('f', FUNDED) }, respond: (c) => (isWallet(c) ? { status: 404, body: F.FUNDED_BY_404 } : OK(c, F.page(fundingHistory, null))) });
    const r = await run(P.first_funder, t);
    const upd = t.graph.updates.find((u) => u.id === 'f')?.data ?? {};
    check('funder: a funded-by 404 reads the history from the start and finds the funder', t.net.calls.filter(isWallet).length === 1 && t.net.calls.some((c) => rpcMethod(c) === 'getTransactionsForAddress' && c.body.params[1].sortOrder === 'asc') && upd.first_funder === BOB && upd.first_funding_tx === F.sig(51));
    check('funder: the summary says funded-by had no record, not that the address never held SOL', /1 had no funded-by record/.test(r.summary) && /1 from the earliest SOL deposit/.test(r.summary) && !/never held SOL/.test(r.summary));
    const t2 = ctxFor({ nodes: { f: node('f', FUNDED) }, respond: (c) => (isWallet(c) ? { status: 404, body: F.FUNDED_BY_404 } : OK(c, F.page([], null))) });
    const r2 = await run(P.first_funder, t2);
    check('funder: a 404 and an empty history is "never held SOL"', t2.graph.updates.length === 0 && /1 address\(es\) never held SOL/.test(r2.summary));
    // The next address still asks funded-by: a 404 is about one address, not the plan.
    const t3 = ctxFor({ nodes: { f: node('f', FUNDED), c: node('c', CAROL) }, respond: (c) => (isWallet(c) ? { status: 404, body: F.FUNDED_BY_404 } : OK(c, F.page([], null))) });
    await run(P.first_funder, t3);
    check('funder: a 404 does not stop funded-by for the next address', t3.net.calls.filter(isWallet).length === 2);
}

{
    // The first lamports come from a closed token account (closeAccount names the address its
    // destination); Bob's System transfer comes later. Bob is not the first funder.
    const firstClose = [
        F.tx({ signature: F.sig(53), slot: 10, blockTime: 1600000000, keys: [ALICE, F.addr(61), FUNDED, F.TOKEN], ixs: [F.closeAccount(F.addr(61), FUNDED, ALICE)], balances: { [FUNDED]: [0, 2039280] } }),
        F.tx({ signature: F.sig(54), slot: 11, blockTime: 1700000000, keys: [BOB, FUNDED, F.SYS], ixs: [F.sysTransfer(BOB, FUNDED, 50000000)], balances: { [FUNDED]: [2039280, 52039280] } }),
    ];
    const t = ctxFor({ nodes: { f: node('f', FUNDED) }, params: { method: 'earliest_deposit' }, respond: (c) => OK(c, F.page(firstClose, null)) });
    const r = await run(P.first_funder, t);
    check('funder: an address first credited without a SOL transfer gets no funder, and no later one', t.graph.updates.length === 0 && t.graph.createdEdges.length === 0 && t.graph.createdNodes.length === 0);
    check('funder: the summary names how it was credited', /1 first held SOL from a program rather than a transfer, so no funder is named/.test(r.summary) && /spl-token closeAccount/.test(r.summary) && t.logs.some((l) => l.includes(F.sig(53))));
}

{
    // The earliest transaction Helius returns already finds SOL in the address (funded at genesis,
    // or before the history Helius holds): a later transfer is not taken for the first.
    const gap = [F.tx({ signature: F.sig(55), slot: 11, blockTime: 1700000000, keys: [BOB, FUNDED, F.SYS], ixs: [F.sysTransfer(BOB, FUNDED, 50000000)], balances: { [FUNDED]: [9000000, 59000000] } })];
    const t = ctxFor({ nodes: { f: node('f', FUNDED) }, params: { method: 'earliest_deposit' }, respond: (c) => OK(c, F.page(gap, null)) });
    const r = await run(P.first_funder, t);
    check('funder: SOL already there in the earliest transaction is "not determined", nothing written', t.graph.updates.length === 0 && /1 not determined: the earliest transaction Helius returned already finds SOL/.test(r.summary));
}

{
    // A funder that already carries another source's label keeps it.
    const nodes = { f: node('f', FUNDED), x: node('x', FUNDER, 'solana', { public_label: 'Exchange hot wallet', label_source: 'Solscan' }) };
    const t = ctxFor({ nodes, selection: ['f'], respond: (c) => (isWallet(c) ? { status: 200, body: { ...F.FUNDED_BY_DOC, funderName: 'Coinbase 2' } } : { status: 500 }) });
    await run(P.first_funder, t);
    const lab = t.graph.updates.find((u) => u.id === 'x')?.data ?? {};
    check("funder: another source's public_label is not overwritten", !('public_label' in lab) && lab.helius_label === 'Coinbase 2');
}

// ---- Solana Wallet Identity ----------------------------------------------------------------------

{
    // Free plan: 403 before anything was found fails the run with what to do.
    const t = ctxFor({ nodes: { s: node('s', SEED) }, respond: () => ({ status: 403, body: { error: 'Forbidden' } }) });
    const r = await run(P.wallet_identity, t);
    check('identity: a 403 fails the run and names the paid plan', !!r.error && /needs a paid Helius plan/.test(r.error.message) && t.graph.updates.length === 0);
}

{
    // The documented Binance example: an exchange wallet, attributed to its exchange.
    const t = ctxFor({ nodes: { s: node('s', SEED) }, respond: (c) => (isWallet(c) ? { status: 200, body: { ...F.IDENTITY_DOC, domainNames: ['binance.sol'] } } : { status: 500 }) });
    const r = await run(P.wallet_identity, t);
    const call = t.net.calls[0];
    check('identity: GET …/identity with X-Api-Key', call.url === `https://api.helius.xyz/v1/wallet/${SEED}/identity` && call.headers['X-Api-Key'] === KEY_VALUE && !call.url.includes(KEY_VALUE));
    const upd = t.graph.updates.find((u) => u.id === 's')?.data ?? {};
    check('identity: the address gets the label and its category', upd.public_label === 'Binance 1' && upd.label_source === 'Helius' && upd.helius_category === 'Centralized Exchange' && upd.helius_type === 'exchange' && upd.helius_tags?.[0] === 'Centralized Exchange' && upd.helius_domains?.[0] === 'binance.sol');
    const ex = t.graph.createdNodes.find((n) => n.type === 'financial.exchange');
    const e = t.graph.createdEdges.find((x) => x.from === 's' && x.to === ex?.id);
    check("identity: 'Binance 1' is attributed to the Exchange 'Binance'", ex?.data.name === 'Binance' && e?.label === 'attributed to' && e.data.attribution_helius.label === 'Binance 1' && e.data.attribution_helius.label_kind === 'public_tag' && /^\d{4}-\d{2}-\d{2}$/.test(e.data.attribution_helius.as_of));
    check('identity: summary counts it', /Helius names 1 of 1/.test(r.summary) && /1 linked 'attributed to'/.test(r.summary));
}

{
    // A malicious category stays a label; no owner node. A 404 is "no identity".
    const t = ctxFor({
        nodes: { s: node('s', SEED), b: node('b', BOB, 'solana', { public_label: 'Some label', label_source: 'legacy Financial node' }) },
        respond: (c) => (c.url.includes(SEED) ? { status: 404, body: F.IDENTITY_404 } : { status: 200, body: { address: BOB, type: 'wallet', name: 'Fake Airdrop Scammer', category: 'Scammer', tags: ['Scammer'] } }),
    });
    const r = await run(P.wallet_identity, t);
    const upd = t.graph.updates.find((u) => u.id === 'b')?.data ?? {};
    check('identity: Scammer stays a label, with no owner node or link', upd.helius_category === 'Scammer' && t.graph.createdNodes.length === 0 && t.graph.createdEdges.length === 0);
    check("identity: another source's public_label stays, Helius's goes in helius_label", !('public_label' in upd) && upd.helius_label === 'Fake Airdrop Scammer');
    check('identity: a 404 is counted as no identity', /1 have no Helius identity/.test(r.summary));
}

{
    // An owner already in the project is linked as it stands: nothing is written onto it.
    const nodes = { s: node('s', SEED), ex: { id: 'ex', type: 'financial.exchange', data: { name: 'binance', kyc_level: 'full' } }, j: node('j', BOB) };
    const t = ctxFor({
        nodes,
        selection: ['s', 'j'],
        respond: (c) => (c.url.includes(SEED) ? { status: 200, body: F.IDENTITY_DOC } : { status: 200, body: { address: BOB, type: 'defi', name: 'Jupiter', category: 'DeFi', tags: ['DeFi'] } }),
    });
    t.graph.list = async (o) => ({ nodes: Object.values(nodes).filter((n) => !o?.type || n.type === o.type) });
    await run(P.wallet_identity, t);
    const e = t.graph.createdEdges.find((x) => x.from === 's');
    check('identity: an existing Exchange (any case) is reused, nothing written on it', e?.to === 'ex' && !t.graph.createdNodes.some((n) => n.type === 'financial.exchange') && !t.graph.updates.some((u) => u.id === 'ex'));
    const svc = t.graph.createdNodes.find((n) => n.type === 'cryptocurrency.crypto_service');
    check('identity: a new DeFi owner is a Crypto Service with its kind and source', svc?.data.name === 'Jupiter' && svc.data.service_type === 'defi' && svc.data.attribution_source === 'Helius');
}

{
    // A project without the Financial pack refuses the exchange node: the label stays, the run goes on.
    const t = ctxFor({ nodes: { s: node('s', SEED) }, respond: () => ({ status: 200, body: F.IDENTITY_DOC }) });
    t.graph.createNode = async (d) => {
        throw new Error(`type "${d.type}" is not defined by any installed typepack. Call list_node_types and use one of the types it returns.`);
    };
    const r = await run(P.wallet_identity, t);
    check('identity: a refused owner type keeps the label and says which type', !r.error && t.graph.updates.length === 1 && /no financial\.exchange node could be made/.test(r.summary));
}

for (const n of fail) console.log('FAIL', n);
console.log(`\n${fail.length ? 'FAIL' : 'PASS'} ${ok.length} / ${ok.length + fail.length}`);
if (fail.length) process.exit(1);
