// Solana Wallet Identity — a Solana address → who Helius says it is (paid Helius plans only).
import { definePlugin } from './sdk';
import type { GraphNode, HostContext, RunResult } from './sdk';
import {
    abortErr,
    crypto,
    FINANCIAL,
    GRAPH_SCOPES,
    Helius,
    IDENTITY,
    ItemFailed,
    KEY_CONFIG,
    LIFECYCLE,
    NETWORK,
    PLATFORMS,
    PlanRequired,
    requireKey,
    requireNet,
    selectedTargets,
    StopRun,
    stopped,
    targetNotes,
} from './common';
import { targetFor } from './attribution';
import type { Target } from './attribution';
import { labelFields, Links } from './graph';
import { compact, str } from './values';

export const ATTRIBUTION_KEY = 'attribution_helius';

/**
 * Why `label_kind` is `public_tag`. The type pack's kinds are `verified`, `prediction` and
 * `public_tag`; Helius does not grade its labels, and publishes the same ones as tags on its Orb
 * explorer, which is what `public_tag` stands for. Calling them verified would be a claim Helius
 * does not make.
 */
const LABEL_KIND = 'public_tag';

/** An identity answer, read defensively (wallet-api/identity, 2026-11-15). */
export function identityOf(r: any): { name: string; type?: string; category?: string; tags: string[]; domains: string[] } | null {
    const name = str(r?.name);
    if (!name) return null;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, 50) : []);
    return { name, type: str(r?.type) || undefined, category: str(r?.category) || undefined, tags: list(r?.tags), domains: list(r?.domainNames) };
}

/**
 * Owner nodes for one run, each resolved to ONE node, reused where the project has it.
 *
 * WHY AN EXISTING NODE IS LOOKED FOR FIRST, rather than handed to createNode to de-duplicate:
 * createNode merges whatever it is given onto a node that already exists, so creating "Jupiter"
 * with service_type defi and attribution_source Helius would overwrite what the analyst or another
 * source wrote there, at commit, on a node nobody asked about — and an Organization the analyst
 * typed `criminal` would come back `company`. An existing owner is linked as it stands and nothing on
 * it is written. Found by name without regard to case, so the analyst's "binance" is Helius's
 * Binance.
 */
class Owners {
    private readonly made = new Map<string, string>();
    private readonly existing = new Map<string, Map<string, string>>();
    created = 0;
    reused = 0;
    constructor(private readonly ctx: HostContext) {}

    private async index(type: string): Promise<Map<string, string>> {
        let m = this.existing.get(type);
        if (m) return m;
        m = new Map();
        try {
            const { nodes } = (await this.ctx.graph?.list?.({ type })) ?? { nodes: [] };
            for (const n of nodes) {
                if (n.type !== type) continue;
                const name = str(n.data?.name).toLowerCase();
                // An exact spelling is kept over a folded one: the first node of a name stays.
                if (name && !m.has(name)) m.set(name, String(n.id));
            }
        } catch {
            /* an unreadable list only means nothing is reused */
        }
        this.existing.set(type, m);
        return m;
    }

    async ensure(t: Target): Promise<string> {
        const k = `${t.type}|${t.data.name.toLowerCase()}`;
        const have = this.made.get(k);
        if (have) return have;
        const found = (await this.index(t.type)).get(t.data.name.toLowerCase());
        if (found) {
            this.made.set(k, found);
            this.reused++;
            return found;
        }
        const n = await this.ctx.graph!.createNode!({ type: t.type, data: { ...t.data } });
        this.made.set(k, String(n.id));
        this.created++;
        return String(n.id);
    }
}

