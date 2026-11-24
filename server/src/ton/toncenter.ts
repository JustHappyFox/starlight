import { Address } from '@ton/core';
import { decodeComment } from './comment.js';

export interface IncomingTx {
  hash: string;
  lt: string;
  utime: number;
  source: string | null;
  value: bigint;
  comment: string | null;
  aborted: boolean;
  bounced: boolean;
}

type Fetch = typeof fetch;

interface V3Tx {
  hash: string;
  lt: string;
  now: number;
  description?: { aborted?: boolean };
  in_msg?: {
    source?: string | null;
    value?: string | null;
    bounced?: boolean | null;
    message_content?: { body?: string | null; decoded?: { type?: string; comment?: string } | null } | null;
  } | null;
}

/** Минимальный клиент toncenter API v3 (индексатор). */
export class TonCenter {
  constructor(
    private opts: { base: string; apiKey?: string; fetchFn?: Fetch; testnet?: boolean },
  ) {}

  private async get<T>(path: string, query: Record<string, string | number>): Promise<T> {
    const url = new URL(path, this.opts.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.opts.apiKey) headers['X-API-Key'] = this.opts.apiKey;
    const res = await (this.opts.fetchFn ?? fetch)(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`toncenter ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async incoming(account: string, limit = 100, offset = 0): Promise<IncomingTx[]> {
    const j = await this.get<{ transactions: V3Tx[] }>('/api/v3/transactions', { account, limit, offset, sort: 'desc' });
    return (j.transactions ?? [])
      .filter((t) => t.in_msg && t.in_msg.source && t.in_msg.value)
      .map((t) => {
        const mc = t.in_msg!.message_content;
        const comment = mc?.decoded?.type === 'text_comment' ? (mc.decoded.comment ?? null) : decodeComment(mc?.body);
        let source: string | null = null;
        try {
          source = Address.parse(t.in_msg!.source!).toString({ bounceable: false, testOnly: !!this.opts.testnet });
        } catch {
          source = t.in_msg!.source ?? null;
        }
        return {
          hash: t.hash,
          lt: t.lt,
          utime: t.now,
          source,
          value: BigInt(t.in_msg!.value!),
          comment,
          aborted: !!t.description?.aborted,
          bounced: !!t.in_msg!.bounced,
        };
      });
  }

  /** Последний блок мастерчейна — внешняя энтропия для розыгрыша */
  async masterchainHead(): Promise<{ seqno: number; rootHash: string }> {
    const j = await this.get<{ last: { seqno: number; root_hash: string } }>('/api/v3/masterchainInfo', {});
    if (!j.last?.root_hash) throw new Error('masterchainInfo без root_hash');
    return { seqno: j.last.seqno, rootHash: j.last.root_hash };
  }

  async jettonBalance(owner: string, master: string): Promise<bigint> {
    const j = await this.get<{ jetton_wallets: { balance: string }[] }>('/api/v3/jetton/wallets', { owner_address: owner, jetton_address: master, limit: 1 });
    return BigInt(j.jetton_wallets?.[0]?.balance ?? '0');
  }
}
