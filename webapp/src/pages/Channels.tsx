import { useState } from 'preact/hooks';
import { post } from '../api';
import { useSession } from '../main';
import { Notice, Row, Section } from '../ui';
import { alertMsg, haptic, tg } from '../tg';

/** Подключение канала: добавить бота админом (deep link) или привязать по @username */
export function ChannelsSection(props: { selectable?: boolean; value?: number | null; onSelect?: (id: number) => void }) {
  const { me, reloadMe } = useSession();
  const [linking, setLinking] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  const link = async () => {
    setBusy(true);
    try {
      await post('/channels/link', { username });
      await reloadMe();
      setLinking(false);
      setUsername('');
      haptic('success');
    } catch (e) {
      haptic('error');
      await alertMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={props.selectable ? 'Канал для публикации' : 'Мои каналы'}
      footer="Бот должен быть администратором канала с правами «Публикация сообщений» и «Редактирование сообщений»."
    >
      {me.channels.length === 0 && <p class="empty">Каналов пока нет.</p>}
      {me.channels.map((c) => (
        <Row
          key={c.id}
          icon="📣"
          label={c.title}
          hint={c.username ? `@${c.username}` : 'приватный канал'}
          right={
            props.selectable ? (
              <span class={`radio ${props.value === c.id ? 'on' : ''}`} aria-hidden="true" />
            ) : c.botCanPost ? (
              <span class="ok">готов</span>
            ) : (
              <span class="warn">нет прав</span>
            )
          }
          onClick={props.selectable ? () => props.onSelect?.(c.id) : undefined}
        />
      ))}
      <Row icon="➕" label="Подключить канал" hint="Откроется выбор канала, где бот станет админом" onClick={() => tg.openTelegramLink(me.connectChannelLink)} />
      {!linking ? (
        <Row icon="🔗" label="Бот уже в канале" hint="Привязать по @username" onClick={() => setLinking(true)} />
      ) : (
        <div class="inline-form">
          <input class="input" placeholder="@mychannel" value={username} onInput={(e) => setUsername((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn primary" type="button" disabled={busy || username.length < 4} onClick={link}>
            Привязать
          </button>
        </div>
      )}
      {props.selectable && me.channels.some((c) => !c.botCanPost) && <Notice kind="warn">У бота нет прав в некоторых каналах — выдайте их и откройте приложение снова.</Notice>}
      <button type="button" class="link-btn" onClick={() => reloadMe()}>
        Обновить список
      </button>
    </Section>
  );
}
