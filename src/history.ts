// Solana Address History — a Solana address → the wallets it paid and was paid by, SPL tokens included.
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
    requireKey,
    requireNet,
    selectedTargets,
    StopRun,
    stopped,
    targetNotes,
} from './common';
import { aggregate, mergeRecent } from './flows';
import { Addresses, Links } from './graph';
import { transfersOf } from './transfers';
import type { Transfer } from './transfers';
import { compact, formatUnits, isoTime, SOL_DECIMALS, SYSTEM_PROGRAM } from './values';

export const SUMMARY_KEY = 'summary_helius';
/** Per request. Full transactions are billed per 100 returned, so a smaller page saves nothing. */
const PAGE = 100;

const intParam = (v: unknown, dflt: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt;

/**
 * Whether a transfer is a payment between two wallets, as far as the address's links go.
 *
 * A System `createAccount` funds a new account with its rent. When the new account is a token
 * account or a program's, that is rent, not a payment to anyone: a wallet that opened 300 token
 * accounts would otherwise be linked `sent to` 300 accounts nobody controls. It counts when the new
 * account is a plain wallet (System-owned) or is the address itself, whose creation is how it got
 * its first SOL.
 */
export function isPayment(t: Transfer, seed: string): boolean {
    if (t.created_owner === undefined) return true;
    return t.created_owner === SYSTEM_PROGRAM || t.to === seed;
}

export const addressHistory = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.helius_address_history',
        content_type: 'vineyard:plugin',
        name: 'Solana Address History',
        version: '1.0.0',
        description:
            "Reads each selected Crypto Address on network solana from Helius getTransactionsForAddress, newest first, successful transactions only, including the SPL token transfers that arrive in the wallet's token accounts, which a plain Solana RPC leaves out. Links the address 'sent to' and from each wallet on the other side of a SOL or SPL token transfer: summary_helius (per asset, 'native' for SOL or the token mint: count, total, first, last; with window_from, window_to and complete), and the latest 20 transfers in recent on a link it creates (a link already in the project keeps its own recent list). SOL wrapped into the address's own wSOL account is not a payment. Writes balance (SOL, from getBalance), last_seen, history_examined, history_complete, and first_seen when the whole history was read. Token transfers before December 2022 are not found through token accounts. Up to max_transactions (default 300) per address and max_counterparties (default 50) links. Needs a Helius API key; the free plan works.",
        icon: 'history',
        platforms: PLATFORMS,
        params: {
            type: 'object',
            properties: {
                max_transactions: {
                    type: 'integer',
                    title: 'Most transactions per address',
                    default: 300,
                    minimum: 100,
                    maximum: 5000,
                    description: 'Read newest first, 100 per request (10 Helius credits each). An address with more is marked history_complete: false.',
                },
                max_counterparties: {
                    type: 'integer',
                    title: 'Most counterparties per address',
                    default: 50,
                    minimum: 1,
                    maximum: 500,
                    description: 'The busiest pairs are linked; the rest are counted in the summary.',
                },
                token_accounts: {
                    type: 'boolean',
                    title: 'Include token accounts',
                    default: true,
                    description: "Also read transactions that change the balance of a token account the address owns (Helius's balanceChanged filter). Off reads only transactions that name the address itself.",
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
        const maxTx = intParam(ctx.params?.max_transactions, 300, 100, 5000);
        const maxPairs = intParam(ctx.params?.max_counterparties, 50, 1, 500);
        const tokenAccounts = ctx.params?.token_accounts === false ? 'none' : 'balanceChanged';

        const targets = await selectedTargets(ctx);
        if (!targets.nodes.length) {
            return { summary: ['No Solana address was selected', ...targetNotes(targets)].join('. ') + '.', counts: { addresses: 0 } };
        }

        const helius = new Helius(ctx, key);
        const links = new Links(ctx);
        const addresses = new Addresses(ctx);
        for (const n of targets.nodes) addresses.know(n, n.address);

        let read = 0;
        let wrote = 0;
        let incomplete = 0;
        let notLinked = 0;
        let unresolved = 0;
        let zero = 0;
        let wrapped = 0;
        let rent = 0;
        let failed = 0;
        let stop = '';
        const asOf = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

        for (let i = 0; i < targets.nodes.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            const node = targets.nodes[i];
            const address = node.address;
            ctx.progress?.set?.({ percent: Math.round((i / targets.nodes.length) * 100), message: address });
            try {
                const lamports = await helius.balance(address);

                const transfers: Transfer[] = [];
                let examined = 0;
                let newest: string | undefined;
                let oldest: string | undefined;
                let token: string | undefined;
                let complete = false;
                while (examined < maxTx) {
                    if (ctx.signal?.aborted) throw abortErr();
                    const page = await helius.historyPage(address, { sortOrder: 'desc', limit: Math.min(PAGE, maxTx - examined), tokenAccounts, paginationToken: token });
                    for (const tx of page.data) {
                        examined++;
                        const t = isoTime(tx?.blockTime);
                        if (t && (!newest || t > newest)) newest = t;
                        if (t && (!oldest || t < oldest)) oldest = t;
                        const x = transfersOf(tx, t, address);
                        unresolved += x.unresolved;
                        zero += x.zero;
                        wrapped += x.wrapped;
                        for (const tr of x.transfers) {
                            if (tr.from !== address && tr.to !== address) continue;
                            if (isPayment(tr, address)) transfers.push(tr);
                            else rent++;
                        }
                    }
                    token = page.paginationToken ?? undefined;
                    if (!token || !page.data.length) {
                        complete = true;
                        break;
                    }
                }
                read++;
                if (!complete) incomplete++;

                const pairs = aggregate(address, transfers);
                const kept = pairs.slice(0, maxPairs);
                notLinked += pairs.length - kept.length;
                for (const p of kept) {
                    if (ctx.signal?.aborted) throw abortErr();
                    const other = p.from === address ? p.to : p.from;
                    const otherNode = await addresses.ensure(other);
                    const fromId = p.from === address ? node.id : otherNode.id;
                    const toId = p.from === address ? otherNode.id : node.id;
                    const summary = compact({
                        // The oldest transaction read, whether or not it moved value: the window is
                        // what was LOOKED at, so a quiet stretch inside it is a real "nothing".
                        window_from: oldest,
                        window_to: asOf,
                        complete,
                        assets: p.assets,
                        assets_omitted: p.assets_omitted || undefined,
                    });
                    // `recent` is left out of a link whose rows could not be read (graph.ts): sending
                    // this run's rows alone would replace the whole list.
                    await links.put(fromId, toId, 'sent to', (have, unread) => ({
                        network: NETWORK_NAME,
                        [SUMMARY_KEY]: summary,
                        ...(unread ? {} : { recent: mergeRecent(have?.recent, p.recent) }),
                    }));
                    wrote++;
                }

                // `first_seen` only when the whole history was read: the oldest transaction of a
                // history cut off at the limit is not the address's first activity.
                await ctx.graph!.updateNode!(
                    node.id,
                    compact({
                        balance: lamports != null ? formatUnits(lamports, SOL_DECIMALS) : undefined,
                        balance_as_of: lamports != null ? asOf : undefined,
                        balance_source: lamports != null ? 'Helius RPC getBalance' : undefined,
                        last_seen: newest,
                        first_seen: complete ? oldest : undefined,
                        // Transactions read, value or not: the github pack's `forks_examined` reads the same way.
                        history_examined: examined,
                        history_complete: complete,
                    }),
                );
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

        const parts = [`${read} of ${targets.nodes.length} Solana address(es) read from Helius`];
        if (links.created || links.amended) parts.push(`${links.created} new 'sent to' link(s), ${links.amended} existing link(s) given Helius's figures`);
        if (addresses.created) parts.push(`${addresses.created} counterparty address(es)`);
        if (incomplete) parts.push(`${incomplete} address(es) have more history than "Most transactions per address" reached (history_complete: false)`);
        if (notLinked) parts.push(`${notLinked} quieter counterparties not linked (raise "Most counterparties per address")`);
        if (unresolved) parts.push(`${unresolved} token transfer(s) in these transactions could not be tied to wallets, because the transaction does not name the token accounts' owners (activity before December 2022)`);
        if (rent) parts.push(`${rent} rent payment(s) for new token or program accounts not counted as payments`);
        if (wrapped) parts.push(`${wrapped} SOL wrap(s) into the address's own wSOL token account not counted as payments`);
        if (zero) parts.push(`${zero} zero-amount transfer(s) ignored`);
        if (links.unread) parts.push(`${links.unread} existing link(s) kept the recent list they had: their data was not passed to this run (an older Vineyard does not pass a link's data to plugins), so Helius's latest transfers could not be merged into it`);
        parts.push(...targetNotes(targets));
        if (failed) parts.push(`${failed} lookup(s) failed`);
        parts.push(helius.costLine());
        if (stop) parts.push(stop);
        return {
            summary: parts.join('. ') + '.',
            counts: { addresses: read, links_created: links.created, links_amended: links.amended, counterparties: addresses.created, failed },
        };
    },
});
