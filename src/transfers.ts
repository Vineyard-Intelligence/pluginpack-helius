// Value movements in one Solana transaction, read from its `jsonParsed` form.
//
// Pure and dependency-free so test/pure.test.mjs can import it.
//
// WHY INSTRUCTIONS AND NOT BALANCE CHANGES. `meta.preBalances`/`postBalances` say how much each
// account gained or lost, but not from whom: a swap, a fee and a payout in one transaction are three
// unrelated movements, and pairing the losers with the gainers would invent links between parties
// that never paid each other. A transfer instruction names both sides. So the parsed System Program
// and SPL Token instructions are read — top-level and inner (CPI) alike, since a program that pays
// someone does it with an inner transfer — and nothing is inferred from balances.
//
// What this does not see, by construction: lamports a program moves by editing an account it owns
// directly (no instruction to read), and the rent an account returns when it is closed. Both are
// written on the pack page.
//
// WRAPPING IS NOT A PAYMENT. To swap SOL, a wallet sends SOL into its own wSOL token account
// (System transfer, then syncNative) and the swap moves the wSOL on. Read as a transfer between
// accounts, the first step links the wallet `sent to` its own token account — a deterministic
// address, so the same false counterparty on every swap, soon the busiest pair the wallet has —
// and the same SOL is counted again as the wSOL paid to the pool. So SOL sent into a token account
// is read as going to the token account's OWNER: dropped and counted when that is the sender
// (`wrapped`), a payment to the owner otherwise.
import { KNOWN_MINTS, NATIVE, SOL_DECIMALS, str, toBigInt } from './values';

/** One movement of value between two wallets. `raw` is an integer string in base units. */
export interface Transfer {
    tx_hash: string;
    time?: string;
    slot?: number;
    from: string;
    to: string;
    /** `native` for SOL, else the token's mint. */
    asset: string;
    symbol?: string;
    /** null when the transaction does not say the token's decimals: the amount stays in base units. */
    decimals: number | null;
    raw: string;
    /**
     * For a System `createAccount`: the program the new account belongs to. A new token account or
     * program-owned account is rent, not a payment to a wallet, and the caller decides (see
     * history.ts and funder.ts) — the funder wants it when the new account is the wallet itself.
     * Empty when the instruction does not name one, which the caller treats as not a wallet.
     */
    created_owner?: string;
    /**
     * Set when SOL went into a token account (wSOL) and `to` is that account's owner: the token
     * account. The owner holds the value, but its own SOL balance did not rise, so this is never
     * the owner's first funding.
     */
    via_token_account?: string;
}

export interface Extracted {
    transfers: Transfer[];
    /** Token transfers whose token accounts' owners the transaction does not name (before Dec 2022). */
    unresolved: number;
    /** Transfers of zero: address-poisoning spam sends these, and they move nothing. */
    zero: number;
    /** SOL a wallet sent into its own token account to wrap it as wSOL (see WRAPPING above). */
    wrapped: number;
}

const EMPTY: Extracted = { transfers: [], unresolved: 0, zero: 0, wrapped: 0 };

/**
 * The account addresses of a transaction, in the order its indexes count them.
 *
 * jsonParsed gives objects ({pubkey, signer, writable, source}) and already includes the accounts a
 * v0 transaction loads from lookup tables. Plain `json` gives strings and leaves the loaded ones in
 * `meta.loadedAddresses` (writable first, then readonly), which is the order indexes continue in.
 */
export function accountKeys(tx: any): string[] {
    const raw = tx?.transaction?.message?.accountKeys;
    if (!Array.isArray(raw)) return [];
    const keys = raw.map((k: any) => (typeof k === 'string' ? k : typeof k?.pubkey === 'string' ? k.pubkey : ''));
    if (raw.length && typeof raw[0] === 'string') {
        const la = tx?.meta?.loadedAddresses;
        for (const k of [...(la?.writable ?? []), ...(la?.readonly ?? [])]) keys.push(typeof k === 'string' ? k : '');
    }
    return keys;
}

interface TokenAccount {
    mint?: string;
    owner?: string;
    decimals?: number;
}

/**
 * Token account → its mint, owner and decimals, from what the transaction itself states.
 *
 * `pre/postTokenBalances` carry `owner` since slot 111,491,819 (December 2022); before that only the
 * mint. Instructions that create or initialise a token account in the same transaction name its
 * owner too, so those fill the gaps they can.
 */
