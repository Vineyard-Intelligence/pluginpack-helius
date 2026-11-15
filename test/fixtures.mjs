// Response shapes for the Helius mock tests.
//
// NOT RECORDED: no Helius key was at hand when this pack was written (2026-11-15). Each shape is
// built from public documentation instead:
//   - getTransactionsForAddress: https://www.helius.dev/docs/rpc/gettransactionsforaddress
//     (`result.data`, `result.paginationToken`, full mode = getTransaction's shape)
//   - a transaction in `jsonParsed`: Solana's getTransaction documentation (accountKeys as
//     {pubkey, signer, writable, source}; parsed System and SPL Token instructions; inner
//     instructions; pre/postTokenBalances with accountIndex, mint, owner, uiTokenAmount)
//   - funded-by and identity: https://www.helius.dev/docs/wallet-api/funded-by and /identity
//     (their example bodies, and the 404 body `{"error": …, "code": 404}`)
//   - the 401: MEASURED 2026-11-15 without a key, plain text "Unauthorized" on both hosts.
// The addresses are made up from fixed bytes; the documented example addresses are used where a
// doc example is reproduced.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58(bytes) {
    const digits = [];
    for (const byte of bytes) {
        let carry = byte;
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = '';
    for (const b of bytes) {
        if (b !== 0) break;
        out += '1';
    }
    for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
    return out;
}
/** A made-up 32-byte account address, distinct per n. */
export const addr = (n) => b58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0x80 | (n & 0x7f) : (n * 31 + i * 7) & 0xff)));
/** A made-up 64-byte signature, distinct per n. */
export const sig = (n) => b58(Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? 0x90 | (n & 0x0f) : (n * 17 + i * 13 + (n >> 4)) & 0xff)));

export const SYS = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const WSOL = 'So11111111111111111111111111111111111111112';

export const sysTransfer = (source, destination, lamports) => ({
    program: 'system',
    programId: SYS,
    parsed: { type: 'transfer', info: { source, destination, lamports } },
    stackHeight: null,
});
export const createAccount = (source, newAccount, lamports, owner) => ({
    program: 'system',
    programId: SYS,
    parsed: { type: 'createAccount', info: { source, newAccount, lamports, space: 165, owner } },
    stackHeight: 2,
});
const ui = (amount, decimals) => {
    const s = String(amount).padStart(decimals + 1, '0');
    const str = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '');
    return { amount: String(amount), decimals, uiAmount: Number(str), uiAmountString: str };
};
export const transferChecked = (source, destination, authority, mint, amount, decimals) => ({
    program: 'spl-token',
    programId: TOKEN,
    parsed: { type: 'transferChecked', info: { source, destination, authority, mint, tokenAmount: ui(amount, decimals) } },
    stackHeight: null,
});
export const transfer = (source, destination, authority, amount) => ({
    program: 'spl-token',
    programId: TOKEN,
    parsed: { type: 'transfer', info: { source, destination, authority, amount: String(amount) } },
    stackHeight: 2,
});
export const closeAccount = (account, destination, owner) => ({
    program: 'spl-token',
    programId: TOKEN,
    parsed: { type: 'closeAccount', info: { account, destination, owner } },
    stackHeight: null,
});
export const syncNative = (account) => ({
    program: 'spl-token',
    programId: TOKEN,
    parsed: { type: 'syncNative', info: { account } },
    stackHeight: null,
});
export const ataCreate = (payer, account, wallet, mint, type = 'create') => ({
    program: 'spl-associated-token-account',
    programId: ATA,
    parsed: { type, info: { source: payer, account, wallet, mint, systemProgram: SYS, tokenProgram: TOKEN } },
    stackHeight: null,
});
export const tokenBalance = (accountIndex, mint, owner, amount, decimals) => ({
    accountIndex,
    mint,
    ...(owner ? { owner } : {}),
    programId: TOKEN,
    uiTokenAmount: ui(amount, decimals),
});

/**
 * One transaction as getTransactionsForAddress returns it with transactionDetails "full", jsonParsed.
 *
 * `balances` sets an account's lamports before and after ({ [address]: [pre, post] }); every other
 * account holds a token account's rent throughout, which is what the history tests need and what
 * the first-funder tests override for the address they look at.
 */
export function tx({ signature, slot, blockTime, keys, ixs, inner = [], pre = [], post = [], err = null, index = 0, balances = {} }) {
    return {
        slot,
        transactionIndex: index,
        blockTime,
        transaction: {
            signatures: [signature],
            message: {
                accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: true, source: 'transaction' })),
                recentBlockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6',
                instructions: ixs,
            },
        },
        meta: {
            err,
            status: err ? { Err: err } : { Ok: null },
            fee: 5000,
            preBalances: keys.map((k) => balances[k]?.[0] ?? 2039280),
            postBalances: keys.map((k) => balances[k]?.[1] ?? 2039280),
            innerInstructions: inner,
            preTokenBalances: pre,
            postTokenBalances: post,
            logMessages: [],
            computeUnitsConsumed: 2100,
        },
        version: 0,
    };
}

export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
export const page = (data, paginationToken = null) => ({ data, paginationToken });

/** wallet-api/funded-by, the documented example body. */
export const FUNDED_BY_DOC = {
    funder: '26MAyPNpK4At8LgRECMMbgiKQuJyg3oACtw1Q9FRyuba',
    funderName: null,
    funderType: null,
    mint: 'So11111111111111111111111111111111111111111',
    symbol: 'SOL',
    amount: 0.09811972,
    amountRaw: '98119720',
    decimals: 9,
    date: '2022-01-19T20:46:34.000Z',
    signature: '5WX9C5kCQNULGGrSHJBR1WDFyetVyekbUpe1KQ45p3zEBe6jVgSsJuMqLWijjTDcnaAK2518ZriktRMCNycnsNAG',
    timestamp: 1642625194,
    slot: 116984883,
    explorerUrl: 'https://orbmarkets.io/tx/5WX9C5kCQNULGGrSHJBR1WDFyetVyekbUpe1KQ45p3zEBe6jVgSsJuMqLWijjTDcnaAK2518ZriktRMCNycnsNAG?tab=summary',
};
export const FUNDED_BY_404 = { error: 'No funding transaction found', code: 404 };

/** wallet-api/identity, the documented example body. */
export const IDENTITY_DOC = {
    address: 'HXsKP7wrBWaQ8T2Vtjry3Nj3oUgwYcqq9vrHDM12G664',
    type: 'exchange',
    name: 'Binance 1',
    category: 'Centralized Exchange',
    tags: ['Centralized Exchange'],
};
export const IDENTITY_404 = { error: 'No identity information available for this address', code: 404 };
