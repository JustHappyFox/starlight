import { render } from 'preact';
import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import './styles.css';
import { inTelegram, setDevInitData, tg } from './tg';
import { get } from './api';
import { navigate, useRoute } from './router';
import { Spinner, Notice } from './ui';
import type { AppConfigView, MeView } from '../../shared/types';
import { Home } from './pages/Home';
import { Create } from './pages/Create';
import { Owner } from './pages/Owner';
import { Participant } from './pages/Participant';

interface Session {
  config: AppConfigView;
  me: MeView;
  reloadMe: () => Promise<void>;
}

const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx)!;

function parseStart(p: string | undefined): { gid: string; ref: string | null } | null {
  const m = p ? /^([A-Za-z0-9]{6,16})(?:_([A-Za-z0-9]{4,16}))?$/.exec(p) : null;
  return m ? { gid: m[1]!, ref: m[2] ?? null } : null;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { path, query } = useRoute();

  useEffect(() => {
    tg.ready();
    tg.expand();
    (async () => {
      try {
        const config = await get<AppConfigView>('/config');
        if (!tg.initData && !inTelegram) {
          if (!config.devMode) throw new Error('Откройте приложение из Telegram.');
          // dev: подписанные initData от сервера (только DEV_MODE)
          const q = new URLSearchParams(location.search);
          const r = await get<{ initData: string }>(
            `/dev/initdata?id=${q.get('uid') ?? '1001'}&username=${q.get('username') ?? 'dev_user'}&name=${encodeURIComponent(q.get('name') ?? 'Dev')}${q.get('start') ? `&start=${q.get('start')}` : ''}`,
          );
          setDevInitData(r.initData);
        }
        const loadMe = () => get<MeView>('/me');
        const me = await loadMe();
        const s: Session = {
          config,
          me,
          reloadMe: async () => {
            const fresh = await loadMe();
            setSession((prev) => (prev ? { ...prev, me: fresh } : prev));
          },
        };
        setSession(s);
        // открыто по ссылке из поста: ?startapp=<gid>_<ref>
        const start = parseStart(tg.initDataUnsafe.start_param);
        if (start && !location.hash.startsWith('#/')) navigate(`/g/${start.gid}${start.ref ? `?ref=${start.ref}` : ''}`, true);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  if (error)
    return (
      <main class="page">
        <Notice kind="error">{error}</Notice>
      </main>
    );
  if (!session) return <Spinner label="Загрузка…" />;

  let page;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'g' && parts[1]) page = <Participant id={parts[1]} refCode={query.get('ref')} />;
  else if (parts[0] === 'my' && parts[1]) page = <Owner id={parts[1]} />;
  else if (parts[0] === 'create') page = <Create />;
  else if (parts[0] === 'edit' && parts[1]) page = <Create editId={parts[1]} />;
  else page = <Home />;

  return <SessionCtx.Provider value={session}>{page}</SessionCtx.Provider>;
}

render(<App />, document.getElementById('app')!);
