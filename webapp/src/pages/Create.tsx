import { useEffect, useMemo, useState } from 'preact/hooks';
import { get, post, put } from '../api';
import { navigate } from '../router';
import { useSession } from '../main';
import { BackButton, Chips, MainButton, Notice, Row, Section, Segmented, Spinner, Toggle } from '../ui';
import { alertMsg, haptic } from '../tg';
import { fromLocalInput, plural, toLocalInput, usd } from '../format';
import { COUNTRIES, countryName, flag } from '../countries';
import { ChannelsSection } from './Channels';
import type { GiveawayInput, GiveawayOwnerView, PriceQuote, PrizeType } from '../../../shared/types';

function defaultEnd(): number {
  const d = new Date(Date.now() + 3 * 86_400_000);
  d.setHours(20, 0, 0, 0);
  return d.getTime();
}

const DEFAULT_POST = '🎉 <b>Розыгрыш для подписчиков!</b>\n\nЖмите кнопку ниже, чтобы участвовать. Победителей выберет бот случайным образом.';

export function Create(props: { editId?: string }) {
  const { config, me } = useSession();
  const L = config.limits;
  const [loaded, setLoaded] = useState(!props.editId);
  const [form, setForm] = useState<GiveawayInput>({
    prizeType: 'stars',
    prizeAmount: 100,
    winnersCount: 3,
    startsAt: null,
    endsAt: defaultEnd(),
    countries: null,
    captcha: true,
    honeypot: true,
    requireSubscription: true,
    publishResults: true,
    showCounter: true,
    buttonText: config.buttonPresets[0] ?? 'Участвовать',
    postText: DEFAULT_POST,
    channelId: me.channels[0]?.id ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [countryQuery, setCountryQuery] = useState('');
  const [customStars, setCustomStars] = useState(false);

  const set = <K extends keyof GiveawayInput>(k: K, v: GiveawayInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!props.editId) return;
    get<GiveawayOwnerView>(`/giveaways/${props.editId}`).then((g) => {
      const { prizeType, prizeAmount, winnersCount, startsAt, endsAt, countries, captcha, honeypot, requireSubscription, publishResults, showCounter, buttonText, postText, channelId, timezone } = g;
      setForm({ prizeType, prizeAmount, winnersCount, startsAt, endsAt, countries, captcha, honeypot, requireSubscription, publishResults, showCounter, buttonText, postText, channelId, timezone });
      setCustomStars(prizeType === 'stars' && !L.starsPresets.includes(prizeAmount));
      setLoaded(true);
    });
  }, [props.editId]);

  // живая цена
  useEffect(() => {
    const t = setTimeout(() => {
      get<PriceQuote>(`/quote?type=${form.prizeType}&amount=${form.prizeAmount}&winners=${form.winnersCount}`).then(
        (q) => {
          setQuote(q);
          setQuoteErr(null);
        },
        (e) => {
          setQuote(null);
          setQuoteErr(e.message);
        },
      );
    }, 250);
    return () => clearTimeout(t);
  }, [form.prizeType, form.prizeAmount, form.winnersCount]);

  const setType = (t: PrizeType) => setForm((f) => ({ ...f, prizeType: t, prizeAmount: t === 'stars' ? 100 : 3 }));

  const filteredCountries = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    return COUNTRIES.filter((c) => !q || countryName(c).toLowerCase().includes(q) || c.toLowerCase() === q).slice(0, q ? 40 : 21);
  }, [countryQuery]);

  const toggleCountry = (c: string) => {
    const cur = new Set(form.countries ?? []);
    if (cur.has(c)) cur.delete(c);
    else cur.add(c);
    set('countries', cur.size ? [...cur].sort() : []);
  };

  const problems: string[] = [];
  if (!form.channelId) problems.push('выберите канал');
  if (form.countries && form.countries.length === 0) problems.push('выберите хотя бы одну страну');
  if (form.endsAt - Date.now() < L.minDurationMinutes * 60_000) problems.push('дата окончания слишком близко');
  if (!form.buttonText.trim()) problems.push('текст кнопки пуст');

  const save = async () => {
    if (problems.length) {
      haptic('error');
      return alertMsg('Проверьте: ' + problems.join(', '));
    }
    setSaving(true);
    try {
      const body = { ...form, startsAt: null, countries: form.countries && form.countries.length ? form.countries : null };
      const g = props.editId ? await put<GiveawayOwnerView>(`/giveaways/${props.editId}`, body) : await post<GiveawayOwnerView>('/giveaways', body);
      haptic('success');
      navigate(`/my/${g.id}`, true);
    } catch (e) {
      haptic('error');
      await alertMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <Spinner />;

  return (
    <main class="page">
      <BackButton onBack={() => history.back()} />
      <h1 class="page-title">{props.editId ? 'Изменить розыгрыш' : 'Новый розыгрыш'}</h1>

      <Section title="Приз" footer="Каждый победитель получает одинаковый приз. Цена — по прайсу Telegram.">
        <div class="pad">
          <Segmented<PrizeType>
            value={form.prizeType}
            onChange={setType}
            options={[
              { value: 'stars', label: '⭐ Stars' },
              { value: 'premium', label: '💎 Premium' },
            ]}
          />
        </div>
        {form.prizeType === 'stars' ? (
          <div class="pad">
            <div class="label">Звёзд каждому победителю</div>
            <Chips<number | 'custom'>
              value={customStars ? 'custom' : form.prizeAmount}
              onChange={(v) => {
                if (v === 'custom') setCustomStars(true);
                else {
                  setCustomStars(false);
                  set('prizeAmount', v);
                }
              }}
              options={[...L.starsPresets.map((s) => ({ value: s as number | 'custom', label: `${s} ⭐` })), { value: 'custom', label: 'Своё' }]}
            />
            {customStars && (
              <input
                class="input mt"
                type="number"
                inputMode="numeric"
                min={L.minStars}
                max={L.maxStars}
                value={form.prizeAmount}
                onInput={(e) => set('prizeAmount', Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 0))}
              />
            )}
          </div>
        ) : (
          <div class="pad">
            <div class="label">Срок подписки</div>
            <Chips<number> value={form.prizeAmount} onChange={(v) => set('prizeAmount', v)} options={L.premiumMonths.map((m) => ({ value: m, label: `${m} мес.` }))} />
          </div>
        )}
        <div class="pad">
          <div class="label">Количество победителей (призов)</div>
          <div class="stepper">
            <button type="button" class="btn" onClick={() => set('winnersCount', Math.max(1, form.winnersCount - 1))} aria-label="меньше">
              −
            </button>
            <input
              class="input center"
              type="number"
              inputMode="numeric"
              min={1}
              max={L.maxWinners}
              value={form.winnersCount}
              onInput={(e) => set('winnersCount', Math.min(L.maxWinners, Math.max(1, Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 1))))}
            />
            <button type="button" class="btn" onClick={() => set('winnersCount', Math.min(L.maxWinners, form.winnersCount + 1))} aria-label="больше">
              +
            </button>
          </div>
        </div>
        <div class="price-line">
          {quote ? (
            <>
              <span>Итого</span>
              <b>
                {quote.totalTon} TON <span class="hint">≈ {usd(quote.totalUsd)}</span>
              </b>
            </>
          ) : quoteErr ? (
            <span class="error-text">{quoteErr}</span>
          ) : (
            <span class="hint">Считаем цену…</span>
          )}
        </div>
      </Section>

      <Section
        title="Сроки"
        footer={`Время по часам вашего телефона (${form.timezone}). Когда опубликовать пост — сейчас или в выбранное время — спросим после оплаты.`}
      >
        <label class="row">
          <span class="row-main">
            <span class="row-label">Подведение итогов</span>
          </span>
          <input
            class="input date"
            type="datetime-local"
            value={toLocalInput(form.endsAt)}
            onInput={(e) => {
              const v = fromLocalInput((e.currentTarget as HTMLInputElement).value);
              if (v) set('endsAt', v);
            }}
          />
        </label>
      </Section>

      <Section title="Страны" footer="Страна определяется по номеру телефона: участник один раз подтверждает его кнопкой Telegram. Анонимные номера (+888) не проходят.">
        <Toggle label="Все страны" checked={form.countries === null} onChange={(v) => set('countries', v ? null : [])} />
        {form.countries !== null && (
          <div class="pad">
            {form.countries.length > 0 && (
              <div class="chips mb">
                {form.countries.map((c) => (
                  <button type="button" class="chip active" onClick={() => toggleCountry(c)}>
                    {flag(c)} {countryName(c)} ✕
                  </button>
                ))}
              </div>
            )}
            <input class="input" placeholder="Поиск страны" value={countryQuery} onInput={(e) => setCountryQuery((e.currentTarget as HTMLInputElement).value)} />
            <div class="country-list">
              {filteredCountries.map((c) => (
                <label class="country">
                  <input type="checkbox" checked={form.countries?.includes(c) ?? false} onChange={() => toggleCountry(c)} />
                  <span>
                    {flag(c)} {countryName(c)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section title="Защита от ботов" footer="Ловушка — невидимая для человека кнопка. Бот, нажавший её, теряет доступ к розыгрышу и видит уведомление при попытке участвовать.">
        <Toggle label="Капча с картинкой" hint="Ввести символы с изображения" checked={form.captcha} onChange={(v) => set('captcha', v)} />
        <Toggle label="Кнопка-ловушка" hint="Невидимая приманка для автокликеров" checked={form.honeypot} onChange={(v) => set('honeypot', v)} />
        <Toggle label="Обязательная подписка" hint="Проверяется при участии и перед выдачей приза" checked={form.requireSubscription} onChange={(v) => set('requireSubscription', v)} />
      </Section>

      <ChannelsSection selectable value={form.channelId} onSelect={(id) => set('channelId', id)} />

      <Section title="Пост в канале" footer="Можно использовать <b>, <i>, <u>, <s>, <a href>, <tg-spoiler>. Условия, срок и гарантии бот добавит в конец поста сам.">
        <div class="pad">
          <textarea class="input textarea" rows={6} maxLength={config.limits.postTextMax} value={form.postText} onInput={(e) => set('postText', (e.currentTarget as HTMLTextAreaElement).value)} />
        </div>
        <div class="pad">
          <div class="label">Текст кнопки под постом</div>
          <Chips<string> value={config.buttonPresets.includes(form.buttonText) ? form.buttonText : null} onChange={(v) => set('buttonText', v)} options={config.buttonPresets.map((b) => ({ value: b, label: b }))} />
          <input
            class="input mt"
            maxLength={L.buttonTextMax}
            placeholder="Свой текст кнопки"
            value={form.buttonText}
            onInput={(e) => set('buttonText', (e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <Toggle label="Число участников на кнопке" hint={`«${form.buttonText || '…'} (128)»`} checked={form.showCounter} onChange={(v) => set('showCounter', v)} />
        <Toggle label="Опубликовать результаты после розыгрыша" hint="Бот пришлёт в канал список победителей" checked={form.publishResults} onChange={(v) => set('publishResults', v)} />
      </Section>

      <Section title="Как участвуют">
        <Row icon="0️⃣" label="Вы оплачиваете и жмёте «Опубликовать»" hint="Сразу или в выбранное время" />
        <Row icon="1️⃣" label="Нажимают кнопку под постом" hint={form.captcha ? 'Открывается окно с капчей' : 'Открывается окно розыгрыша'} />
        <Row icon="2️⃣" label="Получают билет и реф-ссылку" hint="Каждый приглашённый друг — +1 билет и выше шанс" />
        <Row icon="3️⃣" label="Бот выбирает победителей" hint="Честно и проверяемо, призы приходят автоматически" />
      </Section>

      {problems.length > 0 && <Notice kind="warn">Осталось: {problems.join(', ')}.</Notice>}

      <MainButton
        text={quote ? `Далее · ${quote.totalTon} TON` : 'Далее'}
        onClick={save}
        progress={saving}
        disabled={!quote}
      />
      <p class="foot-hint">
        {form.winnersCount} {plural(form.winnersCount, 'приз', 'приза', 'призов')} · условия фиксируются после оплаты
      </p>
    </main>
  );
}
