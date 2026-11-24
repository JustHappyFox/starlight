import {
  Address,
  beginCell,
  Cell,
  external,
  internal,
  SendMode,
  storeMessage,
  storeStateInit,
  TonClient,
  WalletContractV4,
  WalletContractV5R1,
} from '@ton/ton';
import { mnemonicToPrivateKey, sign } from '@ton/crypto';
import { createHash } from 'node:crypto';
import type { Logger } from '../util/logger.js';

export interface OutMessage {
  to: string;
  value: bigint;
  body?: Cell | string;
  bounce?: boolean;
}

export interface TonConnectAccount {
  address: string;
  chain: string;
  walletStateInit: string;
  publicKey: string;
}

export interface TonProof {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string;
}

export interface WalletLike {
  readonly address: string;
  balance(): Promise<bigint>;
  /** boc — подписанное внешнее сообщение (base64), как его возвращает кошелёк через TON Connect */
  send(messages: OutMessage[], label: string): Promise<{ seqno: number; boc: string }>;
  tonConnectAccount(): TonConnectAccount;
  /** Подпись TON Connect ton_proof — доказательство владения кошельком для входа на сайт */
  tonProof(domain: string, payload: string, timestampSec?: number): TonProof;
}

/**
 * ton_proof по спецификации TON Connect:
 * message = "ton-proof-item-v2/" ‖ workchain(int32 BE) ‖ hash(32) ‖ len(domain)(uint32 LE) ‖ domain ‖ timestamp(uint64 LE) ‖ payload
 * signature = ed25519( sha256( 0xffff ‖ "ton-connect" ‖ sha256(message) ) )
 */
export function buildTonProof(address: Address, secretKey: Buffer, domain: string, payload: string, timestampSec: number): TonProof {
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(address.workChain);
  const domainBuf = Buffer.from(domain, 'utf8');
  const dlen = Buffer.alloc(4);
  dlen.writeUInt32LE(domainBuf.length);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(timestampSec));
  const message = Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, address.hash, dlen, domainBuf, ts, Buffer.from(payload, 'utf8')]);
  const inner = createHash('sha256').update(message).digest();
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), inner])).digest();
  return {
    timestamp: timestampSec,
    domain: { lengthBytes: domainBuf.length, value: domain },
    payload,
    signature: sign(digest, secretKey).toString('base64'),
  };
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

  tonConnectAccount(): TonConnectAccount {
    const stateInit = beginCell().store(storeStateInit(this.contract.init)).endCell().toBoc().toString('base64');
    return {
      address: this.contract.address.toRawString(),
      chain: this.testnet ? '-3' : '-239',
      walletStateInit: stateInit,
      publicKey: this.publicKey.toString('hex'),
    };
  }

  tonProof(domain: string, payload: string, timestampSec = Math.floor(Date.now() / 1000)): TonProof {
    return buildTonProof(this.contract.address, this.secretKey, domain, payload, timestampSec);
  }

  /** Подписанное внешнее сообщение — то же, что кошелёк отдаёт в TON Connect как `boc` */
  buildTransferBoc(seqno: number, messages: OutMessage[]): string {
    const createTransfer = this.contract.createTransfer.bind(this.contract) as unknown as (args: unknown) => Cell;
    const transfer = createTransfer({
      seqno,
      secretKey: this.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: messages.map((m) => internal({ to: Address.parse(m.to), value: m.value, body: m.body, bounce: bounceFlag(m) })),
    });
    const ext = external({ to: this.contract.address, init: seqno === 0 ? this.contract.init : undefined, body: transfer });
    return beginCell().store(storeMessage(ext)).endCell().toBoc().toString('base64');
  }

  send(messages: OutMessage[], label: string): Promise<{ seqno: number; boc: string }> {
    const run = async () => {
      const opened = this.client.open(this.contract);
      const seqno = await opened.getSeqno();
      this.log.info({ label, seqno, count: messages.length }, 'wallet: sending');
      const boc = this.buildTransferBoc(seqno, messages);
      await this.client.sendFile(Buffer.from(boc, 'base64'));
      // ждём подтверждения: seqno должен увеличиться
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          if ((await opened.getSeqno()) > seqno) return { seqno, boc };
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
