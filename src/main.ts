// Helius pack — Solana address history, first funder and identity labels for VINEYARD.
//
// What it adds over a plain Solana RPC: Helius's getTransactionsForAddress can include the
// transactions that touch a wallet's token accounts, where SPL tokens actually sit, so a USDC
// payment to a wallet is in its history; it pages oldest first, which is what finding a wallet's
// first funding takes; and on paid plans the Wallet API's funded-by and identity add Helius's own
// labels for the funder and the wallet.
//
// KEY MODEL: the analyst's own Helius API key, a `secret: true` config value. Helius RPC takes it
// only as the `api-key` query parameter; the Wallet API gets it in the `X-Api-Key` header. No key is
// bundled.
//
// Graph writes are STAGED: nothing reaches the project until the analyst reviews and applies it.
import { definePluginPack } from './sdk';
import type { PluginManifest, VineyardPluginPack } from './sdk';
import { PLATFORMS } from './common';
import { addressHistory } from './history';
import { firstFunder } from './funder';
import { walletIdentity } from './identity';

// The pack's page in the marketplace drawer, in Markdown. Lines in an array rather than one template
// literal, because the Markdown is full of backticks.
const PAGE = [
    "For following funds on Solana: which wallets an address paid and was paid by in SOL and SPL tokens, including transfers into its token accounts, which a plain Solana RPC history leaves out; who sent it its first SOL; and what Helius calls a labelled wallet (an exchange, a bridge, a known scammer).",
    '',
    '**Needs:** a Helius API key (https://dashboard.helius.dev). The free plan (1 million credits a month) covers history and first funder; identity labels and funded-by need a paid plan, Developer ($49 a month) or above. History costs about 10 credits per 100 transactions, funded-by and identity 100 per address.',
    '',
    "**Who sees it:** Helius receives every address looked up, with your key, which Helius RPC takes only in the URL's query string.",
    '',
    '**Read results with care:**',
    '',
    '- Token transfers before December 2022 are not found through token accounts.',
    '- SOL a program moves without a transfer instruction, and the rent a closed account returns, are not counted; nor is SOL a wallet wraps into its own wSOL account.',
    "- Without funded-by, the first funder is whoever sent SOL when the balance first rose from zero (funded-by's own definition); a wallet first credited by a program gets none.",
    "- Labels are Helius's own and ungraded.",
    '',
    '**Terms** (https://www.helius.dev/terms, updated 2026-09-28): a lawful business purpose, not personal or household use (§3.2(xi)); keys kept confidential (§6.1). No rule on storing results.',
    '',
    '**Source:** https://github.com/Vineyard-Intelligence/pluginpack-helius (Apache-2.0)',
].join('\n');

const pack: VineyardPluginPack & {
    author: { name: string; url: string };
    license: string;
    icon: string;
    platforms: PluginManifest['platforms'];
} = {
    identifier: 'run.vineyard.pluginpacks.helius',
    content_type: 'vineyard:pluginpack',
    name: 'Helius',
    version: '1.0.0',
    summary:
        "Solana through Helius: an address's SOL and SPL token transfers, token accounts included, the wallet that first funded it, and on paid plans Helius's identity labels. Needs a Helius API key; the free plan covers history and first funder.",
    description: PAGE,
    author: { name: 'VINEYARD', url: 'https://vineyard.run' },
    license: 'Apache-2.0',
    icon: 'sun',
    platforms: PLATFORMS,
    plugins: [addressHistory, firstFunder, walletIdentity],
};

export const heliusPack = definePluginPack(pack);
export default heliusPack;
