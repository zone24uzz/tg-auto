import type { Api } from 'grammy';
import type { ChatMemberUpdated } from 'grammy/types';
import type { AiRouter } from '../ai/router/types.js';
import type { Db } from '../database/client.js';
import type { Channel } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { ContentCipher } from '../security/crypto.js';
import { escapeHtml } from '../telegram/common/html.js';
import { currentTenant, currentTenantId, currentTenantOrNull, runAsSystem } from '../tenancy/context.js';

const log = childLogger('channels');
/** Telegram's message limit, with room for nothing else (the post is sent as plain text). */
const MAX_POST = 4000;

export interface ChannelButton {
  label: string;
  data: string;
}

export interface ChannelReply {
  text: string;
  buttons?: ChannelButton[][];
}

export interface ChannelDeps {
  db: Db;
  ai: AiRouter;
  cipher: ContentCipher;
  /** The bot that is admin in the channels (admin bot, or the main bot in single-bot mode). */
  api: Pick<Api, 'sendMessage' | 'leaveChat' | 'getChatMember'>;
  notifier: { text(html: string): Promise<number | undefined> };
  /** Builds callback_data for the post buttons (`as|cp|<verb>|<id>`). */
  button: (verb: string, id: number) => string;
}

function channelName(c: Pick<Channel, 'title' | 'username'>): string {
  return c.username ? `${c.title} (@${c.username})` : c.title;
}

/**
 * Channels of the CURRENT workspace (tenant-scoped table): the bot is added as an admin with the
 * "post messages" right; the owner asks for a post in the admin chat, sees a draft and publishes it
 * with ✅. A channel belongs to the workspace of the person who added the bot; other workspaces never
 * see it. Channels added by people without an active workspace are left immediately.
 */
export class ChannelService {
  constructor(private readonly d: ChannelDeps) {}

  /** `my_chat_member` update for the bot (runs in the scope of the person who changed the membership). */
  async onMembership(update: ChatMemberUpdated): Promise<void> {
    const chat = update.chat;
    if (chat.type !== 'channel') return;
    const status = update.new_chat_member.status;
    const joined = status === 'administrator' || status === 'member';
    const tenant = currentTenantOrNull();
    if (!tenant) {
      // Added by someone without an active workspace: never keep a foothold in their channel.
      if (joined) await this.d.api.leaveChat(chat.id).catch((error: unknown) => log.warn({ error: describeError(error) }, 'could not leave a channel'));
      // Removed by another admin of the channel: whichever workspace had it can no longer post there.
      else await runAsSystem(() => this.d.db.channel.updateMany({ where: { telegramChatId: BigInt(chat.id), active: true }, data: { active: false, canPost: false } }));
      return;
    }
    const telegramChatId = BigInt(chat.id);
    const title = (chat.title ?? 'Kanal').slice(0, 120);
    const username = 'username' in chat && chat.username ? chat.username : null;
    if (status === 'administrator') {
      const canPost = (update.new_chat_member as { can_post_messages?: boolean }).can_post_messages === true;
      const data = { title, username, addedByTelegramUserId: BigInt(update.from.id), canPost, active: true };
      await this.d.db.channel.upsert({
        where: { tenantId_telegramChatId: { tenantId: currentTenantId('channels'), telegramChatId } },
        create: { telegramChatId, ...data },
        update: data,
      });
      await this.d.notifier.text(
        canPost
          ? `✅ Kanal ulandi: <b>${escapeHtml(channelName({ title, username }))}</b>\n\nEndi menga yozing: <i>Kanalga post yoz: …</i>`
          : `🟡 Kanal ulandi: <b>${escapeHtml(title)}</b>, lekin menda «Xabar joylash» ruxsati yo‘q. Kanal → Administratorlar → bot → «Post messages» ni yoqing.`,
      );
      return;
    }
    const r = await this.d.db.channel.updateMany({ where: { telegramChatId, active: true }, data: { active: false, canPost: false } });
    if (r.count > 0) await this.d.notifier.text(`🔴 Bot kanaldan olib tashlandi: <b>${escapeHtml(title)}</b>`);
  }

  /** Active channels of the current workspace. */
  list(): Promise<Channel[]> {
    return this.d.db.channel.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
  }

