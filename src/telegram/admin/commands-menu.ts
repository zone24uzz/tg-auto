import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';
import { USERBOT_COMMANDS, type UserbotCommand } from '../../app/userbot-contract.js';
import type { COMMANDS } from './dispatch.js';

type AdminCommand = (typeof COMMANDS)[number];

/**
 * Descriptions shown in Telegram's "/" menu. Typed as Record over the command lists, so a new
 * command cannot be added without a menu entry (the build fails instead of the menu going stale).
 */
const ADMIN_MENU: Record<AdminCommand, string> = {
  menu: 'Asosiy menyu',
  tasks: 'Shaxsiy assistent vazifalari',
  status: 'Qisqa holat',
  pause: 'Avtojavobni vaqtincha to‘xtatish (/pause 30)',
  resume: 'Avtojavobni davom ettirish',
  privacy: 'Maxfiylik va ma’lumotlar',
  help: 'Yordam',
  cancel: 'Kutilayotgan kiritishni bekor qilish',
  start: 'Botni ishga tushirish',
};

const USERBOT_MENU: Record<UserbotCommand, string> = {
  userbot: 'Userbot holati',
  login: 'Akkauntni ulash (QR kod)',
  cancel_login: 'Ulanishni bekor qilish',
  logout: 'Akkauntdan chiqish',
};

/** The owner's "/" menu (userbot commands only when that transport is used). */
export function adminCommandMenu(opts: { userbot: boolean }): BotCommand[] {
  const menu: BotCommand[] = (Object.keys(ADMIN_MENU) as AdminCommand[]).map((command) => ({ command, description: ADMIN_MENU[command] }));
  if (opts.userbot) for (const command of USERBOT_COMMANDS) menu.push({ command, description: USERBOT_MENU[command] });
  return menu;
}

/**
 * Publishes the menu for the owner's private chat only (other users never see admin commands) and
 * makes the chat's menu button open it. Runs at every startup, so the menu always matches the code.
 */
export async function publishAdminCommands(
  api: Pick<Api, 'setMyCommands' | 'setChatMenuButton'>,
  adminTelegramUserId: bigint,
  opts: { userbot: boolean },
): Promise<void> {
  const chatId = Number(adminTelegramUserId);
  await api.setMyCommands(adminCommandMenu(opts), { scope: { type: 'chat', chat_id: chatId } });
  await api.setChatMenuButton({ chat_id: chatId, menu_button: { type: 'commands' } });
}
