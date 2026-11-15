// What a Helius identity label says an address belongs to, in the type packs' terms.
//
// Pure and dependency-free so test/pure.test.mjs can import it.
//
// Helius files every labelled account under one category of its Orb identity database (the list is
// on https://www.helius.dev/docs/wallet-api/identity, "Identity categories"). Only the categories
// that name WHO holds the address become a node to attribute it to; the rest stay a label on the
// address, because a node needs a kind and a name that mean the same thing to every pack that
// writes one:
//
//   - Centralized Exchange → `financial.exchange`. The Cryptocurrency type pack puts every
//     custodian there, so a wallet Helius calls "Binance 1" and one another source calls Binance
//     meet on one Binance node.
//   - Cross-chain Bridge, DeFi (and its kin), Casino & Gambling → `cryptocurrency.crypto_service`,
//     the pack's type for services that do not hold customers' funds.
//   - Market Maker, Trading Firm → `identity.organization`, a company.
//
// Not attributed, and why: Key Opinion Leader names a person, and a person's name alone would merge
// strangers (identity.person is identified by name); Scammer, Hacker, Rugger and the like are
// claims about the address, not an owner, and stay in `helius_category` where the analyst sees them;
// Payments mixes custodial processors with protocols such as Solana Pay; Vault says "custody" without
// saying whose. Everything else (Validator, Treasury, Tools, Jito, …) is infrastructure, not a party.

export type Target =
    | { type: 'financial.exchange'; data: { name: string } }
    | { type: 'cryptocurrency.crypto_service'; data: { name: string; service_type: 'bridge' | 'defi' | 'gambling'; attribution_source: string } }
    | { type: 'identity.organization'; data: { name: string; org_type: 'company' } };

const fold = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/**
 * The owner's name from a wallet label: "Binance 1" → "Binance", "Bybit Hot Wallet" → "Bybit",
 * "Stake.com Hot Wallet" → "Stake.com", "Wintermute 2" → "Wintermute".
 *
 * Helius names an owner's wallets after the owner plus a number or a wallet kind, and one owner's
 * wallets come under several such names. Kept whole, each would be an owner node of its own and the
 * `attributed to` links that should gather an owner's wallets would scatter them. Only those endings
 * are cut; anything else is kept as written, so a guess never renames an owner.
 *
 * `exchange` also cuts a trailing "Exchange": the node is an Exchange already, and Helius's own
 * documented example "OKX Exchange 1" would otherwise make an "OKX Exchange" node that an OKX wallet
 * labelled any other way, or another source's OKX, never meets.
 */
export function ownerName(label: string, exchange = false): string {
    let s = label.trim();
    for (;;) {
        let next = s
            .replace(/\s+#?\d+$/, '')
            .replace(/\s+(hot|cold|deposit|withdrawal|exchange|treasury)?\s*wallet$/i, '')
            .trim();
        if (exchange) next = next.replace(/\s+exchange$/i, '').trim();
        if (next === s || !next) return s;
        s = next;
    }
}

/**
 * The node a label attributes its address to, or null.
 *
 * `category` is the Orb category ("Centralized Exchange"); `type` is Helius's short kind
 * ("exchange"), which `funded-by` gives as `funderType` and whose documented examples also include
 * "defi-protocol". Either is enough; the category wins when both are there.
 */
export function targetFor(name: string, category?: unknown, type?: unknown): Target | null {
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label) return null;
    const c = fold(category);
    const t = fold(type);
    if (c === 'centralized exchange' || (!c && t === 'exchange')) return { type: 'financial.exchange', data: { name: ownerName(label, true) } };
    const owner = ownerName(label);
    const service = (kind: 'bridge' | 'defi' | 'gambling'): Target => ({
        type: 'cryptocurrency.crypto_service',
        data: { name: owner, service_type: kind, attribution_source: 'Helius' },
    });
    if (c === 'cross-chain bridge' || (!c && (t === 'bridge' || t === 'cross-chain bridge'))) return service('bridge');
    if (['defi', 'proprietary amm', 'restaking', 'stake pool'].includes(c) || (!c && /^defi(-protocol)?$/.test(t))) return service('defi');
    if (c === 'casino & gambling' || (!c && (t === 'gambling' || t === 'casino'))) return service('gambling');
    if (c === 'market maker' || c === 'trading firm') return { type: 'identity.organization', data: { name: owner, org_type: 'company' } };
    return null;
}
