import { describe, expect, it, vi } from 'vitest';
import { USERBOT_COMMANDS } from '../../src/app/userbot-contract.js';
import { adminCommandMenu, publishAdminCommands } from '../../src/telegram/admin/commands-menu.js';
import { COMMANDS } from '../../src/telegram/admin/dispatch.js';

describe('admin "/" command menu', () => {
  it('lists every admin command (and userbot commands only in userbot mode)', () => {
    const business = adminCommandMenu({ userbot: false }).map((c) => c.command);
    const userbot = adminCommandMenu({ userbot: true }).map((c) => c.command);
    expect([...business].sort()).toEqual([...COMMANDS].sort());
    expect([...userbot].sort()).toEqual([...COMMANDS, ...USERBOT_COMMANDS].sort());
  });

  it('follows Telegram limits (name a-z0-9_ ≤ 32, description 1–256, ≤ 100 commands, no duplicates)', () => {
    const menu = adminCommandMenu({ userbot: true });
    expect(menu.length).toBeLessThanOrEqual(100);
    expect(new Set(menu.map((c) => c.command)).size).toBe(menu.length);
    for (const c of menu) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThanOrEqual(1);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('publishes for the admin chat only and sets the commands menu button', async () => {
    const api = { setMyCommands: vi.fn(async () => true), setChatMenuButton: vi.fn(async () => true) };
    await publishAdminCommands(api as never, 777_000_111n, { userbot: true });
    expect(api.setMyCommands).toHaveBeenCalledWith(expect.arrayContaining([{ command: 'tasks', description: expect.any(String) }]), {
      scope: { type: 'chat', chat_id: 777_000_111 },
    });
    expect(api.setChatMenuButton).toHaveBeenCalledWith({ chat_id: 777_000_111, menu_button: { type: 'commands' } });
  });
});
