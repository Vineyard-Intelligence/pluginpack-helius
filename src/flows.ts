// Turning one address's transfers into `sent to` links: per-pair summaries, and the recent-transfer
// list merged with what a link already holds.
//
// Pure and dependency-free so test/pure.test.mjs can import it.
//
// The link rules are the Cryptocurrency type pack's: one link per ordered pair, labelled `sent to`,
// with each source's figures under its own top-level key (`summary_helius`) because commit merges
// link data one top-level key at a time, and a `recent` list of the latest 20 transfers that every
// collector shares, merged by transaction and asset. The shapes match the Blockscout PRO pack's, so
// two collectors' figures on one link read the same way.
import { formatUnits } from './values';
import type { Transfer } from './transfers';

export interface AssetSummary {
    asset: string;
    symbol?: string;
    count: number;
    total: string;
    /** Present, and true, when the total is in base units because the decimals are unknown. */
    base_units?: true;
    first?: string;
    last?: string;
}

export interface RecentRow {
    tx_hash: string;
    asset: string;
    symbol?: string;
    amount: string;
    time?: string;
}

export interface PairFlow {
    from: string;
    to: string;
    assets: AssetSummary[];
    /** Assets beyond the cap, left out of `assets`. */
    assets_omitted: number;
    recent: RecentRow[];
    /** Transfers in this pair, all assets: how pairs are ranked when they are capped. */
    transfers: number;
    lastTime?: string;
}

export const RECENT_MAX = 20;
export const ASSETS_MAX = 25;

const amountOf = (raw: bigint, decimals: number | null): string => (decimals == null ? raw.toString() : formatUnits(raw, decimals));

function clean<T extends Record<string, unknown>>(o: T): T {
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
}

/**
 * Per-pair flows of one address: only transfers it sent or received, self-transfers left out.
 *
 * Busiest pairs first, then the most recent, which is the order the counterparty cap keeps.
 */
export function aggregate(seed: string, transfers: Transfer[]): PairFlow[] {
    type Acc = {
        from: string;
        to: string;
        assets: Map<string, { asset: string; symbol?: string; decimals: number | null; count: number; total: bigint; first?: string; last?: string }>;
        recent: Map<string, { tx_hash: string; asset: string; symbol?: string; decimals: number | null; raw: bigint; time?: string; slot: number }>;
        transfers: number;
        lastTime?: string;
    };
    const pairs = new Map<string, Acc>();
    for (const t of transfers) {
        if (t.from === t.to || (t.from !== seed && t.to !== seed)) continue;
        const key = `${t.from}>${t.to}`;
        let p = pairs.get(key);
        if (!p) {
            p = { from: t.from, to: t.to, assets: new Map(), recent: new Map(), transfers: 0 };
            pairs.set(key, p);
        }
        p.transfers++;
        if (t.time && (!p.lastTime || t.time > p.lastTime)) p.lastTime = t.time;
        // Keyed by asset AND decimals: a token whose decimals one transaction states and another
        // does not would otherwise sum base units into a decimal total.
        const ak = `${t.asset}|${t.decimals ?? ''}`;
        let a = p.assets.get(ak);
        if (!a) {
            a = { asset: t.asset, symbol: t.symbol, decimals: t.decimals, count: 0, total: 0n };
            p.assets.set(ak, a);
        }
        a.count++;
        a.total += BigInt(t.raw);
        if (t.time && (!a.first || t.time < a.first)) a.first = t.time;
        if (t.time && (!a.last || t.time > a.last)) a.last = t.time;
        // One row per transaction and asset: a transaction that pays the same wallet twice (a
        // payout split in two inner transfers) is one transfer of the sum, which is what the shared
        // list keys on.
        const rk = `${t.tx_hash}|${t.asset}`;
        const prev = p.recent.get(rk);
        if (prev) prev.raw += BigInt(t.raw);
        else p.recent.set(rk, { tx_hash: t.tx_hash, asset: t.asset, symbol: t.symbol, decimals: t.decimals, raw: BigInt(t.raw), time: t.time, slot: t.slot ?? 0 });
    }

    const out: PairFlow[] = [...pairs.values()].map((p) => {
        const assets = [...p.assets.values()].sort((x, y) => y.count - x.count || (x.asset < y.asset ? -1 : x.asset > y.asset ? 1 : 0));
        const recent = [...p.recent.values()]
            .sort((x, y) => y.slot - x.slot || (x.tx_hash < y.tx_hash ? -1 : 1))
            .slice(0, RECENT_MAX)
            .map((r) => clean({ tx_hash: r.tx_hash, asset: r.asset, symbol: r.symbol, amount: amountOf(r.raw, r.decimals), time: r.time }) as RecentRow);
        return {
            from: p.from,
            to: p.to,
            assets: assets.slice(0, ASSETS_MAX).map(
                (a) =>
                    clean({
                        asset: a.asset,
                        symbol: a.symbol,
                        count: a.count,
                        total: amountOf(a.total, a.decimals),
                        base_units: a.decimals == null ? true : undefined,
                        first: a.first,
                        last: a.last,
                    }) as AssetSummary,
            ),
            assets_omitted: Math.max(0, assets.length - ASSETS_MAX),
            recent,
            transfers: p.transfers,
            lastTime: p.lastTime,
        };
    });
    out.sort((x, y) => y.transfers - x.transfers || ((y.lastTime ?? '') > (x.lastTime ?? '') ? 1 : (y.lastTime ?? '') < (x.lastTime ?? '') ? -1 : 0));
    return out;
}

/**
 * The link's `recent` list after this run: what it held, with this run's rows laid over it.
 *
 * Merged by transaction and asset, so another collector's rows (or an earlier run's, reaching
 * further back) are kept and the list does not shrink to what this run happened to see. Compared
 * exactly: a Solana signature and a mint are Base58, where case is part of the value. Rows that are
 * not objects with a hash are dropped, because the list is shared and only as useful as its worst
 * row. Newest first by time; a row without a time sorts last.
 */
export function mergeRecent(existing: unknown, ours: RecentRow[], max = RECENT_MAX): RecentRow[] {
    const byKey = new Map<string, RecentRow>();
    const key = (r: { tx_hash: string; asset?: unknown }) => `${r.tx_hash}|${String(r.asset ?? '')}`;
    if (Array.isArray(existing)) {
        for (const r of existing) {
            if (r && typeof r === 'object' && typeof (r as any).tx_hash === 'string' && (r as any).tx_hash) {
                byKey.set(key(r as RecentRow), r as RecentRow);
            }
        }
    }
    for (const r of ours) byKey.set(key(r), r);
    return [...byKey.values()]
        .sort((x, y) => {
            const tx = typeof x.time === 'string' ? x.time : '';
            const ty = typeof y.time === 'string' ? y.time : '';
            if (tx !== ty) return tx < ty ? 1 : -1;
            return x.tx_hash < y.tx_hash ? -1 : x.tx_hash > y.tx_hash ? 1 : 0;
        })
        .slice(0, max);
}
