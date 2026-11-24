import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, get, post } from '../api';
import { navigate } from '../router';
import { BackButton, MainButton, Notice, Row, Section, Spinner, useNow } from '../ui';
import { alertMsg, copyText, haptic, inTelegram, shareLink, tg } from '../tg';
import { PRIZE_STATUS, dateTime, left, plural, prizeLong } from '../format';
import { countryName, flag } from '../countries';
import type { CaptchaChallenge, PublicGiveawayView } from '../../../shared/types';

export function Participant(props: { id: string; refCode: string | null }) {
  const [view, setView] = useState<PublicGiveawayView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null);
  const [answer, setAnswer] = useState('');
  const [captchaErr, setCaptchaErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [proof, setProof] = useState<string | null>(null);
  const hpField = useRef<HTMLInputElement>(null);
  const openedAt = useRef(Date.now());
  const interactions = useRef(0);
  const askedWrite = useRef(false);
  const now = useNow(30_000);

  const load = async () => {
    try {
      setView(await get<PublicGiveawayView>(`/g/${props.id}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const newChallenge = async () => {
    try {
      setChallenge(await post<CaptchaChallenge>(`/g/${props.id}/challenge`));
      setAnswer('');
    } catch (e) {
      setCaptchaErr((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const count = () => (interactions.current += 1);
    window.addEventListener('pointerdown', count, { passive: true });
    window.addEventListener('keydown', count, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', count);
      window.removeEventListener('keydown', count);
    };
  }, [props.id]);

  const needCaptcha = !!view && view.phase === 'active' && !view.me.joined && view.captcha;
  useEffect(() => {
    if (needCaptcha && !challenge) void newChallenge();
  }, [needCaptcha]);

  // Ловушка: невидимая кнопка. Человек её не видит; скрипт, кликающий всё подряд, — нажмёт.
  const honeypot = () => {
    void post(`/g/${props.id}/hp`, { kind: 'button' }).catch(() => undefined);
  };

  const verifyPhone = () =>
    new Promise<void>((resolve) => {
      tg.requestContact(async (ok, res) => {
        if (!ok) return resolve();
        try {
          if (res?.response) await post('/me/contact', { response: res.response });
        } catch {
          /* контакт всё равно придёт боту сообщением */
        }
        // ждём, пока бот получит контакт
        for (let i = 0; i < 6; i++) {
          const v = await get<PublicGiveawayView>(`/g/${props.id}`);
          setView(v);
          if (v.me.phoneCountry) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        resolve();
      });
    });

  const join = async () => {
    if (!view || busy) return;
    if (blocked) return alertMsg(blocked, 'Доступ заблокирован');
    if (view.captcha && answer.trim().length < 4) {
      haptic('error');
      setCaptchaErr('Введите символы с картинки');
      return;
    }
    setBusy(true);
    setCaptchaErr(null);
    try {
      if (inTelegram && !askedWrite.current && !tg.initDataUnsafe.user?.allows_write_to_pm && tg.isVersionAtLeast('6.9')) {
        askedWrite.current = true;
        await new Promise<void>((r) => tg.requestWriteAccess(() => r()));
      }
      const res = await post<PublicGiveawayView | { ok: true }>(`/g/${props.id}/join`, {
        challengeId: challenge?.challengeId,
        answer: answer.trim(),
        ref: props.refCode ?? undefined,
        website: hpField.current?.value ?? '',
        signals: { openedAt: openedAt.current, interactions: interactions.current, webdriver: !!navigator.webdriver },
      });
      if ('me' in res) {
        setView(res);
        haptic('success');
      } else {
        await load();
      }
    } catch (e) {
      haptic('error');
      const code = e instanceof ApiError ? e.code : 'internal';
      const msg = (e as Error).message;
      if (code === 'banned') {
        setBlocked(msg);
        await alertMsg(msg, '🚫 Доступ заблокирован');
      } else if (code === 'captcha_wrong' || code === 'captcha_expired' || code === 'too_fast' || code === 'captcha_required') {
        setCaptchaErr(msg);
        await newChallenge();
      } else if (code === 'need_phone') {
        await verifyPhone();
      } else if (code === 'need_subscription') {
        await alertMsg(msg);
        if (view.channel.url) tg.openTelegramLink(view.channel.url);
      } else {
        await alertMsg(msg);
        if (code === 'not_active') await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const invite = () => {
    if (!view?.me.refLink) return;
    shareLink(view.me.refLink, `Участвую в розыгрыше ${prizeLong(view.prizeType, view.prizeAmount)} — присоединяйся!`);
  };

  const loadProof = async () => {
    try {
      const p = await get<unknown>(`/g/${props.id}/proof`);
      setProof(JSON.stringify(p, null, 2));
    } catch (e) {
      await alertMsg((e as Error).message);
    }
  };

  if (err)
    return (
      <main class="page">
        <BackButton onBack={() => navigate('/')} />
        <Notice kind="error">{err}</Notice>
      </main>
    );
  if (!view) return <Spinner label="Загружаем розыгрыш…" />;

  const me = view.me;
  const phaseText =
    view.phase === 'active'
      ? `Итоги через ${left(view.endsAt - now)} · ${dateTime(view.endsAt)}`
      : view.phase === 'upcoming'
        ? `Начнётся ${view.startsAt ? dateTime(view.startsAt) : 'скоро'}`
        : view.phase === 'drawing'
          ? 'Подводим итоги…'
          : view.phase === 'finished'
            ? `Завершён ${view.results ? dateTime(view.results.drawnAt) : ''}`
            : 'Розыгрыш недоступен';

  return (
    <main class="page">
      {!inTelegram && <BackButton onBack={() => navigate('/')} />}

      <header class="prize-card">
        <div class="prize-emoji" aria-hidden="true">{view.prizeType === 'stars' ? '⭐' : '💎'}</div>
        <div class="prize-title">{prizeLong(view.prizeType, view.prizeAmount)}</div>
        <div class="prize-sub">
          {view.winnersCount} {plural(view.winnersCount, 'победитель', 'победителя', 'победителей')} · {view.channel.title}
        </div>
        <div class="stats">
          <div>
            <b>{view.participantsCount}</b>
            <span>{plural(view.participantsCount, 'участник', 'участника', 'участников')}</span>
          </div>
          {me.joined && (
            <div>
              <b>{me.tickets}</b>
              <span>{plural(me.tickets, 'билет', 'билета', 'билетов')}</span>
            </div>
          )}
        </div>
        <p class="phase">{phaseText}</p>
      </header>

      {/* ---------- участие ---------- */}
      {view.phase === 'active' && !me.joined && (
        <>
          <Section title="Условия">
            <Row icon={me.hasUsername ? '✅' : '⚠️'} label="Публичный @username" hint={me.hasUsername ? 'Есть — на него придёт приз' : 'Настройки Telegram → Имя пользователя. Без него приз не отправить.'} />
            {view.requireSubscription && (
              <Row icon="📣" label={`Подписка на «${view.channel.title}»`} hint="Проверим при участии и перед выдачей приза" onClick={view.channel.url ? () => tg.openTelegramLink(view.channel.url!) : undefined} right={view.channel.url ? 'Открыть' : undefined} />
            )}
            {view.countries && (
              <Row
                icon={me.phoneCountry ? (me.countryOk ? '✅' : '⛔') : '📱'}
                label={`Страны: ${view.countries.map((c) => flag(c)).join(' ')}`}
                hint={
                  me.phoneCountry
                    ? me.countryOk
                      ? `Ваша страна: ${countryName(me.phoneCountry)}`
                      : `Ваша страна (${countryName(me.phoneCountry)}) не участвует`
                    : 'Подтвердите номер телефона — по нему определяется страна. Сам номер не сохраняется.'
                }
                onClick={!me.phoneCountry ? () => void verifyPhone() : undefined}
                right={!me.phoneCountry ? 'Подтвердить' : undefined}
              />
            )}
          </Section>

          {view.captcha && (
            <Section title="Проверка" footer="Введите символы с картинки. Регистр не важен.">
              <form
                class="captcha"
                onSubmit={(e) => {
                  e.preventDefault();
                  void join();
                }}
                autocomplete="off"
              >
                <div class="captcha-img">
                  {challenge ? <img src={challenge.image} alt="Символы для ввода" width={260} height={96} /> : <div class="spinner" />}
                  <button type="button" class="icon-btn" onClick={newChallenge} aria-label="Другая картинка">
                    ↻
                  </button>
                </div>
                <input
                  class="input captcha-input"
                  value={answer}
                  maxLength={8}
                  autocapitalize="characters"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="Символы с картинки"
                  onInput={(e) => setAnswer((e.currentTarget as HTMLInputElement).value.toUpperCase())}
                />
                {/* поле-ловушка: невидимо и недоступно с клавиатуры */}
                <input ref={hpField} class="hp" type="text" name="website" tabIndex={-1} autocomplete="off" aria-hidden="true" />
                {captchaErr && <p class="error-text">{captchaErr}</p>}
              </form>
            </Section>
          )}
          {!view.captcha && captchaErr && <Notice kind="error">{captchaErr}</Notice>}
          {!view.captcha && <input ref={hpField} class="hp" type="text" name="website" tabIndex={-1} autocomplete="off" aria-hidden="true" />}

          {/* кнопка-ловушка */}
          <button type="button" class="hp" tabIndex={-1} aria-hidden="true" onClick={honeypot}>
            Участвовать
          </button>

          <MainButton text="Участвовать" onClick={join} progress={busy} />
        </>
      )}

      {/* ---------- увеличить шанс ---------- */}
      {me.joined && view.phase !== 'finished' && (
        <>
          <Notice kind="success">🎟 Вы участвуете! Результаты — {dateTime(view.endsAt)}.</Notice>
          <Section title="Увеличить шанс" footer="За каждого друга, который примет участие по вашей ссылке, — +1 билет. Чем больше билетов, тем выше шанс, что выпадет ваш.">
            <Row label="Участников всего" right={<b>{view.participantsCount}</b>} />
            <Row label="Вы пригласили" right={<b>{me.referrals}</b>} />
            <Row label="Ваши билеты" right={<b>{me.tickets}</b>} />
            <Row
              icon="🔗"
              label="Ваша ссылка"
              hint={me.refLink}
              right="⧉"
              onClick={async () => {
                if (me.refLink && (await copyText(me.refLink))) {
                  haptic('success');
                  await alertMsg('Ссылка скопирована');
                }
              }}
            />
          </Section>
          <MainButton text="Увеличить шанс — пригласить друзей" onClick={invite} />
        </>
      )}

      {view.phase === 'upcoming' && <Notice>Розыгрыш ещё не начался. Загляните позже.</Notice>}
      {view.phase === 'drawing' && <Notice>Выбираем победителей. Обновите через минуту.</Notice>}

      {/* ---------- результаты ---------- */}
      {view.phase === 'finished' && view.results && (
        <>
          {me.isWinner && <Notice kind="success">🎉 Вы победили! Приз отправим на ваш @username автоматически.</Notice>}
          <Section title={`Победители (${view.results.winners.length})`}>
            {view.results.winners.length === 0 && <p class="empty">Победителей нет.</p>}
            {view.results.winners.map((w) => (
              <Row key={w.place} icon={w.place <= 3 ? ['🥇', '🥈', '🥉'][w.place - 1] : `${w.place}.`} label={w.username ? `@${w.username}` : w.name} right={<span class="hint">{PRIZE_STATUS[w.prizeStatus]}</span>} />
            ))}
          </Section>
          <Section
            title="Честность"
            footer="До начала был опубликован хеш секретного числа. В конце оно раскрыто и смешано со списком участников и хешем блока TON — результат может пересчитать любой (скрипт verify-draw в репозитории)."
          >
            <Row label="Хеш до розыгрыша" hint={view.seedHash} />
            {view.results.proofAvailable && <Row icon="📄" label="Протокол розыгрыша (JSON)" onClick={loadProof} right="›" />}
            {proof && (
              <div class="pad">
                <textarea class="input textarea mono" rows={8} readOnly value={proof} />
                <button type="button" class="btn block mt" onClick={async () => (await copyText(proof)) && haptic('success')}>
                  Скопировать
                </button>
              </div>
            )}
          </Section>
        </>
      )}
    </main>
  );
}
