// Graph writes shared by the plugins: Solana address nodes, labels on them, and links that follow
// the Cryptocurrency type pack's rule of one link per pair.
import type { GraphEdge, GraphNode, HostContext } from './sdk';
import { ADDRESS, NETWORK_NAME } from './common';
import { str } from './values';

/**
 * Links as the project holds them, by ordered pair, plus the pairs this run has written.
 *
 * WHY READ BEFORE WRITING. A pair has one link (the backend's unique constraint), and `createEdge`
 * against a pair that already has one is a proposal to RELABEL it (host-bridge.ts). The type pack's
 * rule for collectors is never to relabel: an analyst's `paid` between two wallets stays `paid`, and
 * Helius's figures are added to it as data. So an existing link is amended by id with `updateEdge`,
 * which leaves its label and grade alone, and only a pair with no link gets `createEdge`.
 *
 * Each pair is written once per run: every plugin aggregates first and writes after, because a
 * second create for a pair this run already staged would not see the first (staged links are not
 * in the project yet) and would stage a duplicate.
 *
 * AN EXISTING LINK'S DATA MAY BE UNREADABLE. The SDK's GraphEdge promises `data`, and the app's
 * host hands plugins a copy of it (host-bridge.ts toEdge, frontend main 2026-11-16), so a re-run
 * merges its rows into the `recent` list a link holds. Older versions of the app built `edges()`
 * without it (id, endpoints and label only; the Blockchair pack measured that on 2026-11-15). A key
 * that merges with what the link holds (`recent`) cannot be merged with what cannot be read, and
 * commit replaces a top-level key whole: sending this run's rows would drop every row the link had,
 * another collector's and an earlier, deeper run's. So `put` tells the data function whether the
 * link's data was read, and the caller leaves such keys out when it was not; `unread` counts those
 * links for the summary.
 */
export class Links {
    private byPair: Map<string, GraphEdge> | null = null;
    private readonly written = new Set<string>();
    created = 0;
    amended = 0;
    /** Existing links amended without the keys that merge, because their data could not be read. */
    unread = 0;

    constructor(private readonly ctx: HostContext) {}

    private async index(): Promise<Map<string, GraphEdge>> {
        if (!this.byPair) {
            this.byPair = new Map();
            for (const e of (await this.ctx.graph?.edges?.()) ?? []) this.byPair.set(`${e.from_node_id}\0${e.to_node_id}`, e);
        }
        return this.byPair;
    }

    /**
     * Add `data` to the pair's link, or create it with `label` when the pair has none. `data` may be
     * a function of the existing link's data, for keys that merge (the recent list); `unread` is
     * true when the pair has a link whose data the host did not pass, and such keys are then left
     * out (see above).
     */
    async put(
        from: string,
        to: string,
        label: string,
        data: Record<string, unknown> | ((existing: Record<string, unknown> | undefined, unread: boolean) => Record<string, unknown>),
    ): Promise<'created' | 'amended' | 'skipped'> {
        const key = `${from}\0${to}`;
        if (this.written.has(key) || from === to) return 'skipped';
        this.written.add(key);
        const have = (await this.index()).get(key);
        const known = have?.data && typeof have.data === 'object' ? have.data : undefined;
        const unread = !!have && !known;
        if (unread && typeof data === 'function') this.unread++;
        const payload = typeof data === 'function' ? data(known, unread) : data;
        if (have) {
            if (this.ctx.graph?.updateEdge) await this.ctx.graph.updateEdge(have.id, { data: payload });
            // An older host without updateEdge: restating the link's own label with data is the same
            // amendment (host-bridge.ts stages it with no label change).
            else await this.ctx.graph!.createEdge!({ from, to, label: have.label, data: payload });
            this.amended++;
            return 'amended';
        }
        await this.ctx.graph!.createEdge!({ from, to, label, data: payload });
        this.created++;
        return 'created';
    }
}

/**
 * Solana address nodes, made at most once per address per run. The host de-duplicates by the type
 * pack's identity (network + address; Base58 compared exactly), so an address already in the
 * project comes back as that node, which is what `labelFields` needs to read.
 */
export class Addresses {
    private readonly nodes = new Map<string, GraphNode>();
    created = 0;

    constructor(private readonly ctx: HostContext) {}

    /** A node already in hand: the seed, so a transfer to itself never makes a second node. */
    know(node: GraphNode, address: string): void {
        this.nodes.set(address, node);
    }

    async ensure(address: string): Promise<GraphNode> {
        const have = this.nodes.get(address);
        if (have) return have;
        const n = await this.ctx.graph!.createNode!({ type: ADDRESS, data: { network: NETWORK_NAME, address } });
        this.nodes.set(address, n);
        this.created++;
        return n;
    }
}

/**
 * Helius's name for an address, as fields to write on its node.
 *
 * `public_label` is shared with every collector that has a label for an address (an explorer's tag,
 * the owner label Identify Crypto Network carries over from a legacy Financial node), and the node
 * holds one. So Helius's name is written there only when the node has none or the one it has is
 * Helius's own; otherwise the other source's label stays and Helius's goes in `helius_label`, where
 * it is still seen. Rewriting it each run would make the label flip between sources with every
 * collector that ran last.
 */
export function labelFields(node: GraphNode | null | undefined, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const label = str(name);
    if (!label) return { ...extra };
    const current = str(node?.data?.public_label);
    const source = str(node?.data?.label_source);
    if (!current || source === 'Helius') return { ...extra, public_label: label, label_source: 'Helius' };
    return { ...extra, helius_label: label };
}