function tokenAccounts(tx: any, keys: string[], ixs: any[]): Map<string, TokenAccount> {
    const out = new Map<string, TokenAccount>();
    const put = (acct: unknown, v: TokenAccount) => {
        if (typeof acct !== 'string' || !acct) return;
        const have = out.get(acct) ?? {};
        out.set(acct, {
            mint: have.mint ?? v.mint,
            owner: have.owner ?? v.owner,
            decimals: have.decimals ?? v.decimals,
        });
    };
    for (const list of [tx?.meta?.postTokenBalances, tx?.meta?.preTokenBalances]) {
        if (!Array.isArray(list)) continue;
        for (const b of list) {
            const acct = keys[b?.accountIndex];
            const dec = b?.uiTokenAmount?.decimals;
            put(acct, {
                mint: typeof b?.mint === 'string' ? b.mint : undefined,
                owner: typeof b?.owner === 'string' && b.owner ? b.owner : undefined,
                decimals: Number.isInteger(dec) ? dec : undefined,
            });
        }
    }
    for (const ix of ixs) {
        const t = ix?.parsed?.type;
        const info = ix?.parsed?.info;
        if (!info || typeof info !== 'object') continue;
        if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') && /^initializeAccount[23]?$/.test(t)) {
            put(info.account, { mint: info.mint, owner: info.owner });
        } else if (ix.program === 'spl-associated-token-account' && (t === 'create' || t === 'createIdempotent')) {
            put(info.account, { mint: info.mint, owner: info.wallet });
        }
    }
    return out;
}

/** Every instruction of the transaction, top level then each one's inner instructions. */
function allInstructions(tx: any): any[] {
    const top = tx?.transaction?.message?.instructions;
    const out: any[] = Array.isArray(top) ? [...top] : [];
    const inner = tx?.meta?.innerInstructions;
    if (Array.isArray(inner)) for (const group of inner) if (Array.isArray(group?.instructions)) out.push(...group.instructions);
    return out;
}

/**
 * The transfers in one transaction from `getTransactionsForAddress` (full, jsonParsed).
 *
 * A failed transaction moves nothing and gives nothing, whatever its instructions say. `focus`, when
 * given, limits the zero-amount and wrap counts to transfers of that address; `unresolved` cannot be
 * limited, since an owner the transaction does not name could be anyone's.
 */
export function transfersOf(tx: any, time?: string, focus?: string): Extracted {
    const sig = tx?.transaction?.signatures?.[0];
    if (typeof sig !== 'string' || !sig) return EMPTY;
    if (tx?.meta?.err != null) return EMPTY;
    const slot = typeof tx?.slot === 'number' ? tx.slot : undefined;
    const keys = accountKeys(tx);
    const ixs = allInstructions(tx);
    const accounts = tokenAccounts(tx, keys, ixs);
    const out: Transfer[] = [];
    let unresolved = 0;
    let zero = 0;
    let wrapped = 0;

    const push = (t: Omit<Transfer, 'tx_hash' | 'time' | 'slot'>) => {
        if (!t.from || !t.to || t.from === t.to) return;
        if (/^0+$/.test(t.raw)) {
            if (!focus || t.from === focus || t.to === focus) zero++;
            return;
        }
        out.push({ tx_hash: sig, time, slot, ...t });
    };

    for (const ix of ixs) {
        const p = ix?.parsed;
        if (!p || typeof p !== 'object') continue;
        const info = p.info;
        if (!info || typeof info !== 'object') continue;
        if (ix.program === 'system') {
            let from: unknown;
            let to: unknown;
            let created: string | undefined;
            if (p.type === 'transfer' || p.type === 'transferWithSeed') {
                from = info.source;
                to = info.destination;
            } else if (p.type === 'createAccount' || p.type === 'createAccountWithSeed') {
                from = info.source;
                to = info.newAccount;
                created = typeof info.owner === 'string' ? info.owner : '';
            } else if (p.type === 'withdrawNonceAccount') {
                from = info.nonceAccount;
                to = info.destination;
            } else continue;
            const raw = toBigInt(info.lamports);
            if (raw == null || typeof from !== 'string' || typeof to !== 'string') continue;
            // SOL into a token account the transaction names (its balances, or the instruction
            // that opened it): wrapping, read as going to the account's owner. Not for a
            // createAccount, whose lamports are the new account's rent (history.ts isPayment).
            let via: string | undefined;
            let dest: string = to;
            const ta = created === undefined && raw > 0n ? accounts.get(to) : undefined;
            if (ta) {
                if (!ta.owner) {
                    unresolved++;
                    continue;
                }
                if (ta.owner === from) {
                    if (!focus || from === focus) wrapped++;
                    continue;
                }
                via = to;
                dest = ta.owner;
            }
            push({
                from,
                to: dest,
                asset: NATIVE,
                symbol: 'SOL',
                decimals: SOL_DECIMALS,
                raw: raw.toString(),
                ...(created !== undefined ? { created_owner: created } : {}),
                ...(via ? { via_token_account: via } : {}),
            });
        } else if (ix.program === 'spl-token' || ix.program === 'spl-token-2022') {
            let raw: bigint | null;
            let mint: string | undefined;
            let decimals: number | undefined;
            if (p.type === 'transfer') {
                raw = toBigInt(info.amount);
            } else if (p.type === 'transferChecked' || p.type === 'transferCheckedWithFee') {
                raw = toBigInt(info.tokenAmount?.amount);
                mint = typeof info.mint === 'string' ? info.mint : undefined;
                decimals = Number.isInteger(info.tokenAmount?.decimals) ? info.tokenAmount.decimals : undefined;
            } else continue;
            if (raw == null) continue;
            const src = accounts.get(info.source);
            const dst = accounts.get(info.destination);
            mint = mint ?? src?.mint ?? dst?.mint;
            const from = src?.owner;
            const to = dst?.owner;
            if (!from || !to || !mint) {
                unresolved++;
                continue;
            }
            decimals = decimals ?? src?.decimals ?? dst?.decimals ?? KNOWN_MINTS[mint]?.decimals;
            push({
                from,
                to,
                asset: mint,
                symbol: KNOWN_MINTS[mint]?.symbol,
                decimals: decimals ?? null,
                raw: raw.toString(),
            });
        }
    }
    return { transfers: out, unresolved, zero, wrapped };
}

