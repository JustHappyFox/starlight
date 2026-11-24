import { useEffect, useRef, useState } from 'preact/hooks';
import { apiOrigin, del, get, post } from '../api';
import { navigate } from '../router';
import { useSession } from '../main';
import { BackButton, MainButton, Notice, Row, Section, Spinner, usePoll, useNow } from '../ui';
import { alertMsg, confirmMsg, copyText, haptic, tg } from '../tg';
import { PRIZE_STATUS, STATUS_LABEL, dateTime, left, prizeLong, usd } from '../format';
import { countryName, flag } from '../countries';
import type { GiveawayOwnerView, InvoiceView } from '../../../shared/types';
import type { TonConnectUI } from '@tonconnect/ui';

/** app_name кошелька Telegram (Wallet → его некастодиальная часть) в реестре TON Connect */
const TG_WALLET = 'telegram-wallet';

let tonConnect: Promise<TonConnectUI> | null = null;
function getTonConnect(returnUrl: string): Promise<TonConnectUI> {
  if (!tonConnect) {
    tonConnect = import('@tonconnect/ui').then(
      ({ TonConnectUI }) =>
        new TonConnectUI({
          manifestUrl: `${apiOrigin()}/tonconnect-manifest.json`,
          language: 'ru',
          // после подтверждения в кошельке пользователь возвращается в мини-апп
          actionsConfiguration: { returnStrategy: 'back', twaReturnUrl: returnUrl as `${string}://${string}` },
        }),
    );
  }
  return tonConnect;
}

/** Ждём подключения кошелька; reject — если окно закрыли, не подключившись */
function waitConnected(ui: TonConnectUI, single: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ui.connected) return resolve();
    const stops: (() => void)[] = [];
    const done = (ok: boolean) => {
      stops.forEach((f) => f());
      if (ok) resolve();
      else reject(new Error('Кошелёк не подключён'));
    };
    stops.push(ui.onStatusChange((w) => w && done(true)));
    const onClosed = (s: { status: string }) => s.status === 'closed' && !ui.connected && done(false);
    stops.push(single ? ui.onSingleWalletModalStateChange(onClosed) : ui.onModalStateChange(onClosed));
  });
}

function walletLabel(ui: TonConnectUI): string | null {
  const w = ui.wallet as (NonNullable<TonConnectUI['wallet']> & { name?: string }) | null;
  if (!w) return null;
  if (w.device.appName === TG_WALLET) return 'Wallet в Telegram';
  return w.name ?? w.device.appName;
}

export function Owner(props: { id: string }) {
  const { config } = useSession();
  const [g, setG] = useState<GiveawayOwnerView | null>(null);
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
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

  // для черновика заранее поднимаем TON Connect: восстанавливаем прошлое подключение кошелька
  const isDraftNow = g?.status === 'draft';
  useEffect(() => {
    if (!isDraftNow) return;
    let stop: (() => void) | undefined;
    void getTonConnect(config.appLink).then(async (ui) => {
      await ui.connectionRestored;
      setWallet(walletLabel(ui));
      stop = ui.onStatusChange(() => setWallet(walletLabel(ui)));
    });
    return () => stop?.();
  }, [isDraftNow]);

  const ensureInvoice = async (): Promise<InvoiceView> => {
    if (invoice && invoice.status !== 'expired' && invoice.expiresAt - Date.now() > 3 * 60_000) return invoice;
    const inv = await post<InvoiceView>(`/giveaways/${props.id}/invoice`);
    setInvoice(inv);
    return inv;
  };

  /**
   * Быстрая оплата как на Fragment: «Оплатить» → сразу открывается Wallet в Telegram
   * (без списка кошельков) → подтверждение → возврат в мини-апп.
   * Первый раз кошелёк подключается (+1 подтверждение), дальше — одно касание.
   */
  const pay = async (mode: 'telegram' | 'any') => {
    setPaying(true);
    try {
      const [inv, ui] = await Promise.all([ensureInvoice(), getTonConnect(config.appLink)]);
      await ui.connectionRestored;
      if (!ui.connected) {
        if (mode === 'telegram') await ui.openSingleWalletModal(TG_WALLET);
        else await ui.openModal();
        await waitConnected(ui, mode === 'telegram');
      }
      const due = (BigInt(inv.amountNano) - BigInt(inv.paidNano)).toString();
      await ui.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [{ address: inv.address, amount: due, payload: inv.payload }],
      });
      haptic('success');
      setWaiting(true);
    } catch (e) {
      const msg = (e as Error).message || 'Оплата отменена';
      if (!/отмен|reject|cancel|не подключ|declin/i.test(msg)) await alertMsg(msg);
    } finally {
      setPaying(false);
    }
  };

  const switchWallet = async () => {
    const ui = await getTonConnect(config.appLink);
    if (ui.connected) await ui.disconnect();
    setWallet(null);
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
          {wallet ? (
            <Row icon="👛" label={`Кошелёк: ${wallet}`} hint="Оплата откроется в нём" right="Сменить" onClick={switchWallet} />
          ) : (
            <Row icon="👛" label="Другой кошелёк" hint="Tonkeeper, MyTonWallet и другие" onClick={() => void pay('any')} />
          )}
          <Row icon="↗️" label="Перевести вручную" hint="Ссылка ton://transfer — укажите комментарий" onClick={payManually} />
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

      {isDraft && (
        <MainButton
          text={`${invoice?.status === 'underpaid' ? 'Доплатить' : 'Оплатить'} ${wallet ? (invoice && invoice.status !== 'expired' ? `${invoice.amountTon} TON` : '') : 'в Wallet'}`.trim()}
          onClick={() => void pay('telegram')}
          progress={paying}
        />
      )}
      {g.status === 'active' && g.postUrl && <MainButton text="Открыть пост" onClick={() => tg.openTelegramLink(g.postUrl!)} />}
    </main>
  );
}
