// Solana First Funder — a Solana address → the wallet that sent its first SOL, and when.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import {
    abortErr,
    crypto,
    GRAPH_SCOPES,
    Helius,
    ItemFailed,
    KEY_CONFIG,
    LIFECYCLE,
    NETWORK,
    NETWORK_NAME,
    PLATFORMS,
    PlanRequired,
    requireKey,
    requireNet,
    selectedTargets,
    StopRun,
    stopped,
    targetNotes,
} from './common';
import { Addresses, labelFields, Links } from './graph';
import { activationIn, fundingIn } from './transfers';
import { compact, formatUnits, isoTime, isSolanaAddress, SOL_DECIMALS, str, toBigInt } from './values';

/** Where a funding came from, as `first_funding.source` records it. */
export const SOURCE_FUNDED_BY = 'helius funded-by';
export const SOURCE_EARLIEST = 'helius earliest SOL deposit';

/**
 * Transactions per request when scanning from the start. Most wallets are funded in the first few,
 * but Helius bills a page of full transactions 10 credits per 100 returned with a 10-credit minimum
 * (billing/credits), so a page of 25 costs what a page of 100 does and a deep scan in pages of 25
 * costs four times the credits.
 */
const PAGE = 100;

export interface Funding {
    funder: string;
    tx_hash: string;
    time?: string;
    /** Decimal SOL. */
    amount?: string;
    source: string;
    /** Helius's name and kind for the funder, from funded-by only. */
    funderName?: string;
    funderType?: string;
}

/**
 * A `funded-by` answer as a Funding, or null when it is not one.
 *
 * Shape from Helius's documentation (wallet-api/funded-by, 2026-11-15): `funder`, `funderName`,
 * `funderType`, `amountRaw` (lamports as a string), `signature`, `timestamp` (Unix seconds).
 * `amountRaw` is used, not `amount`, which is a float.
 */
export function fromFundedBy(r: any): Funding | null {
    const funder = str(r?.funder);
    const sig = str(r?.signature);
    if (!isSolanaAddress(funder) || !sig) return null;
    const raw = toBigInt(r?.amountRaw);
    return compact({
        funder,
        tx_hash: sig,
        time: isoTime(r?.timestamp),
        amount: raw != null ? formatUnits(raw, SOL_DECIMALS) : undefined,
        source: SOURCE_FUNDED_BY,
        funderName: str(r?.funderName) || undefined,
        funderType: str(r?.funderType) || undefined,
    }) as Funding;
}

