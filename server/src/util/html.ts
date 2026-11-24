// Санитайзер текста поста под Telegram HTML parse_mode.
// Разрешены только теги, которые поддерживает Telegram; всё остальное экранируется.

const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote', 'tg-spoiler', 'a']);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SAFE_HREF = /^(https?:\/\/|tg:\/\/)[^\s"'<>]+$/i;

/** Возвращает безопасный HTML с закрытыми тегами. */
export function sanitizeTelegramHtml(input: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  const re = /<\/?([a-zA-Z-]+)([^<>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    out.push(escapeText(input.slice(last, m.index)));
    last = re.lastIndex;
    const full = m[0];
    const tag = m[1]!.toLowerCase();
    const closing = full.startsWith('</');
    if (!ALLOWED.has(tag)) {
      out.push(escapeHtml(full));
      continue;
    }
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) {
        out.push(escapeHtml(full));
        continue;
      }
      while (stack.length > idx) out.push(`</${stack.pop()}>`);
      continue;
    }
    if (tag === 'a') {
      const href = /href\s*=\s*"([^"]*)"/i.exec(m[2] ?? '')?.[1] ?? /href\s*=\s*'([^']*)'/i.exec(m[2] ?? '')?.[1];
      if (!href || !SAFE_HREF.test(href)) {
        out.push(escapeHtml(full));
        continue;
      }
      out.push(`<a href="${escapeHtml(href)}">`);
    } else {
      out.push(`<${tag}>`);
    }
    stack.push(tag);
  }
  out.push(escapeText(input.slice(last)));
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}

// Текст между тегами: экранируем < > и «голые» &, но сохраняем уже корректные сущности.
function escapeText(s: string): string {
  return s
    .replace(/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Длина текста без тегов — Telegram ограничивает 4096 символов сообщения */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot);/g, '_').length;
}
