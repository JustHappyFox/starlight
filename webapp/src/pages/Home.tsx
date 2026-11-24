import { useEffect, useState } from 'preact/hooks';
import { get } from '../api';
import { navigate } from '../router';
import { useSession } from '../main';
import { MainButton, Notice, Row, Section, Spinner } from '../ui';
import { STATUS_LABEL, dateTime, prizeTitle } from '../format';
import type { GiveawayOwnerView } from '../../../shared/types';
import { ChannelsSection } from './Channels';

export function Home() {
  const { me } = useSession();
  const [list, setList] = useState<GiveawayOwnerView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<GiveawayOwnerView[]>('/giveaways').then(setList, (e) => setErr(e.message));
  }, []);

  return (
    <main class="page">
      <header class="hero-head">
        <div class="logo" aria-hidden="true">🎁</div>
        <h1>Розыгрыши</h1>
        <p class="hint">Stars и Premium для подписчиков вашего канала. Призы оплачиваются заранее и выдаются ботом автоматически.</p>
      </header>

      <ChannelsSection />

      <Section title="Мои розыгрыши">
        {err && <Notice kind="error">{err}</Notice>}
        {!list && !err && <Spinner />}
        {list && list.length === 0 && <p class="empty">Пока нет розыгрышей. Создайте первый — это займёт пару минут.</p>}
        {list?.map((g) => (
          <Row
            key={g.id}
            icon={g.prizeType === 'stars' ? '⭐' : '💎'}
            label={`${prizeTitle(g.prizeType, g.prizeAmount)} × ${g.winnersCount}`}
            hint={`${STATUS_LABEL[g.status] ?? g.status} · до ${dateTime(g.endsAt)}`}
            right={g.status === 'active' ? <span class="badge live">{g.participantsCount}</span> : '›'}
            onClick={() => navigate(`/my/${g.id}`)}
          />
        ))}
      </Section>

      <p class="foot-hint">
        Вы — {me.firstName}
        {me.username ? ` (@${me.username})` : ''}. Бот: @{me.botUsername}
      </p>

      <MainButton text="Создать розыгрыш" onClick={() => navigate('/create')} />
    </main>
  );
}