  async listReply(): Promise<ChannelReply> {
    const channels = await this.list();
    if (channels.length === 0) return { text: this.howToConnect() };
    const lines = ['📢 <b>Ulangan kanallar</b>', ''];
    for (const c of channels) lines.push(`• ${escapeHtml(channelName(c))}${c.canPost ? '' : ' — ⚠️ «Xabar joylash» ruxsati yo‘q'}`);
    return { text: lines.join('\n') };
  }

  howToConnect(): string {
    return '📢 Hali kanal ulanmagan. Kanal → Administratorlar → «Admin qo‘shish» → botni tanlang va <b>«Xabar joylash»</b> ruxsatini yoqing — ulanganini o‘zim aytaman.';
  }

  /** Finds the channel the owner means (by title / @username); null + choices when ambiguous. */
  async resolve(query: string | undefined): Promise<{ channel: Channel | null; choices: Channel[] }> {
    const channels = (await this.list()).filter((c) => c.canPost);
    if (channels.length === 1) return { channel: channels[0]!, choices: [] };
    const q = (query ?? '').trim().replace(/^@/, '').toLowerCase();
    if (q) {
      const hit = channels.filter((c) => c.title.toLowerCase().includes(q) || c.username?.toLowerCase() === q);
      if (hit.length === 1) return { channel: hit[0]!, choices: [] };
    }
    return { channel: null, choices: channels };
  }

  /** Writes a draft for the channel (or keeps the owner's exact text) and shows it with the buttons. */
  async draft(channel: Channel, instructions: string, exact: boolean, opts: { webSearch?: boolean } = {}): Promise<ChannelReply> {
    let text = instructions.slice(0, MAX_POST);
    let sources: Array<{ url: string; title?: string }> = [];
    if (!exact) ({ text, sources } = await this.write(channel, instructions, undefined, opts.webSearch === true));
    const post = await this.d.db.channelPost.create({
      data: { channelId: channel.id, instructions: this.d.cipher.encrypt(instructions), text: this.d.cipher.encrypt(text) },
    });
    const reply = this.preview(post.id, channel, text);
    if (sources.length > 0)
      reply.text += `\n\n🔗 <i>Manbalar (postga qo‘shilmaydi):</i>\n${sources
        .slice(0, 3)
        .map((s, i) => `${i + 1}. <a href="${escapeHtml(s.url)}">${escapeHtml((s.title ?? s.url).slice(0, 60))}</a>`)
        .join('\n')}`;
    return reply;
  }

