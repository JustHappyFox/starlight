import { useEffect, useRef, useState } from 'preact/hooks';
import { apiOrigin, del, get, post } from '../api';
import { navigate } from '../router';
import { BackButton, MainButton, Notice, Row, Section, Spinner, usePoll, useNow } from '../ui';
import { alertMsg, confirmMsg, copyText, haptic, tg } from '../tg';
import { PRIZE_STATUS, STATUS_LABEL, dateTime, left, prizeLong, usd } from '../format';
import { countryName, flag } from '../countries';
import type { GiveawayOwnerView, InvoiceView } from '../../../shared/types';
import type { TonConnectUI } from '@tonconnect/ui';

let tonConnect: Promise<TonConnectUI> | null = null;
function getTonConnect(manifestUrl: string): Promise<TonConnectUI> {
  if (!tonConnect) {
    tonConnect = import('@tonconnect/ui').then(({ TonConnectUI }) => new TonConnectUI({ manifestUrl }));
  }
  return tonConnect;
}

export function Owner(props: { id: string }) {
    const [g, setG] = useState<GiveawayOwnerView | null>(null);
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const now = useNow(15_000);
  const loadedOnce = useRef(false);

  const load = async () => {
    try {
      const v = await get<GiveawayOwnerView>(`/giveaways/${props.id}`);
      setG(v);
      if (v.invoice) setInvoice(v.invoice);
      if (v.status !== 'draft') setWaiting(false);
      loadedOnce.current = true;
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [props.id]);
  usePoll(load, 5000, !!g && (g.status === 'draft' ? waiting || invoice?.status === 'underpaid' : g.status !== 'finished' && g.status !== 'cancelled'));

  const ensureInvoice = async (): Promise<InvoiceView> => {
    if (invoice && invoice.status !== 'expired' && invoice.expiresAt - Date.now() > 3 * 60_000) return invoice;
    const inv = await post<InvoiceView>(`/giveaways/${props.id}/invoice`);
    setInvoice(inv);
    return inv;
  };

  const pay = async () => {
    setPaying(true);
    try {
      const inv = await ensureInvoice();
      const due = (BigInt(inv.amountNano) - BigInt(inv.paidNano)).toString();
      const ui = await getTonConnect(`${apiOrigin()}/tonconnect-manifest.json`);
      if (!ui.connected) {
        await ui.openModal();
        await new Promise<void>((resolve, reject) => {
          const stop = ui.onStatusChange((w) => {
            if (w) {
              stop();
              resolve();
            }
          });
          const stopModal = ui.onModalStateChange((s) => {
            if (s.status === 'closed' && !ui.connected) {
              stopModal();
              stop();
              reject(new Error('Кошелёк не подключён'));
            }
          });
        });
      }
      await ui.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [{ address: inv.address, amount: due, payload: inv.payload }],
      });
      haptic('success');
      setWaiting(true);
    } catch (e) {
      const msg = (e as Error).message || 'Оплата отменена';
      if (!/отмен|reject|cancel|не подключ/i.test(msg)) await alertMsg(msg);
    } finally {
      setPaying(false);
    }
  };

  const payManually = async () => {
    try {
      const inv = await ensureInvoice();
      tg.openLink(inv.tonLink);
      setWaiting(true);
    } catch (e) {
      await alertMsg((e as Error).message);
    }
  };

  const preview = async () => {
    try {
      await post(`/giveaways/${props.id}/preview`);
      haptic('success');
      await alertMsg('Предпросмотр отправлен вам в личку с ботом.');
    } catch (e) {
      await alertMsg((e as Error).message);
    }
  };

  const remove = async () => {
    if (!(await confirmMsg('Удалить черновик?'))) return;
    try {
      await del(`/giveaways/${props.id}`);
      navigate('/', true);
    } catch (e) {
      await alertMsg((e as Error).message);
    }
  };

  const copy = async (text: string) => {
    if (await copyText(text)) haptic('success');
  };

  if (err) return <main class="page"><BackButton onBack={() => navigate('/')} /><Notice kind="error">{err}</Notice></main>;
  if (!g) return <Spinner />;

  const isDraft = g.status === 'draft';
  const due = invoice ? BigInt(invoice.amountNano) - BigInt(invoice.paidNano) : null;

  return (
    <main class="page">
      <BackButton onBack={() => navigate('/')} />
      <header class="prize-card">
        <div class="prize-emoji" aria-hidden="true">{g.prizeType === 'stars' ? '⭐' : '💎'}</div>
        <div class="prize-title">{prizeLong(g.prizeType, g.prizeAmount)}</div>
        <div class="prize-sub">× {g.winnersCount} · {usd(g.priceUsd)}</div>
        <span class={`badge status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
      </header>

      {g.lastError && g.status === 'scheduled' && <Notice kind="warn">Публикация не удалась: {g.lastError}. Проверьте права бота в канале — повторим автоматически.</Notice>}

      {isDraft && (
        <Section title="Оплата" footer="Оплата в TON по курсу на момент выставления счёта. После оплаты условия фиксируются и не могут быть изменены — это гарантия для участников.">
          {invoice && invoice.status !== 'expired' ? (
            <>
              <Row label="К оплате" right={<b>{invoice.amountTon} TON</b>} />
              {invoice.status === 'underpaid' && due !== null && due > 0n && <Notice kind="warn">Получено частично. Доплатите оставшуюся сумму.</Notice>}
              <Row label="Счёт действует до" right={dateTime(invoice.expiresAt)} />
              <Row label="Комментарий к платежу" hint="Обязателен при ручном переводе" right={<code>{invoice.comment}</code>} onClick={() => copy(invoice.comment)} />
              <Row label="Адрес" hint={invoice.address} onClick={() => copy(invoice.address)} right="⧉" />
            </>
          ) : (
            <Row label="Счёт ещё не выставлен" hint="Нажмите «Оплатить» — сумма в TON будет рассчитана по текущему курсу" />
          )}
          <Row icon="👛" label="Оплатить другим кошельком" hint="Откроется ссылка ton://transfer" onClick={payManually} />
          {waiting && <Notice kind="info">Ждём подтверждения транзакции в сети TON — обычно до минуты…</Notice>}
        </Section>
      )}

      {g.status === 'active' && (
        <Section title="Идёт розыгрыш">
          <Row label="Участников" right={<b>{g.participantsCount}</b>} />
          <Row label="До итогов" right={left(g.endsAt - now)} />
          {g.postUrl && <Row icon="📣" label="Открыть пост" onClick={() => tg.openTelegramLink(g.postUrl!)} />}
          <Row icon="🔗" label="Ссылка на розыгрыш" hint={g.appLink} onClick={() => copy(g.appLink)} right="⧉" />
        </Section>
      )}

      {g.status === 'finished' && (
        <Section title={`Победители (${g.winners.length})`}>
          {g.winners.length === 0 && <p class="empty">Участников не было — оформлен возврат.</p>}
          {g.winners.map((w) => (
            <Row key={w.place} icon={`${w.place}.`} label={w.username ? `@${w.username}` : w.name} right={<span class={w.prizeStatus === 'sent' ? 'ok' : w.prizeStatus === 'failed' ? 'warn' : 'hint'}>{PRIZE_STATUS[w.prizeStatus]}</span>} />
          ))}
          {g.postUrl && <Row icon="📣" label="Открыть пост" onClick={() => tg.openTelegramLink(g.postUrl!)} />}
        </Section>
      )}

      <Section title="Условия">
        <Row label="Канал" right={g.channel?.title ?? '—'} />
        <Row label="Начало" right={g.startsAt ? dateTime(g.startsAt) : g.publishedAt ? dateTime(g.publishedAt) : 'сразу после оплаты'} />
        <Row label="Итоги" right={dateTime(g.endsAt)} />
        <Row label="Страны" right={g.countries ? g.countries.map((c) => `${flag(c)} ${countryName(c)}`).join(', ') : 'все'} />
        <Row label="Защита" right={[g.captcha && 'капча', g.honeypot && 'ловушка', g.requireSubscription && 'подписка'].filter(Boolean).join(', ') || 'нет'} />
        <Row label="Кнопка" right={`«${g.buttonText}»`} />
        <Row label="Результаты в канал" right={g.publishResults ? 'да' : 'нет'} />
        <Row label="Хеш честности" hint={g.seedHash} />
      </Section>

      {isDraft && (
        <Section>
          <Row icon="👁" label="Предпросмотр поста в личку" onClick={preview} />
          <Row icon="✏️" label="Изменить" onClick={() => navigate(`/edit/${g.id}`)} />
          <Row icon="🗑" label="Удалить черновик" danger onClick={remove} />
        </Section>
      )}

      {isDraft && <MainButton text={invoice?.status === 'underpaid' ? 'Доплатить через TON Connect' : 'Оплатить через TON Connect'} onClick={pay} progress={paying} />}
      {g.status === 'active' && g.postUrl && <MainButton text="Открыть пост" onClick={() => tg.openTelegramLink(g.postUrl!)} />}
    </main>
  );
}
