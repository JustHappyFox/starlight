import type { AppContext } from '../context.js';
import type { GiveawayRow } from '../db/repo.js';
import type { DrawProof } from '../../../shared/types.js';
import { pseudonym, runDraw } from '../../../shared/fairness.js';
import { sha256Hex } from '../util/ids.js';
import { isSubscribed } from './giveaways.js';
import { buttonMarkup, prizeLabel, renderResults } from './post.js';
import { dm, notifyAdmins } from './notify.js';
import { escapeHtml } from '../util/html.js';
import { unitPriceCents } from './pricing.js';

interface PartialProof {
  entropy?: { source: string; value: string };
}

async function editButton(ctx: AppContext, g: GiveawayRow, phase: 'drawing' | 'finished') {
  if (g.channel_id === null || !g.post_message_id) return;
  try {
    await ctx.tg.editMessageReplyMarkup(g.channel_id, g.post_message_id, { reply_markup: buttonMarkup(ctx, g, phase) });
    ctx.repo.updateGiveaway(g.id, { button_phase: phase, button_updated_at: ctx.now() }, ctx.now());
  } catch (e) {
    if (!String(e).includes('message is not modified')) ctx.log.warn({ gid: g.id, err: String(e) }, 'edit button failed');
  }
}

/**
 * Подведение итогов. Идемпотентно: при падении посередине статус остаётся 'drawing',
 * а планировщик повторит вызов с тем же seed, тем же списком и той же сохранённой энтропией.
 */
export async function drawGiveaway(ctx: AppContext, gid: string): Promise<void> {
  const now = ctx.now();
  let g = ctx.repo.getGiveaway(gid);
  if (!g) return;
  if (g.status === 'active') {
    if (now < g.ends_at) return;
    if (!ctx.repo.transitionGiveaway(gid, 'active', 'drawing', now)) return;
    g = ctx.repo.getGiveaway(gid)!;
    await editButton(ctx, g, 'drawing');
  }
  if (g.status !== 'drawing') return;

  // 1. энтропия фиксируется один раз
  let partial: PartialProof = g.proof ? (JSON.parse(g.proof) as PartialProof) : {};
  if (!partial.entropy) {
    try {
      const head = await ctx.toncenter.masterchainHead();
      partial.entropy = { source: `ton-masterchain:${head.seqno}`, value: head.rootHash };
    } catch (e) {
      ctx.log.warn({ gid, err: String(e) }, 'entropy unavailable, drawing without external entropy');
      partial.entropy = { source: 'none', value: '' };
    }
    ctx.repo.updateGiveaway(gid, { proof: JSON.stringify(partial) }, ctx.now());
  }

  // 2. пул участников (бан/глобальный бан исключены), билеты = 1 + min(рефералы, cap)
  const pool = ctx.repo.drawPool(gid);
  const byP = new Map<string, number>();
  const entries = pool.map((r) => {
    const p = pseudonym(sha256Hex, gid, r.user_id);
    byP.set(p, r.user_id);
    return { p, t: 1 + Math.min(r.referrals, ctx.cfg.REF_TICKET_CAP) };
  });

  // 3. розыгрыш с финальной проверкой каждого победителя
  const channelId = g.channel_id;
  const requireSub = !!g.require_subscription;
  const result = await runDraw({
    sha: sha256Hex,
    seed: g.seed,
    entropy: partial.entropy.value,
    entries,
    winnersCount: g.winners_count,
    decide: async (p) => {
      const uid = byP.get(p)!;
      const u = ctx.repo.getUser(uid);
      if (!u || u.global_ban) return { ok: false, reason: 'banned' };
      if (requireSub && channelId !== null && !(await isSubscribed(ctx, channelId, uid))) return { ok: false, reason: 'not_subscribed' };
      return { ok: true };
    },
  });

  const proof: DrawProof = {
    version: 1,
    giveawayId: gid,
    seed: g.seed,
    seedHash: g.seed_hash,
    entropy: partial.entropy,
    participantsHash: result.participantsHash,
    entries: [...entries].sort((a, b) => (a.p < b.p ? -1 : 1)),
    steps: result.steps,
    winnersCount: g.winners_count,
  };

  const done = ctx.repo.tx(() => {
    const ts = ctx.now();
    result.winners.forEach((p, i) => ctx.repo.insertWinner({ giveaway_id: gid, user_id: byP.get(p)!, place: i + 1, status: 'pending' }, ts));
    const unused = g!.winners_count - result.winners.length;
    if (unused > 0) {
      ctx.repo.insertRefund(
        { giveaway_id: gid, reason: `не разыграно призов: ${unused}`, usd_cents: unused * unitPriceCents(ctx.cfg, g!.prize_type, g!.prize_amount) },
        ts,
      );
    }
    return ctx.repo.transitionGiveaway(gid, 'drawing', 'finished', ts, { proof: JSON.stringify(proof), drawn_at: ts });
  });
  if (!done) return;

  g = ctx.repo.getGiveaway(gid)!;
  ctx.log.info({ gid, winners: result.winners.length, participants: entries.length }, 'giveaway drawn');
  await afterDraw(ctx, g);
}

async function afterDraw(ctx: AppContext, g: GiveawayRow) {
  await editButton(ctx, g, 'finished');
  const winners = ctx.repo.listWinners(g.id);
  if (g.publish_results && g.channel_id !== null) {
    try {
      const msg = await ctx.tg.sendMessage(g.channel_id, renderResults(g, winners), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(g.post_message_id ? { reply_parameters: { message_id: g.post_message_id, allow_sending_without_reply: true } } : {}),
        reply_markup: { inline_keyboard: [[{ text: '🏆 Результаты и проверка', url: ctx.links.giveaway(g.id) }]] },
      });
      ctx.repo.updateGiveaway(g.id, { results_message_id: msg.message_id }, ctx.now());
    } catch (e) {
      ctx.log.warn({ gid: g.id, err: String(e) }, 'results post failed');
    }
  }
  const prize = escapeHtml(prizeLabel(g.prize_type, g.prize_amount));
  for (const w of winners) {
    await dm(
      ctx,
      w.user_id,
      `🎉 <b>Вы выиграли!</b>\n\nПриз: ${prize}\nОн будет отправлен на ваш аккаунт${w.username ? ` @${escapeHtml(w.username)}` : ''} автоматически. Не меняйте username, пока приз не придёт.`,
    );
  }
  const unused = g.winners_count - winners.length;
  await dm(
    ctx,
    g.creator_id,
    `🏁 Розыгрыш <b>${g.id}</b> завершён.\nУчастников: ${g.participants_count}, победителей: ${winners.length}.` +
      (unused > 0 ? `\n\n⚠️ Не разыграно призов: ${unused} — оформлен возврат, с вами свяжется поддержка.` : ''),
  );
  if (unused > 0) await notifyAdmins(ctx, `💸 Возврат: розыгрыш ${g.id}, не разыграно ${unused} приз(ов). /refunds`);
}
