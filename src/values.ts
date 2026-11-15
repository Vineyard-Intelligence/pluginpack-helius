// Value conversions every Helius plugin shares: Solana addresses, base-unit amounts, block times,
// and reading JSON without losing integers.
//
// Pure and dependency-free so test/pure.test.mjs can import it.

// ---- Solana addresses ------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet, which Solana uses) to bytes, or null when a character is outside it. */
export function base58Decode(s: string): Uint8Array | null {
    if (!s || s.length > 64) return null;
    const bytes: number[] = [];
    for (const ch of s) {
        let carry = B58.indexOf(ch);
        if (carry < 0) return null;
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    let zeros = 0;
    while (zeros < s.length && s[zeros] === '1') zeros++;
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
    return out;
}

/**
 * Whether a value is a Solana account address: Base58 that decodes to exactly 32 bytes.
 *
 * Checked before any request, because Helius bills a request whatever it finds and an `unknown`
 * network node holding a TRON or Bitcoin value would otherwise cost one. The length bounds (32–44
 * characters) are what 32 bytes can encode to; the decode is what settles it.
 */
export function isSolanaAddress(s: unknown): s is string {
    if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
    const b = base58Decode(s);
    return !!b && b.length === 32;
}

/** The System Program: what owns a plain wallet. */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAMS = new Set([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
]);

/**
 * Mints whose symbol is written next to the mint address. Only these: a symbol is whatever the
 * token's metadata claims, and spam tokens routinely claim "USDC". For these three the mint IS the
 * identity, so the symbol cannot be a lie. Every other token keeps only its mint.
 */
export const KNOWN_MINTS: Record<string, { symbol: string; decimals: number }> = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
    So11111111111111111111111111111111111111112: { symbol: 'wSOL', decimals: 9 },
};

/** SOL, as the Cryptocurrency type pack writes a network's own coin: `native`, not a token. */
export const NATIVE = 'native';
export const SOL_DECIMALS = 9;

// ---- amounts ---------------------------------------------------------------------------------

/**
 * An integer amount in base units as a BigInt, or null.
 *
 * Takes the three shapes an amount arrives in: a string of digits (SPL amounts in jsonParsed, and
 * lamports read through parseExact), a safe integer (most lamports), or a BigInt already.
 */
export function toBigInt(v: unknown): bigint | null {
    if (typeof v === 'bigint') return v >= 0n ? v : null;
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
    if (typeof v === 'string' && /^\d{1,40}$/.test(v)) return BigInt(v);
    return null;
}

/**
 * Base units to a decimal string: 98119720 lamports at 9 decimals is "0.09811972".
 *
 * A decimal STRING because the Cryptocurrency type pack's amounts are strings: `number` loses
 * integers above 2^53 and a token with 9 decimals passes that at nine million units.
 */
export function formatUnits(raw: bigint | string, decimals: number): string {
    const v = typeof raw === 'bigint' ? raw : BigInt(raw);
    if (!Number.isInteger(decimals) || decimals <= 0) return v.toString();
    const s = v.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals);
    const frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

// ---- time ------------------------------------------------------------------------------------

/** A block time in Unix seconds to ISO 8601 UTC without milliseconds, or undefined. */
export function isoTime(sec: unknown): string | undefined {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return undefined;
    return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- JSON ------------------------------------------------------------------------------------

/**
 * JSON.parse that keeps every integer above 2^53 as its digit string.
 *
 * WHY: lamports are u64 and JSON-RPC sends them as bare numbers. All SOL in existence is about
 * 6×10^17 lamports, past 2^53 (9×10^15), so one transfer of more than ~9 million SOL — an exchange
 * moving its cold wallet — would parse to a rounded number and its amount would be quietly wrong.
 * The reviver's source text (ES2025, in V8 since Chrome 114 and Node 21) has the digits as sent.
 * An engine without it leaves the number as JSON.parse made it, which is the old behaviour.
 */
export function parseExact(text: string): unknown {
    return JSON.parse(text, function (_key, value, context?: { source?: string }) {
        if (
            typeof value === 'number' &&
            Number.isInteger(value) &&
            !Number.isSafeInteger(value) &&
            typeof context?.source === 'string' &&
            /^\d+$/.test(context.source)
        ) {
            return context.source;
        }
        return value;
    } as (this: any, key: string, value: any) => any);
}

// ---- misc ------------------------------------------------------------------------------------

/** The object without its undefined, null and empty-string values. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
    return out as Partial<T>;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "1 address" / "2 addresses". */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
