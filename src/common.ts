// Request plumbing and manifest fragments every Helius plugin shares.
import type { ConfigValue, GraphNode, GraphScope, HostContext, NetworkScope, PluginManifest, TypeRef } from './sdk';
import { isSolanaAddress, parseExact, str } from './values';

export const RPC_URL = 'https://mainnet.helius-rpc.com/';
export const WALLET_API = 'https://api.helius.xyz/v1/wallet/';

export const CRYPTO = 'run.vineyard.typepacks.cryptocurrency';
export const FINANCIAL = 'run.vineyard.typepacks.financial';
export const IDENTITY = 'run.vineyard.typepacks.identity';
export const ADDRESS = 'cryptocurrency.crypto_address';
export const NETWORK_NAME = 'solana';
export const crypto = (name: string): TypeRef => ({ typepack: CRYPTO, category: 'cryptocurrency', name });

// PLATFORM: web and desktop. MEASURED 2026-11-15 without a key: both hosts answer a browser's
// preflight with `access-control-allow-origin: *` and allow every request header (the RPC also names
// Authorization), and their 401s carry the same headers. A 200 was not seen, since that needs a key.
export const PLATFORMS: PluginManifest['platforms'] = {
    primary: 'web',
    web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
    desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
};

// ONE NETWORK LIST FOR EVERY MEMBER, on purpose. A Helius key works on both hosts, and the app files
// a pack's settings by the set of origins a member calls (config-slot.ts): a member that declared
// only the RPC would get a slot of its own and ask for the same key again. With one list they share
// one slot, so the key is typed once. What it costs is breadth — the history member may also reach
// the Wallet API — and both destinations are Helius hosts the install gate names.
//
// WHERE THE KEY GOES. Helius RPC takes the key only as the `api-key` query parameter (its
// authentication page documents no header), so it rides in the RPC URL, as Shodan's does. The
// Wallet API also takes the `X-Api-Key` header, and gets the header: a URL is the part of a request
// most often written down along the way.
export const NETWORK: NetworkScope[] = [
    {
        endpoint: RPC_URL,
        methods: ['POST'],
        purpose: 'Helius RPC: getTransactionsForAddress and getBalance. The API key goes in the api-key query parameter, the only way this RPC takes it.',
    },
    {
        endpoint: WALLET_API,
        methods: ['GET'],
        purpose: 'Helius Wallet API: funded-by and identity, which need a paid Helius plan. The API key goes in the X-Api-Key header.',
    },
];

const KEY_LABEL = 'Helius API key';
export const KEY_CONFIG: ConfigValue = { key: 'api_key', label: KEY_LABEL, type: 'string', secret: true, optional: false };

export const GRAPH_SCOPES: GraphScope[] = ['node:read', 'node:create', 'node:update', 'edge:read', 'edge:create'];
export const LIFECYCLE: NonNullable<PluginManifest['lifecycle']> = {
    persistence: 'opt-in',
    controls: ['progress', 'cancel'],
    progress: 'determinate',
};

// ---- errors ----------------------------------------------------------------------------------

/**
 * A condition that ends the whole run — a missing or refused key, a rate limit that outlasted the
 * backoff. Not one address's problem, so no address is tried past it.
 *
 * Each plugin catches it and decides: before anything was found it rethrows (a failed task that
 * names the cause); after, it stops and RETURNS, because the host discards everything a thrown run
 * staged (runner.ts) and the lookups already answered are worth keeping.
 */
export class StopRun extends Error {}

/** One request that failed without an answer (network error, 5xx after retries, a body that is not JSON). */
export class ItemFailed extends Error {}

/**
 * The Wallet API's 403: the endpoint needs a paid plan. MEASURED only in Helius's documentation
 * ("Free-plan requests return 403 Forbidden"), since no key was at hand.
 */
export class PlanRequired extends Error {}

export const abortErr = (): Error => new Error('cancelled');

/** A wait that Cancel can cut short. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }
        function onAbort() {
            clearTimeout(timer);
            reject(abortErr());
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });

export function requireNet(ctx: HostContext): void {
    if (!ctx.net?.fetch) throw new Error('This plugin was not granted its network permission');
}

/** The analyst's key, trimmed, or '' when none is set. Never logged, never put in a message. */
export function apiKey(ctx: HostContext): string {
    const k = ctx.config?.api_key;
    return typeof k === 'string' ? k.trim() : '';
}

export function requireKey(ctx: HostContext): string {
    const k = apiKey(ctx);
    if (!k) {
        throw new Error(
            `${KEY_LABEL} is not set. Every Helius request needs one; the free plan's key is at https://dashboard.helius.dev — paste it into this plugin's settings.`,
        );
    }
    return k;
}

// ---- the client ------------------------------------------------------------------------------