export const walletIdentity = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.helius_wallet_identity',
        content_type: 'vineyard:plugin',
        name: 'Solana Wallet Identity',
        version: '1.0.0',
        description:
            "Asks the Helius Wallet API (identity) who each selected Crypto Address on network solana belongs to, from the labels behind Helius's Orb explorer. Writes Helius's name as public_label (label_source Helius) when the address has no label from another source, else as helius_label, plus helius_category (e.g. Centralized Exchange, DeFi, Scammer), helius_type, helius_tags and helius_domains (its .sol and other on-chain domains). When the category names who holds the address it is linked 'attributed to' that owner, with attribution_helius (label, label_kind public_tag, category, as_of) on the link: a Centralized Exchange to its Exchange ('Binance 1' to Binance), a bridge, DeFi protocol or casino to a Crypto Service, a market maker or trading firm to an Organization. Other categories (Scammer, Hacker, Key Opinion Leader, …) stay labels. Needs a paid Helius plan (Developer or above); the free plan's key gets 403.",
        icon: 'tag',
        platforms: PLATFORMS,
        params: { type: 'object', properties: {} },
        io: {
            consumes: [crypto('crypto_address')],
            produces: [
                crypto('crypto_address'),
                crypto('crypto_service'),
                { typepack: FINANCIAL, category: 'financial', name: 'exchange' },
                { typepack: IDENTITY, category: 'identity', name: 'organization' },
            ],
        },
        scopes: { graph: GRAPH_SCOPES, network: NETWORK, config: [KEY_CONFIG] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const key = requireKey(ctx);
        const targets = await selectedTargets(ctx);
        if (!targets.nodes.length) {
            return { summary: ['No Solana address was selected', ...targetNotes(targets)].join('. ') + '.', counts: { addresses: 0 } };
        }

        const helius = new Helius(ctx, key);
        const links = new Links(ctx);
        const owners = new Owners(ctx);
        const asOf = new Date().toISOString().slice(0, 10);
        let named = 0;
        let unknown = 0;
        let attributed = 0;
        let failed = 0;
        let wrote = 0;
        let stop = '';
        const refused = new Map<string, string>();

        for (let i = 0; i < targets.nodes.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            const node: GraphNode & { address: string } = targets.nodes[i];
            ctx.progress?.set?.({ percent: Math.round((i / targets.nodes.length) * 100), message: node.address });
            try {
                const r = await helius.wallet(`${encodeURIComponent(node.address)}/identity`);
                if (r === null) {
                    // 404: "The wallet has no identity entry" — a real negative, nothing to write.
                    unknown++;
                    continue;
                }
                const id = identityOf(r);
                if (!id) throw new ItemFailed('identity answered without a name');
                await ctx.graph!.updateNode!(
                    node.id,
                    labelFields(
                        node,
                        id.name,
                        compact({
                            helius_category: id.category,
                            helius_type: id.type,
                            helius_tags: id.tags.length ? id.tags : undefined,
                            helius_domains: id.domains.length ? id.domains : undefined,
                        }),
                    ),
                );
                named++;
                wrote++;
                const target = targetFor(id.name, id.category, id.type);
                if (target) {
                    let ownerId: string | null = null;
                    try {
                        ownerId = await owners.ensure(target);
                    } catch (e) {
                        // A project without the type pack that defines the owner's type refuses the
                        // node. The address keeps its label; only the link is lost, and the summary
                        // names the pack to install.
                        refused.set(target.type, e instanceof Error ? e.message : String(e));
                    }
                    if (ownerId) {
                        await links.put(node.id, ownerId, 'attributed to', {
                            [ATTRIBUTION_KEY]: compact({ label: id.name, label_kind: LABEL_KIND, category: id.category, as_of: asOf }),
                        });
                        attributed++;
                    }
                }
            } catch (e) {
                if (e instanceof PlanRequired) {
                    // The plan, not the address. Before anything was written this is a failed task
                    // that says what to do; after, the names already found are kept.
                    const msg = 'Helius identity needs a paid Helius plan (Developer or above); the free plan answers 403. The other two plugins in this pack work on the free plan';
                    if (!wrote) throw new Error(msg);
                    stop = `STOPPED: ${msg}. ${targets.nodes.length - i} address(es) were not looked up`;
                    break;
                }
                if (e instanceof StopRun) {
                    stop = stopped(e, wrote, targets.nodes.length - i);
                    break;
                }
                if (e instanceof ItemFailed) {
                    failed++;
                    ctx.progress?.log?.(`${node.address}: ${e.message}`);
                    continue;
                }
                throw e;
            }
        }
        ctx.progress?.set?.({ percent: 100 });

        const parts = [`Helius names ${named} of ${targets.nodes.length} Solana address(es)`];
        if (attributed) parts.push(`${attributed} linked 'attributed to' an owner (${owners.created} new owner node(s), ${owners.reused} already in the project)`);
        if (unknown) parts.push(`${unknown} have no Helius identity`);
        for (const [type, why] of refused) parts.push(`no ${type} node could be made, so those labels were not linked to an owner (${why.slice(0, 160)})`);
        parts.push(...targetNotes(targets));
        if (failed) parts.push(`${failed} lookup(s) failed`);
        parts.push(helius.costLine());
        if (stop) parts.push(stop);
        return { summary: parts.join('. ') + '.', counts: { named, attributed, unknown, failed } };
    },
});