  private async write(
    channel: Channel,
    instructions: string,
    previous?: string,
    webSearch = false,
  ): Promise<{ text: string; sources: Array<{ url: string; title?: string }> }> {
    const routed = await this.d.ai.generateReply({
      system: [
        `You write posts for the Telegram channel "${channel.title}" on behalf of its owner.`,
        'Follow the owner’s instructions exactly. Write an engaging, well-structured post: a strong first line, short paragraphs, a few relevant emojis, an optional call to action.',
        'Plain text only (no markdown symbols like *, _, #). About 400–1200 characters unless the owner asks otherwise. Write in the language of the instructions.',
        'Use only facts you are sure about; with web search, base news on the search results and never invent events, numbers or dates.',
        'Return only the post text.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: previous ? `Current draft:\n${previous}\n\nChange it: ${instructions}` : instructions }],
        },
      ],
      maxOutputTokens: 1200,
      temperature: 0.8,
      timeoutMs: 45_000,
      ...(webSearch ? { webSearch: true } : {}),
    });
    return { text: routed.result.text.trim().slice(0, MAX_POST), sources: routed.result.sources ?? [] };
  }

  private preview(postId: number, channel: Channel, text: string): ChannelReply {
    return {
      text: `📝 <b>Post loyihasi</b> → ${escapeHtml(channelName(channel))}\n\n${escapeHtml(text)}`,
      buttons: [
        [
          { label: '✅ Joylash', data: this.d.button('ok', postId) },
          { label: '✏️ O‘zgartirish', data: this.d.button('ed', postId) },
        ],
        [
          { label: '🔁 Boshqa variant', data: this.d.button('re', postId) },
          { label: '❌ Bekor', data: this.d.button('no', postId) },
        ],
      ],
    };
  }

  private async load(postId: number) {
    return this.d.db.channelPost.findUnique({ where: { id: postId }, include: { channel: true } });
  }

  /** Publishes a draft exactly once (a double click cannot post twice). */
  async publish(postId: number): Promise<ChannelReply> {
    const claimed = await this.d.db.channelPost.updateMany({ where: { id: postId, status: 'DRAFT' }, data: { status: 'PUBLISHED' } });
    if (claimed.count === 0) return { text: 'ℹ️ Bu post allaqachon joylangan yoki bekor qilingan.' };
    const post = await this.load(postId);
    if (!post || !post.channel.active || !post.channel.canPost) {
      await this.d.db.channelPost.updateMany({ where: { id: postId }, data: { status: 'DRAFT' } });
      return { text: '⚠️ Kanal ulanmagan yoki botda «Xabar joylash» ruxsati yo‘q.' };
    }
    // Privileges can change after the channel was connected: the workspace owner must STILL be the
    // channel's creator or an admin allowed to post, otherwise the bot must not post for them.
    if (!(await this.ownerMayPost(post.channel.telegramChatId))) {
      await this.d.db.channelPost.updateMany({ where: { id: postId }, data: { status: 'CANCELLED' } });
      await this.d.db.channel.updateMany({ where: { id: post.channel.id }, data: { active: false, canPost: false } });
      return { text: '⛔ Siz endi bu kanalda post joylash huquqiga ega admin emassiz — kanal ro‘yxatingizdan olib tashlandi.' };
    }
    const text = this.d.cipher.decrypt(post.text) ?? '';
    try {
      const sent = await this.d.api.sendMessage(Number(post.channel.telegramChatId), text, { link_preview_options: { is_disabled: false } });
      await this.d.db.channelPost.update({ where: { id: postId }, data: { publishedMessageId: sent.message_id } });
      const link = post.channel.username ? `\nhttps://t.me/${post.channel.username}/${sent.message_id}` : '';
      return { text: `✅ Joylandi: <b>${escapeHtml(channelName(post.channel))}</b>${escapeHtml(link)}` };
    } catch (error) {
      await this.d.db.channelPost.updateMany({ where: { id: postId }, data: { status: 'DRAFT' } });
      log.warn({ error: describeError(error) }, 'channel post failed');
      return {
        text: `❌ Joylab bo‘lmadi: ${escapeHtml(describeError(error, 200))}`,
        buttons: [[{ label: '🔁 Qayta urinish', data: this.d.button('ok', postId) }]],
      };
    }
  }

  async regenerate(postId: number): Promise<ChannelReply> {
    const post = await this.load(postId);
    if (!post || post.status !== 'DRAFT') return { text: 'ℹ️ Bu post loyihasi eskirgan.' };
    const instructions = this.d.cipher.decrypt(post.instructions) ?? '';
    const { text } = await this.write(post.channel, `${instructions}\n\n(Write a different variant from before.)`);
    await this.d.db.channelPost.update({ where: { id: postId }, data: { text: this.d.cipher.encrypt(text) } });
    return this.preview(postId, post.channel, text);
  }

  async revise(postId: number, change: string): Promise<ChannelReply> {
    const post = await this.load(postId);
    if (!post || post.status !== 'DRAFT') return { text: 'ℹ️ Bu post loyihasi eskirgan.' };
    const { text } = await this.write(post.channel, change, this.d.cipher.decrypt(post.text) ?? '');
    await this.d.db.channelPost.update({ where: { id: postId }, data: { text: this.d.cipher.encrypt(text) } });
    return this.preview(postId, post.channel, text);
  }

  async cancel(postId: number): Promise<ChannelReply> {
    await this.d.db.channelPost.updateMany({ where: { id: postId, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
    return { text: '❌ Post bekor qilindi.' };
  }

  /** The current workspace owner is the channel's creator or an administrator with the post right. */
  private async ownerMayPost(telegramChatId: bigint): Promise<boolean> {
    try {
      const member = await this.d.api.getChatMember(Number(telegramChatId), Number(currentTenant('channel post').ownerTelegramUserId));
      if (member.status === 'creator') return true;
      return member.status === 'administrator' && (member as { can_post_messages?: boolean }).can_post_messages === true;
    } catch (error) {
      log.warn({ error: describeError(error) }, 'could not verify the owner’s channel rights');
      return false;
    }
  }

  /** True when the draft exists and can still be edited (used before asking for changes). */
  async isDraft(postId: number): Promise<boolean> {
    return (await this.d.db.channelPost.count({ where: { id: postId, status: 'DRAFT' } })) > 0;
  }
}