const intParam = (v: unknown, dflt: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt;

/** What reading an address's history from the start found. */
export type Scan =
    | { kind: 'funded'; funding: Funding; scanned: number }
    /** First held SOL in `tx_hash` without a transfer from a wallet: no funder to name. */
    | { kind: 'credited'; tx_hash: string; time?: string; by?: string; scanned: number }
    /** The earliest transaction Helius returned already finds SOL in the address. */
    | { kind: 'gap'; tx_hash: string; scanned: number }
    /** The whole history was read, and the address never held SOL in it. */
    | { kind: 'never'; scanned: number }
    /** `maxScan` transactions read without reaching the first SOL. */
    | { kind: 'limit'; scanned: number };

/**
 * The first funding, read from the start of the address's history: what the free plan can do in
 * place of `funded-by`, and the same definition Helius gives that endpoint ("traced to its first
 * incoming SOL transfer").
 *
 * The transaction that counts is the one in which the address's balance first rose from zero
 * (transfers.ts activationIn), and the funder is whoever sent SOL to it THERE. When the first
 * lamports came another way (a closed token account, a stake withdrawal, a program) there is no
 * funder to name, and the scan stops rather than take a later transfer for the first; so it does
 * when the earliest transaction Helius has already finds SOL in the address. A later transaction is
 * never the answer.
 *
 * Only transactions that name the address itself (`tokenAccounts: 'none'`): lamports cannot reach an
 * account a transaction does not name, and token-account activity would only cost pages. Gives up
 * after `maxScan` transactions — "not determined", never a guess.
 */
export async function earliestDeposit(helius: Helius, address: string, maxScan: number, signal?: AbortSignal): Promise<Scan> {
    let scanned = 0;
    let token: string | undefined;
    while (scanned < maxScan) {
        if (signal?.aborted) throw abortErr();
        const page = await helius.historyPage(address, { sortOrder: 'asc', limit: Math.min(PAGE, maxScan - scanned), tokenAccounts: 'none', paginationToken: token });
        for (const tx of page.data) {
            scanned++;
            const t = isoTime(tx?.blockTime);
            const sig = str(tx?.transaction?.signatures?.[0]);
            const a = activationIn(tx, address, t);
            if (a.state === 'unfunded') continue;
            if (a.state === 'already') return { kind: 'gap', tx_hash: sig, scanned };
            // 'unknown': no balances to go by, so the first SOL transfer to it, as before balances.
            const f = a.state === 'activated' ? a.funding : fundingIn(tx, address, t);
            if (f) {
                return { kind: 'funded', funding: { funder: f.from, tx_hash: f.tx_hash, time: f.time, amount: formatUnits(f.raw, SOL_DECIMALS), source: SOURCE_EARLIEST }, scanned };
            }
            if (a.state === 'activated') return compact({ kind: 'credited' as const, tx_hash: sig, time: t, by: a.by, scanned }) as Scan;
        }
        token = page.paginationToken ?? undefined;
        if (!token || !page.data.length) return { kind: 'never', scanned };
    }
    return { kind: 'limit', scanned };
}

export const firstFunder = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.helius_first_funder',
        content_type: 'vineyard:plugin',
        name: 'Solana First Funder',
        version: '1.0.0',
        description:
            "Finds who sent each selected Crypto Address on network solana its first SOL. With a paid Helius plan it asks the Wallet API's funded-by, which also names a known funder (an exchange, say). On the free plan, which funded-by refuses with 403, and for an address funded-by has no record of, it reads the address's history from the start (getTransactionsForAddress, oldest first) to the transaction where its balance first rose from zero and takes the SOL transfer to it there, the definition funded-by uses. Writes first_funder, first_funding_tx and activated_at on the address, makes the funder a Crypto Address (with Helius's name for it as public_label when it has none), and adds first_funding (tx_hash, time, amount in SOL, source) to the funder's 'sent to' link to the address, creating the link if the pair has none. An address first credited by a program rather than a transfer, or not funded within its first max_scan transactions (default 100), is reported with no funder named. Needs a Helius API key.",
        icon: 'hand-coins',
        platforms: PLATFORMS,
        params: {
            type: 'object',
            properties: {
                method: {
                    type: 'string',
                    title: 'Method',
                    enum: ['auto', 'earliest_deposit'],
                    default: 'auto',
                    description: "auto: funded-by (100 credits, paid plans), reading the history from the start when the plan refuses it or funded-by has no record of the address. earliest_deposit: never call funded-by.",
                },
                max_scan: {
                    type: 'integer',
                    title: 'Most transactions to scan',
                    default: 100,
                    minimum: 100,
                    maximum: 1000,
                    description: 'When reading from the start: how far to look for the first SOL received, 100 per request (10 Helius credits each).',
                },
            },
        },
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_address')] },
        scopes: { graph: GRAPH_SCOPES, network: NETWORK, config: [KEY_CONFIG] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const key = requireKey(ctx);
        let useFundedBy = ctx.params?.method !== 'earliest_deposit';
        const maxScan = intParam(ctx.params?.max_scan, 100, 100, 1000);

        const targets = await selectedTargets(ctx);
        if (!targets.nodes.length) {
            return { summary: ['No Solana address was selected', ...targetNotes(targets)].join('. ') + '.', counts: { addresses: 0 } };
        }

        const helius = new Helius(ctx, key);
        const links = new Links(ctx);
        const addresses = new Addresses(ctx);
        for (const n of targets.nodes) addresses.know(n, n.address);

        let found = 0;
        let viaFundedBy = 0;
        let neverFunded = 0;
        /** funded-by answered 404: no record, which is not the same as never funded (see below). */
        let noRecord = 0;
        const undetermined: string[] = [];
        const credited: string[] = [];
        const gaps: string[] = [];
        let fellBack = false;
        let failed = 0;
        let wrote = 0;
        let stop = '';

        for (let i = 0; i < targets.nodes.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            const node = targets.nodes[i];
            const address = node.address;
            ctx.progress?.set?.({ percent: Math.round((i / targets.nodes.length) * 100), message: address });
            try {
                let funding: Funding | null = null;
                if (useFundedBy) {
                    try {
                        const r = await helius.wallet(`${encodeURIComponent(address)}/funded-by`);
                        if (r === null) {
                            // A 404 is what Helius sends for a wallet that never received SOL, AND for
                            // one it has no record of: its Limitations say historical data covers only
                            // wallets created after the endpoint was deployed, and none for a wallet
                            // first credited without a SOL transfer. So it is not taken as "never
                            // funded": the history is read from the start, as on the free plan.
                            noRecord++;
                        } else {
                            funding = fromFundedBy(r);
                            if (!funding) throw new ItemFailed('funded-by answered without a funder and signature');
                        }
                    } catch (e) {
                        if (!(e instanceof PlanRequired)) throw e;
                        // The plan, not the address: every later call would get the same, so the rest of
                        // the run reads history instead, and the summary says so once.
                        useFundedBy = false;
                        fellBack = true;
                        ctx.progress?.log?.("funded-by needs a paid Helius plan (HTTP 403); finding the earliest SOL deposit instead");
                    }
                }
                if (!funding) {
                    const r = await earliestDeposit(helius, address, maxScan, ctx.signal);
                    if (r.kind === 'never') neverFunded++;
                    else if (r.kind === 'limit') undetermined.push(address);
                    else if (r.kind === 'gap') {
                        gaps.push(address);
                        ctx.progress?.log?.(`${address}: already held SOL in the earliest transaction Helius returned (${r.tx_hash})`);
                    } else if (r.kind === 'credited') {
                        credited.push(`${address}${r.by ? ` (${r.by})` : ''}`);
                        ctx.progress?.log?.(`${address}: first held SOL in ${r.tx_hash}${r.time ? ` (${r.time})` : ''}, credited ${r.by ? `by ${r.by}` : 'by a program'} without a SOL transfer`);
                    } else funding = r.funding;
                    if (!funding) continue;
                }
                if (funding.funder === address) continue;
                if (funding.source === SOURCE_FUNDED_BY) viaFundedBy++;

                const funderNode = await addresses.ensure(funding.funder);
                if (funding.funderName) {
                    await ctx.graph!.updateNode!(funderNode.id, labelFields(funderNode, funding.funderName, funding.funderType ? { helius_type: funding.funderType } : {}));
                }
                await ctx.graph!.updateNode!(
                    node.id,
                    compact({ first_funder: funding.funder, first_funding_tx: funding.tx_hash, activated_at: funding.time }),
                );
                // No link of its own for the funding: the funder SENT to the address, so the pair's
                // link is `sent to`, and the funding is a data key on it (the type pack's rule).
                await links.put(funderNode.id, node.id, 'sent to', {
                    network: NETWORK_NAME,
                    first_funding: compact({ tx_hash: funding.tx_hash, time: funding.time, amount: funding.amount, source: funding.source }),
                });
                found++;
                wrote++;
            } catch (e) {
                if (e instanceof StopRun) {
                    stop = stopped(e, wrote, targets.nodes.length - i);
                    break;
                }
                if (e instanceof ItemFailed) {
                    failed++;
                    ctx.progress?.log?.(`${address}: ${e.message}`);
                    continue;
                }
                throw e;
            }
        }
        ctx.progress?.set?.({ percent: 100 });

        const few = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ', …' : ''}`;
        const parts = [`First funder found for ${found} of ${targets.nodes.length} Solana address(es)`];
        if (viaFundedBy) parts.push(`${viaFundedBy} from funded-by`);
        if (found - viaFundedBy > 0) parts.push(`${found - viaFundedBy} from the earliest SOL deposit`);
        if (fellBack) parts.push('funded-by needs a paid Helius plan (Developer or above), so the earliest SOL deposit was used');
        if (noRecord) parts.push(`${noRecord} had no funded-by record (Helius keeps none for wallets older than the endpoint), so their history was read from the start`);
        if (neverFunded) parts.push(`${neverFunded} address(es) never held SOL: their whole history was read`);
        if (credited.length) parts.push(`${credited.length} first held SOL from a program rather than a transfer, so no funder is named (${few(credited)})`);
        if (gaps.length) parts.push(`${gaps.length} not determined: the earliest transaction Helius returned already finds SOL in the address (${few(gaps)})`);
        if (undetermined.length) {
            parts.push(`${undetermined.length} not determined: no SOL received in the first ${maxScan} transactions (${few(undetermined)}); raise "Most transactions to scan"`);
        }
        parts.push(...targetNotes(targets));
        if (failed) parts.push(`${failed} lookup(s) failed`);
        parts.push(helius.costLine());
        if (stop) parts.push(stop);
        return {
            summary: parts.join('. ') + '.',
            counts: { found, funded_by: viaFundedBy, no_record: noRecord, never_funded: neverFunded, credited: credited.length, gaps: gaps.length, undetermined: undetermined.length, failed },
        };
    },
});