/**
 * The SOL transfer to the address in this transaction, if any.
 *
 * Any System transfer to it counts, and so does the `createAccount` that made it, whatever program
 * the new account was made for: either puts lamports in the address. Token transfers do not, and
 * nor does SOL wrapped into a token account it owns: an account can be named as the owner of a
 * token account before it has ever held SOL.
 */
export function fundingIn(tx: any, address: string, time?: string): Transfer | null {
    for (const t of transfersOf(tx, time).transfers) {
        if (t.to === address && t.asset === NATIVE && !t.via_token_account) return t;
    }
    return null;
}

/** What one transaction says about when the address first held SOL. */
export type Activation =
    /** The transaction does not give the address's balances (not among its accounts, or no meta). */
    | { state: 'unknown' }
    /** No SOL before it or after it: the address is named (as a token account's owner, say) but unfunded. */
    | { state: 'unfunded' }
    /** The address already held SOL when the transaction began. */
    | { state: 'already' }
    /**
     * Its balance rose from zero here. `funding` is the SOL transfer to it in this transaction, or
     * null when the lamports came another way; `by` then names the instruction that paid out to
     * it, when one does so by name (`spl-token closeAccount`, `stake withdraw`).
     */
    | { state: 'activated'; funding: Transfer | null; by?: string };

/**
 * Whether this transaction is the one in which the address first held SOL, read from
 * `meta.preBalances`/`postBalances`.
 *
 * WHY BALANCES HERE, when transfers are read from instructions everywhere else: the question is not
 * who paid whom but when the address's balance first rose from zero, which only the balances
 * answer. A wallet whose first lamports came from a closed token account (`closeAccount` names it
 * the destination), a stake withdrawal or a program has no System transfer in that transaction,
 * and taking the first System transfer instead would name whoever paid it LATER as its first funder.
 */
export function activationIn(tx: any, address: string, time?: string): Activation {
    const i = accountKeys(tx).indexOf(address);
    const pre = i >= 0 ? toBigInt(tx?.meta?.preBalances?.[i]) : null;
    const post = i >= 0 ? toBigInt(tx?.meta?.postBalances?.[i]) : null;
    if (pre == null || post == null) return { state: 'unknown' };
    if (pre > 0n) return { state: 'already' };
    if (post === 0n) return { state: 'unfunded' };
    if (tx?.meta?.err != null) return { state: 'unknown' };
    const funding = fundingIn(tx, address, time);
    if (funding) return { state: 'activated', funding };
    for (const ix of allInstructions(tx)) {
        const info = ix?.parsed?.info;
        if (info && typeof info === 'object' && info.destination === address && typeof ix.parsed.type === 'string') {
            return { state: 'activated', funding: null, by: `${typeof ix.program === 'string' ? ix.program : str(ix.programId) || 'a program'} ${ix.parsed.type}` };
        }
    }
    return { state: 'activated', funding: null };
}
