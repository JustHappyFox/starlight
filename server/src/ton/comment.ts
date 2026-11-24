import { beginCell, Cell } from '@ton/core';

/** base64 BOC текстового комментария (op = 0) — payload для TON Connect */
export function commentPayload(text: string): string {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().toString('base64');
}

/** Достаёт текстовый комментарий из BOC, если это он */
export function decodeComment(bocBase64: string | null | undefined): string | null {
  if (!bocBase64) return null;
  try {
    const s = Cell.fromBase64(bocBase64).beginParse();
    if (s.remainingBits < 32) return null;
    if (s.loadUint(32) !== 0) return null;
    return s.loadStringTail();
  } catch {
    return null;
  }
}

/** Ссылка ton:// для ручной оплаты из любого кошелька */
export function tonTransferLink(address: string, amountNano: string, text: string): string {
  return `ton://transfer/${address}?amount=${amountNano}&text=${encodeURIComponent(text)}`;
}