/**
 * Helius's retry guidance (docs: billing/rate-limits, "Retries and error handling"): retry 408, 429
 * and 5xx, wait about a second first and double each time up to 30 s. `Retry-After` wins when the
 * host passes it on. Four retries, so one address cannot park a run for more than about 15 s of
 * waiting.
 */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const backoffMs = (attempt: number, retryAfterSec: number): number =>
    Math.min(30_000, Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 1_000 * 2 ** attempt);

/** What each call costs, in Helius credits (docs: billing/credits and each method's "Metering"). */
export const CREDITS = {
    /** getTransactionsForAddress, full: 10 per 100 transactions returned, rounded up, at least 10. */
    history: (returned: number) => Math.max(10, Math.ceil(returned / 100) * 10),
    getBalance: 1,
    wallet: 100,
};

export class Helius {
    credits = 0;
    requests = 0;
    private id = 0;

    constructor(
        private readonly ctx: HostContext,
        private readonly key: string,
    ) {}

    /**
     * One request, with the retry rule above. Returns the status and the parsed body (null when the
     * body is empty or not JSON). Never puts the key or the URL in a message: the RPC URL carries
     * the key, and messages reach the Tasks panel and the AI panel's model.
     */
    private async send(url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }, host: string): Promise<{ status: number; json: any }> {
        for (let attempt = 0; ; attempt++) {
            if (this.ctx.signal?.aborted) throw abortErr();
            let res;
            try {
                this.requests++;
                res = await this.ctx.net!.fetch!(url, init);
            } catch (e) {
                if (this.ctx.signal?.aborted) throw abortErr();
                const msg = e instanceof Error ? e.message : String(e);
                throw new ItemFailed(`no answer from ${host} (${msg.includes(this.key) ? 'request failed' : msg})`);
            }
            if (RETRY_STATUS.has(res.status)) {
                if (attempt < MAX_RETRIES) {
                    const waitMs = backoffMs(attempt, Number(res.headers?.['retry-after'] ?? NaN));
                    if (res.status === 429) this.ctx.progress?.log?.(`${host} is rate-limiting — waiting ${Math.round(waitMs / 1000)}s`);
                    await sleep(waitMs, this.ctx.signal);
                    continue;
                }
                if (res.status === 429) throw new StopRun(`${host} kept refusing requests (HTTP 429) after ${MAX_RETRIES} waits`);
                throw new ItemFailed(`${host} answered HTTP ${res.status}`);
            }
            let text = '';
            try {
                text = await res.text();
            } catch {
                /* an unreadable body is handled with the status below */
            }
            let json: any = null;
            try {
                json = text ? parseExact(text) : null;
            } catch {
                json = null;
            }
            return { status: res.status, json };
        }
    }

    /**
     * One JSON-RPC call to Helius RPC. MEASURED 2026-11-15: no key and a wrong key both get HTTP 401
     * with the plain-text body "Unauthorized"; that ends the run, because every later call would
     * get the same.
     */
    async rpc(method: string, params: unknown[]): Promise<any> {
        const host = new URL(RPC_URL).host;
        const url = `${RPC_URL}?api-key=${encodeURIComponent(this.key)}`;
        const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params });
        for (let attempt = 0; ; attempt++) {
            const { status, json } = await this.send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, host);
            if (status === 401) throw new StopRun(`Helius refused the API key (HTTP 401) — check it at https://dashboard.helius.dev`);
            if (status === 403) {
                throw new StopRun(
                    `Helius refused ${method} for this key (HTTP 403): the plan may not include it, or the key's access rules in the Helius dashboard (allowed domains or IPs) exclude this app`,
                );
            }
            if (status < 200 || status >= 300) throw new ItemFailed(`${host} answered HTTP ${status} to ${method}`);
            if (!json || typeof json !== 'object') throw new ItemFailed(`${host} answered ${method} with something that is not JSON`);
            const err = json.error;
            if (err) {
                // A JSON-RPC rate limit inside a 200, which some Solana RPCs send instead of a 429.
                if ((err.code === 429 || err.code === -32429) && attempt < MAX_RETRIES) {
                    const waitMs = backoffMs(attempt, NaN);
                    this.ctx.progress?.log?.(`${host} is rate-limiting — waiting ${Math.round(waitMs / 1000)}s`);
                    await sleep(waitMs, this.ctx.signal);
                    continue;
                }
                const msg = typeof err.message === 'string' ? err.message.slice(0, 200) : `error ${String(err.code)}`;
                throw new ItemFailed(`${method}: ${msg}`);
            }
            return json.result;
        }
    }

    /**
     * One GET on the Wallet API, `path` under /v1/wallet/. Returns the body, or null on 404 (no such
     * record: a real negative). Statuses are Helius's documented ones: 401 a missing or wrong key,
     * 403 an endpoint the plan does not include, 400 an input it will not take.
     */
    async wallet(path: string): Promise<any | null> {
        const host = new URL(WALLET_API).host;
        const { status, json } = await this.send(`${WALLET_API}${path}`, { method: 'GET', headers: { 'X-Api-Key': this.key, Accept: 'application/json' } }, host);
        this.credits += status >= 200 && status < 300 ? CREDITS.wallet : 0;
        if (status === 404) return null;
        if (status === 401) throw new StopRun(`Helius refused the API key (HTTP 401) — check it at https://dashboard.helius.dev`);
        if (status === 403) throw new PlanRequired(path.split('/').pop() ?? path);
        if (status < 200 || status >= 300) {
            const why = typeof json?.error === 'string' ? `: ${json.error.slice(0, 200)}` : '';
            throw new ItemFailed(`${host} answered HTTP ${status}${why}`);
        }
        if (!json || typeof json !== 'object') throw new ItemFailed(`${host} answered with something that is not JSON`);
        return json;
    }

    /**
     * One page of `getTransactionsForAddress` in full jsonParsed form, successful transactions only.
     *
     * `maxSupportedTransactionVersion: 1` because without it the method returns legacy transactions
     * only (its documentation), and most transactions since 2023 are v0: a history without them
     * would look complete and be nearly empty.
     */
    async historyPage(
        address: string,
        o: { sortOrder: 'asc' | 'desc'; limit: number; tokenAccounts: 'none' | 'balanceChanged'; paginationToken?: string },
    ): Promise<{ data: any[]; paginationToken: string | null }> {
        const r = await this.rpc('getTransactionsForAddress', [
            address,
            {
                transactionDetails: 'full',
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion: 1,
                commitment: 'finalized',
                sortOrder: o.sortOrder,
                limit: o.limit,
                filters: { status: 'succeeded', tokenAccounts: o.tokenAccounts },
                ...(o.paginationToken ? { paginationToken: o.paginationToken } : {}),
            },
        ]);
        const data = Array.isArray(r?.data) ? r.data : [];
        this.credits += CREDITS.history(data.length);
        return { data, paginationToken: typeof r?.paginationToken === 'string' && r.paginationToken ? r.paginationToken : null };
    }

    /** The address's SOL balance in lamports, as a digit string. */
    async balance(address: string): Promise<string | null> {
        const r = await this.rpc('getBalance', [address, { commitment: 'finalized' }]);
        this.credits += CREDITS.getBalance;
        const v = r?.value;
        if (typeof v === 'string' && /^\d+$/.test(v)) return v;
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
        return null;
    }

    costLine(): string {
        return `${this.requests} Helius request(s), about ${this.credits} credit(s)`;
    }
}

