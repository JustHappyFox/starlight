import { useState } from 'preact/hooks';
import { post } from '../api';
import { MainButton, Notice, Row, Section } from '../ui';
import { alertMsg, haptic, tg } from '../tg';
import { dateTime } from '../format';
import type { PublicGiveawayView, WinnerIssue } from '../../../shared/types';

const REASON: Record<WinnerIssue, string> = {
  no_username: 'У вашего аккаунта нет публичного @username, а Fragment отправляет призы только по нику.',
  not_found: 'Аккаунт получателя не найден — возможно, ник изменился.',
  ineligible: 'Этот аккаунт не может принять приз — например, у него уже активен Telegram Premium.',
};

/** Блок победителя: статус приза и выбор получателя (свой ник или другой аккаунт) */
export function PrizeClaim(props: { gid: string; view: PublicGiveawayView; onView: (v: PublicGiveawayView) => void }) {
  const prize = props.view.me.prize!;
  const myUsername = tg.initDataUnsafe.user?.username ?? null;
  const [other, setOther] = useState('');
  const [checked, setChecked] = useState<{ username: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    setBusy(true);
    setErr(null);
    setChecked(null);
    try {
      setChecked(await post<{ username: string; name: string }>(`/g/${props.gid}/claim/check`, { username: other }));
      haptic('light');
    } catch (e) {
      haptic('error');
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const claim = async (username: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      props.onView(await post<PublicGiveawayView>(`/g/${props.gid}/claim`, { username }));
      haptic('success');
      await alertMsg(`Отправляем приз на @${username ?? myUsername}. Обычно это занимает несколько минут.`);
    } catch (e) {
      haptic('error');
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (prize.status === 'sent') return <Notice kind="success">🎉 Вы победили! Приз отправлен на @{prize.recipient}.</Notice>;
  if (prize.status === 'pending' || prize.status === 'processing')
    return <Notice kind="success">🎉 Вы победили! Отправляем приз на @{prize.recipient} — обычно несколько минут.</Notice>;
  if (prize.status === 'unclaimed') return <Notice kind="warn">⌛ Срок получения приза истёк — он разыгран заново.</Notice>;
  if (prize.status === 'failed') return <Notice kind="error">🎉 Вы победили, но отправить приз пока не удалось. Организатор уже в курсе — мы свяжемся с вами.</Notice>;

  // needs_username — нужен получатель
  const issue = prize.issue ?? 'no_username';
  const canOwn = !!myUsername && !(issue !== 'no_username' && prize.recipient === myUsername);
  return (
    <>
      <Notice kind="success">🎉 Вы победили! Осталось указать, куда отправить приз.</Notice>
      <Section title="Получить приз" footer={`Сделайте это до ${dateTime(prize.deadline)} — иначе приз будет разыгран заново.`}>
        <Row icon="ℹ️" label={REASON[issue]} />
        {canOwn && <Row icon="👤" label={`На мой аккаунт @${myUsername}`} hint="Ник уже стоит — можно получать" onClick={() => void claim(null)} right="›" />}
        {!myUsername && <Row icon="✏️" label="Поставить себе ник" hint="Настройки Telegram → Имя пользователя. Затем закройте и откройте это окно." />}
        <div class="pad">
          <div class="label">Или отправить на другой аккаунт (например, друга)</div>
          <div class="inline-form flush">
            <input
              class="input"
              placeholder="@username"
              value={other}
              autocapitalize="off"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => {
                setOther((e.currentTarget as HTMLInputElement).value);
                setChecked(null);
              }}
            />
            <button class="btn" type="button" disabled={busy || other.trim().length < 4} onClick={check}>
              Проверить
            </button>
          </div>
          {err && <p class="error-text">{err}</p>}
        </div>
        {checked && <Row icon="🎁" label={`Получит: ${checked.name}`} hint={`@${checked.username} — проверьте, что это нужный аккаунт`} />}
      </Section>
      {checked ? (
        <MainButton text={`Отправить приз на @${checked.username}`} onClick={() => void claim(checked.username)} progress={busy} />
      ) : canOwn ? (
        <MainButton text={`Отправить на мой @${myUsername}`} onClick={() => void claim(null)} progress={busy} />
      ) : null}
    </>
  );
}
