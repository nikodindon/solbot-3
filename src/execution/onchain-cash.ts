import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { USDC_MINT } from "../constants.js";
import { tokenAmountOf } from "../solana/tokens.js";
import type { CashLedger } from "./executor.js";

/**
 * Cash on-chain.
 *
 * En live, le cash disponible est le **solde réel** du wallet : il n'y a
 * pas de cash virtuel. C'est la seule différence de nature entre le paper et
 * le live — et c'est celle qui compte.
 *
 * La réserve de gaz est **exclue** du cash disponible : le SOL sous
 * `risk.sol_gas_reserve` ne peut pas être vendu.
 */
export class OnChainCash implements CashLedger {
  private cachedUsd: number | null = null;
  private cachedSol: number | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly owner: string,
    private readonly options: {
      /** Réserve de gaz intangible, en SOL. */
      gasReserveSol: number;
      /** Prix du SOL en USD (pour valoriser le cash). */
      solPriceUsd: number;
    },
  ) {}

  /** Rafraîchit les soldes depuis la chaîne. */
  async refresh(): Promise<void> {
    const lamports = await this.connection.getBalance(new PublicKey(this.owner));
    this.cachedSol = Number(lamports) / 1e9;
    this.cachedUsd = await this.usdcBalance();
  }

  cashUsd(): number {
    return this.cachedUsd ?? 0;
  }

  solBalance(): number | null {
    return this.cachedSol;
  }

  debit(_usd: number): void {
    // Le solde réel ne se décrémente pas localement : c'est la chaîne qui
    // fait foi. On invalide le cache pour forcer une relecture.
    this.cachedUsd = null;
  }

  credit(_usd: number): void {
    this.cachedUsd = null;
  }

  /** Solde USDC du wallet. */
  private async usdcBalance(): Promise<number> {
    const accounts = await this.connection.getParsedTokenAccountsByOwner(
      new PublicKey(this.owner),
      {
        mint: new PublicKey(USDC_MINT),
      },
    );
    let total = 0;
    for (const { account } of accounts.value) {
      total += tokenAmountOf(account);
    }
    return total / 1e6;
  }

  /** Le SOL disponible, hors réserve de gaz. */
  availableSol(): number {
    return Math.max(0, (this.cachedSol ?? 0) - this.options.gasReserveSol);
  }
}
