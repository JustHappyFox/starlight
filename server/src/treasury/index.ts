import { StonApiClient } from '@ston-fi/api';
import { dexFactory } from '@ston-fi/sdk';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../util/logger.js';
import type { ServiceWallet, WalletLike } from '../ton/wallet.js';
import type { TonCenter } from '../ton/toncenter.js';
import { formatTon } from '../services/pricing.js';

/**
 * Казначейство.
 *  - mode=ton:  держим полученные TON как есть.
 *  - mode=usdt: сразу меняем входящие TON на USDT (STON.fi) — защита от падения курса
 *    за время розыгрыша; перед оплатой Fragment докупаем ровно нужный TON обратно.
 * В dry-run свопы только логируются и пишутся в treasury_ops.
 */
export interface Treasury {
  onPaymentReceived(nano: bigint, ref: string): Promise<void>;
  /** Гарантирует, что на кошельке есть neededNano + резерв на газ */
  ensureTon(neededNano: bigint, ref: string): Promise<void>;
}

const NANO = 1_000_000_000n;
const tonToNano = (ton: number) => BigInt(Math.round(ton * 1e9));

export class NoopTreasury implements Treasury {
  async onPaymentReceived() {}
  async ensureTon() {}
}

export interface StonfiTreasuryOptions {
  mode: 'ton' | 'usdt';
  dryRun: boolean;
  gasReserveTon: number;
  slippage: number;
  usdtMaster: string;
  tonAddress: string; // адрес «нативного TON» в API STON.fi
  repo: Repo;
  log: Logger;
  toncenter: TonCenter;
  wallet: (WalletLike & Partial<Pick<ServiceWallet, 'tonClient'>>) | null;
  now: () => number;
  api?: Pick<StonApiClient, 'simulateSwap' | 'simulateReverseSwap'>;
}

export class StonfiTreasury implements Treasury {
  private api: Pick<StonApiClient, 'simulateSwap' | 'simulateReverseSwap'>;

  constructor(private o: StonfiTreasuryOptions) {
    this.api = o.api ?? new StonApiClient();
  }

  private record(kind: string, ref: string, amountIn: string, amountOut: string | null, status: string, detail?: unknown) {
    this.o.repo.insertTreasuryOp({ kind, ref, amount_in: amountIn, amount_out: amountOut, status, detail: detail ? JSON.stringify(detail) : null }, this.o.now());
  }

  async onPaymentReceived(nano: bigint, ref: string) {
    if (this.o.mode !== 'usdt') return;
    const reserve = tonToNano(this.o.gasReserveTon);
    const wallet = this.o.wallet;
    if (!wallet) {
      this.o.log.warn('treasury: нет кошелька — своп TON→USDT пропущен');
      return;
    }
    const balance = this.o.dryRun ? nano + reserve : await wallet.balance();
    const offer = nano < balance - reserve ? nano : balance - reserve;
    if (offer < NANO / 2n) {
      this.record('swap_ton_usdt', ref, offer.toString(), null, 'skipped', { reason: 'мало TON сверх резерва' });
      return;
    }
    const sim = await this.api.simulateSwap({
      offerAddress: this.o.tonAddress,
      askAddress: this.o.usdtMaster,
      offerUnits: offer.toString(),
      slippageTolerance: String(this.o.slippage),
    });
    if (this.o.dryRun) {
      this.record('swap_ton_usdt', ref, offer.toString(), sim.askUnits, 'dry_run', { minAsk: sim.minAskUnits, rate: sim.swapRate });
      this.o.log.info({ ref, offerTon: formatTon(offer), askUsdt: Number(sim.askUnits) / 1e6 }, 'treasury[dry-run]: TON→USDT');
      return;
    }
    const contracts = dexFactory(sim.router);
    const client = wallet.tonClient!;
    const router = client.open(contracts.Router.create(sim.router.address));
    const proxyTon = contracts.pTON.create(sim.router.ptonMasterAddress);
    const tx = await (router as unknown as {
      getSwapTonToJettonTxParams: (p: Record<string, unknown>) => Promise<{ to: { toString(): string }; value: bigint; body?: import('@ton/core').Cell | null }>;
    }).getSwapTonToJettonTxParams({
      userWalletAddress: wallet.address,
      proxyTon,
      offerAmount: sim.offerUnits,
      askJettonAddress: sim.askAddress,
      minAskAmount: sim.minAskUnits,
      queryId: Date.now(),
    });
    await wallet.send([{ to: tx.to.toString(), value: tx.value, body: tx.body ?? undefined }], `swap TON→USDT ${ref}`);
    this.record('swap_ton_usdt', ref, offer.toString(), sim.askUnits, 'sent', { minAsk: sim.minAskUnits });
  }

  async ensureTon(neededNano: bigint, ref: string) {
    const wallet = this.o.wallet;
    if (!wallet) throw new Error('treasury: кошелёк не настроен (TON_WALLET_MNEMONIC)');
    if (this.o.dryRun) {
      this.record('ensure_ton', ref, neededNano.toString(), null, 'dry_run');
      return;
    }
    const reserve = tonToNano(this.o.gasReserveTon);
    const balance = await wallet.balance();
    if (balance >= neededNano + reserve) return;
    if (this.o.mode !== 'usdt') {
      throw new Error(`treasury: на кошельке ${formatTon(balance)} TON, нужно ${formatTon(neededNano + reserve)} TON`);
    }
    const missing = neededNano + reserve - balance;
    // докупаем с запасом 3% на проскальзывание/комиссии
    const ask = (missing * 103n) / 100n;
    const sim = await this.api.simulateReverseSwap({
      offerAddress: this.o.usdtMaster,
      askAddress: this.o.tonAddress,
      askUnits: ask.toString(),
      slippageTolerance: String(this.o.slippage),
    });
    const usdtBalance = await this.o.toncenter.jettonBalance(wallet.address, this.o.usdtMaster);
    if (usdtBalance < BigInt(sim.offerUnits)) {
      throw new Error(`treasury: USDT не хватает (${Number(usdtBalance) / 1e6} < ${Number(sim.offerUnits) / 1e6})`);
    }
    const contracts = dexFactory(sim.router);
    const client = wallet.tonClient!;
    const router = client.open(contracts.Router.create(sim.router.address));
    const proxyTon = contracts.pTON.create(sim.router.ptonMasterAddress);
    const tx = await (router as unknown as {
      getSwapJettonToTonTxParams: (p: Record<string, unknown>) => Promise<{ to: { toString(): string }; value: bigint; body?: import('@ton/core').Cell | null }>;
    }).getSwapJettonToTonTxParams({
      userWalletAddress: wallet.address,
      offerJettonAddress: this.o.usdtMaster,
      offerAmount: sim.offerUnits,
      minAskAmount: sim.minAskUnits,
      proxyTon,
      queryId: Date.now(),
    });
    await wallet.send([{ to: tx.to.toString(), value: tx.value, body: tx.body ?? undefined }], `swap USDT→TON ${ref}`);
    this.record('swap_usdt_ton', ref, sim.offerUnits, sim.askUnits, 'sent');
    // ждём, пока TON придут (своп асинхронный — несколько сообщений между контрактами)
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      if ((await wallet.balance()) >= neededNano + reserve / 2n) return;
    }
    throw new Error('treasury: TON после свопа не поступили за 2 минуты');
  }
}
