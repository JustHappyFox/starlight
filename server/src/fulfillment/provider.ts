import type { PrizeType } from '../../../shared/types.js';

export interface DeliveryRequest {
  type: PrizeType;
  /** звёзды или месяцы */
  amount: number;
  username: string;
  /** уникальная ссылка для логов/идемпотентности: "<gid>:<uid>" */
  ref: string;
}

export interface DeliveryResult {
  providerRef: string;
  txRef?: string;
  costNano?: string;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** recipient — получатель не найден (нет/сменился username), retry — временная ошибка, fatal — без повторов */
    readonly kind: 'recipient' | 'retry' | 'fatal',
  ) {
    super(message);
  }
}

export interface PrizeProvider {
  readonly name: string;
  deliver(req: DeliveryRequest): Promise<DeliveryResult>;
}

/** Для разработки и тестов: «выдаёт» призы без реальных переводов. */
export class MockProvider implements PrizeProvider {
  readonly name = 'mock';
  readonly delivered: DeliveryRequest[] = [];
  failNext: DeliveryError | null = null;

  async deliver(req: DeliveryRequest): Promise<DeliveryResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.delivered.push(req);
    return { providerRef: `mock-${req.ref}` };
  }
}
