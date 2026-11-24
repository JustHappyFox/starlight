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
  /** Fragment подтвердил выполнение заказа (а не только ушёл платёж) */
  confirmed?: boolean;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    /**
     * recipient  — получатель не найден (нет/сменился username) → нужен другой получатель;
     * ineligible — получатель не может принять приз (например, Premium уже активен) → нужен другой получатель;
     * auth       — у провайдера нет рабочей сессии → ждём входа, попытки не тратим;
     * retry      — временная ошибка; fatal — без повторов.
     */
    readonly kind: 'recipient' | 'ineligible' | 'auth' | 'retry' | 'fatal',
  ) {
    super(message);
  }
}

export interface PrizeProvider {
  readonly name: string;
  /** Проверить получателя без покупки: имя, которое увидит победитель перед подтверждением */
  lookup(req: Omit<DeliveryRequest, 'ref'>): Promise<{ name: string }>;
  deliver(req: DeliveryRequest): Promise<DeliveryResult>;
}

/** Для разработки и тестов: «выдаёт» призы без реальных переводов. */
export class MockProvider implements PrizeProvider {
  readonly name = 'mock';
  readonly delivered: DeliveryRequest[] = [];
  failNext: DeliveryError | null = null;
  /** username → ошибка при lookup/deliver (для тестов) */
  rejects = new Map<string, DeliveryError>();

  async lookup(req: Omit<DeliveryRequest, 'ref'>) {
    const e = this.rejects.get(req.username.replace(/^@/, '').toLowerCase());
    if (e) throw e;
    return { name: `Пользователь @${req.username.replace(/^@/, '')}` };
  }

  async deliver(req: DeliveryRequest): Promise<DeliveryResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const e = this.rejects.get(req.username.replace(/^@/, '').toLowerCase());
    if (e) throw e;
    this.delivered.push(req);
    return { providerRef: `mock-${req.ref}`, confirmed: true };
  }
}
