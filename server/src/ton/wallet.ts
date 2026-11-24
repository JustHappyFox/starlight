import { Address, beginCell, Cell, internal, SendMode, storeStateInit, TonClient, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import type { Logger } from '../util/logger.js';

export interface OutMessage {
  to: string;
  value: bigint;
  body?: Cell | string;
  bounce?: boolean;
}

export interface WalletLike {
  readonly address: string;
  balance(): Promise<bigint>;
  send(messages: OutMessage[], label: string): Promise<{ seqno: number }>;
  tonConnectAccount(): { address: string; chain: string; walletStateInit: string; publicKey: string };
}

/**
 * Сервисный кошелёк. Все исходящие переводы идут строго последовательно (seqno!):
 * два перевода с одинаковым seqno — второй молча теряется.
 */
export class ServiceWallet implements WalletLike {
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private client: TonClient,
    private contract: WalletContractV4 | WalletContractV5R1,
    private secretKey: Buffer,
    private publicKey: Buffer,
    private testnet: boolean,
    private log: Logger,
  ) {}

  static async create(opts: { mnemonic: string; version: 'v4' | 'v5r1'; endpoint: string; apiKey?: string; testnet: boolean; log: Logger }) {
    const words = opts.mnemonic.trim().split(/\s+/);
    if (words.length !== 24) throw new Error('TON_WALLET_MNEMONIC: нужно 24 слова');
    const kp = await mnemonicToPrivateKey(words);
    const contract =
      opts.version === 'v4'
        ? WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey })
        : WalletContractV5R1.create({ publicKey: kp.publicKey, walletId: { networkGlobalId: opts.testnet ? -3 : -239 } });
    const client = new TonClient({ endpoint: opts.endpoint, apiKey: opts.apiKey });
    return new ServiceWallet(client, contract, kp.secretKey, kp.publicKey, opts.testnet, opts.log);
  }

  get address(): string {
    return this.contract.address.toString({ bounceable: false, testOnly: this.testnet });
  }

  get rawAddress(): Address {
    return this.contract.address;
  }

  get tonClient(): TonClient {
    return this.client;
  }

  async balance(): Promise<bigint> {
    return this.client.getBalance(this.contract.address);
  }

  tonConnectAccount() {
    const stateInit = beginCell().store(storeStateInit(this.contract.init)).endCell().toBoc().toString('base64');
    return {
      address: this.contract.address.toRawString(),
      chain: this.testnet ? '-3' : '-239',
      walletStateInit: stateInit,
      publicKey: this.publicKey.toString('hex'),
    };
  }

  send(messages: OutMessage[], label: string): Promise<{ seqno: number }> {
    const run = async () => {
      const opened = this.client.open(this.contract);
      const seqno = await opened.getSeqno();
      this.log.info({ label, seqno, count: messages.length }, 'wallet: sending');
      await opened.sendTransfer({
        seqno,
        secretKey: this.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: messages.map((m) => internal({ to: Address.parse(m.to), value: m.value, body: m.body, bounce: bounceFlag(m) })),
      } as never);
      // ждём подтверждения: seqno должен увеличиться
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          if ((await opened.getSeqno()) > seqno) return { seqno };
        } catch (e) {
          this.log.warn({ err: String(e) }, 'wallet: seqno poll failed');
        }
      }
      throw new Error(`wallet: перевод ${label} не подтвердился за 90с (seqno ${seqno})`);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

function bounceFlag(m: OutMessage): boolean {
  if (m.bounce !== undefined) return m.bounce;
  return Address.isFriendly(m.to) ? Address.parseFriendly(m.to).isBounceable : true;
}
