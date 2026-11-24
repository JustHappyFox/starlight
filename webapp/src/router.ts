import { useEffect, useState } from 'preact/hooks';

export function currentRoute(): string {
  const h = location.hash.slice(1);
  // telegram-web-app кладёт в hash свои параметры (tgWebAppData=...) — это не маршрут
  if (!h.startsWith('/')) return '/';
  return h;
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', `#${path}`);
  else history.pushState(null, '', `#${path}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): { path: string; query: URLSearchParams } {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  const [path, qs] = route.split('?');
  return { path: path || '/', query: new URLSearchParams(qs ?? '') };
}
