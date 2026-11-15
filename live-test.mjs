// Live check against the real Helius APIs — opt-in, never part of the mock suite.
//
//   HELIUS_API_KEY=… node live-test.mjs
//
// The key is read from the environment only and never printed: nothing below logs a request URL
// (the RPC URL carries the key) or a request header. Runs every plugin through the bundle with a
// mock graph and prints what each would have staged. Low volume on purpose — about ten requests,
// some 250 credits with a paid key, about 50 with a free one.
//
// The addresses are the examples in Helius's own documentation: the Binance wallet of the identity
// page, and the wallet of the funded-by page, whose documented funder is
// 26MAyPNpK4At8LgRECMMbgiKQuJyg3oACtw1Q9FRyuba. With a paid key both first-funder methods run on
// that wallet and the script says whether they agree, which is the check that the earliest-deposit
// method finds what funded-by finds.
import pack from './dist/pack.mjs';

const key = (process.env.HELIUS_API_KEY ?? '').trim();
if (!key) {
    console.log('SKIP live test: set HELIUS_API_KEY (a free key from https://dashboard.helius.dev)');
    process.exit(0);
}
const P = Object.fromEntries(pack.plugins.map((p) => [p.manifest.identifier.replace('run.vineyard.plugins.helius_', ''), p]));
const BINANCE = 'HXsKP7wrBWaQ8T2Vtjry3Nj3oUgwYcqq9vrHDM12G664';
const FUNDED = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const DOC_FUNDER = '26MAyPNpK4At8LgRECMMbgiKQuJyg3oACtw1Q9FRyuba';

const scrub = (s) => String(s).split(key).join('<key>');
const net = {
    async fetch(url, init) {
        const res = await fetch(url, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
        const text = await res.text();
        const headers = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
        if (!res.ok) console.log(`    HTTP ${res.status} from ${new URL(url).host}; CORS ${headers['access-control-allow-origin'] ?? '(none)'}`);
        else console.log(`    200 from ${new URL(url).host}; CORS ${headers['access-control-allow-origin'] ?? '(none)'}; ${text.length} bytes`);
        return { ok: res.ok, status: res.status, headers, async text() { return text; }, async json() { return JSON.parse(text); } };
    },
};

function graphOf(nodes) {
    const created = [];
    const links = [];
    const updates = [];
    return {
        created,
        links,
        updates,
        get: async (id) => nodes[id] ?? null,
        list: async () => ({ nodes: [] }),
        edges: async () => [],
        createNode: async (d) => {
            const n = { id: `n${created.length + 1}`, type: d.type, data: d.data };
            created.push(n);
            return n;
        },
        updateNode: async (id, data) => updates.push({ id, data }),
        createEdge: async (e) => links.push(e),
        updateEdge: async () => {},
    };
}
async function runOn(name, address, params = {}) {
    const node = { id: 's', type: 'cryptocurrency.crypto_address', data: { network: 'solana', address } };
    const graph = graphOf({ s: node });
    const ctx = { run: { platform: 'web' }, config: { api_key: key }, params, input: { selection: ['s'] }, graph, net, progress: { set() {}, log: (m) => console.log(`    log: ${scrub(m)}`) } };
    console.log(`  ${P[name].manifest.name} on ${address} ${JSON.stringify(params)}`);
    try {
        const r = await P[name].run(ctx);
        console.log(`    summary: ${scrub(r.summary)}`);
    } catch (e) {
        console.log(`    FAILED: ${scrub(e instanceof Error ? e.message : e)}`);
    }
    for (const u of graph.updates) console.log(`    update ${u.id}: ${scrub(JSON.stringify(u.data)).slice(0, 400)}`);
    console.log(`    created: ${graph.created.length} node(s); links: ${graph.links.length} (${[...new Set(graph.links.map((e) => e.label))].join(' | ')})`);
    if (graph.links[0]) console.log(`    first link data: ${scrub(JSON.stringify(graph.links[0].data)).slice(0, 600)}`);
    return graph;
}

console.log('Helius live test');
await runOn('address_history', BINANCE, { max_transactions: 100, max_counterparties: 5 });
const viaAuto = await runOn('first_funder', FUNDED, { method: 'auto' });
const viaHistory = await runOn('first_funder', FUNDED, { method: 'earliest_deposit' });
const a = viaAuto.updates.find((u) => u.id === 's')?.data?.first_funder;
const b = viaHistory.updates.find((u) => u.id === 's')?.data?.first_funder;
console.log(`  first funder: auto ${a ?? '(none)'}, earliest deposit ${b ?? '(none)'}, documented ${DOC_FUNDER} — ${a && b ? (a === b ? 'AGREE' : 'DISAGREE') : 'not comparable'}`);
await runOn('wallet_identity', BINANCE);