// ---- selection ---------------------------------------------------------------------------------

export interface Targets {
    /** Crypto Address nodes on network solana whose address is a Solana account. */
    nodes: Array<GraphNode & { address: string }>;
    /** Crypto Address nodes on another network. */
    otherNetwork: number;
    /** On network solana, but the value is not a Solana address. */
    malformed: string[];
    /** Selected nodes that are not Crypto Addresses. */
    otherType: number;
}

export async function selectedTargets(ctx: HostContext): Promise<Targets> {
    const out: Targets = { nodes: [], otherNetwork: 0, malformed: [], otherType: 0 };
    const seen = new Set<string>();
    for (const id of ctx.input?.selection ?? []) {
        if (ctx.signal?.aborted) throw abortErr();
        const n = await ctx.graph?.get?.(id);
        if (!n || n.type !== ADDRESS) {
            out.otherType++;
            continue;
        }
        if (str(n.data?.network) !== NETWORK_NAME) {
            out.otherNetwork++;
            continue;
        }
        const address = str(n.data?.address);
        if (!isSolanaAddress(address)) {
            out.malformed.push(address || '(empty)');
            continue;
        }
        if (seen.has(address)) continue;
        seen.add(address);
        out.nodes.push({ ...n, address });
    }
    return out;
}

/** The summary lines every plugin ends with for what it did not look up. */
export function targetNotes(t: Targets): string[] {
    const parts: string[] = [];
    if (t.otherNetwork) parts.push(`${t.otherNetwork} Crypto Address(es) are not on network solana and were skipped`);
    if (t.malformed.length) parts.push(`${t.malformed.length} on network solana are not Solana addresses (${t.malformed.slice(0, 3).join(', ')}${t.malformed.length > 3 ? ', …' : ''})`);
    if (t.otherType) parts.push(`${t.otherType} selected node(s) are not Crypto Addresses`);
    return parts;
}

/**
 * What to say about a StopRun: rethrow when nothing was written yet, otherwise the line the summary
 * ends with. See StopRun for why the two differ.
 */
export function stopped(e: StopRun, writtenSoFar: number, notReached: number): string {
    if (!writtenSoFar) throw new Error(e.message);
    return `STOPPED: ${e.message}. ${notReached} address(es) were not looked up — run them again later`;
}
