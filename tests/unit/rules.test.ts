import { describe, expect, it } from 'vitest';
import { decideRule, findMatchingRule, type RuleRecord, type SenderFacts } from '../../src/rules/rules.engine.js';
import { normalizeRuleValue, RuleValidationError } from '../../src/rules/rules.service.js';

const sender = (over: Partial<SenderFacts> = {}): SenderFacts => ({
  telegramUserId: 1001n,
  username: 'Ali_Dev',
  chatId: 1001n,
  tags: [],
  isNewChat: false,
  ...over,
});
const custom = { replyMode: 'CUSTOM' as const, unknownUserMode: 'AUTO' as const };

describe('rules engine', () => {
  it('unknown users follow unknownUserMode in CUSTOM mode', () => {
    expect(decideRule(custom, [], sender()).action).toBe('AUTO');
    expect(decideRule({ ...custom, unknownUserMode: 'MANUAL' }, [], sender()).action).toBe('MANUAL');
    expect(decideRule({ ...custom, unknownUserMode: 'IGNORE' }, [], sender()).action).toBe('IGNORE');
  });

  it('blocklist always wins, even in ALL_ALLOWED', () => {
    const rules: RuleRecord[] = [{ matchType: 'USER_ID', matchValue: '1001', mode: 'BLOCK' }];
    expect(decideRule({ ...custom, replyMode: 'ALL_ALLOWED' }, rules, sender()).action).toBe('BLOCK');
  });

  it('user id rule beats username and tag rules', () => {
    const rules: RuleRecord[] = [
      { matchType: 'TAG', matchValue: 'friends', mode: 'MANUAL' },
      { matchType: 'USERNAME', matchValue: 'ali_dev', mode: 'IGNORE' },
      { matchType: 'USER_ID', matchValue: '1001', mode: 'AUTO' },
    ];
    expect(findMatchingRule(rules, sender({ tags: ['friends'] }))?.matchType).toBe('USER_ID');
    expect(decideRule(custom, rules, sender({ tags: ['friends'] })).action).toBe('AUTO');
  });

  it('username matching is case-insensitive and ignores @', () => {
    const rules: RuleRecord[] = [{ matchType: 'USERNAME', matchValue: 'ali_dev', mode: 'VIP' }];
    expect(decideRule(custom, rules, sender({ username: '@ALI_DEV' })).action).toBe('VIP');
  });

  it('tag rules: friends/family → MANUAL, most restrictive tag wins', () => {
    const rules: RuleRecord[] = [
      { matchType: 'TAG', matchValue: 'friends', mode: 'MANUAL' },
      { matchType: 'TAG', matchValue: 'spammy', mode: 'IGNORE' },
    ];
    expect(decideRule(custom, rules, sender({ tags: ['Friends'] })).action).toBe('MANUAL');
    expect(decideRule(custom, rules, sender({ tags: ['friends', 'spammy'] })).action).toBe('IGNORE');
  });

  it('ALLOWLIST_ONLY answers only explicit AUTO rules', () => {
    const mode = { ...custom, replyMode: 'ALLOWLIST_ONLY' as const };
    expect(decideRule(mode, [], sender()).action).toBe('MANUAL');
    expect(decideRule(mode, [{ matchType: 'USER_ID', matchValue: '1001', mode: 'AUTO' }], sender()).action).toBe('AUTO');
  });

  it('NEW_CHATS_ONLY answers only chats where the owner never wrote', () => {
    const mode = { ...custom, replyMode: 'NEW_CHATS_ONLY' as const };
    expect(decideRule(mode, [], sender({ isNewChat: true })).action).toBe('AUTO');
    expect(decideRule(mode, [], sender({ isNewChat: false })).action).toBe('MANUAL');
  });

  it('NON_CONTACTS_ONLY treats users tagged "contact" as contacts', () => {
    const mode = { ...custom, replyMode: 'NON_CONTACTS_ONLY' as const };
    expect(decideRule(mode, [], sender()).action).toBe('AUTO');
    expect(decideRule(mode, [], sender({ tags: ['contact'] })).action).toBe('MANUAL');
  });

  it('chat id rules work', () => {
    const rules: RuleRecord[] = [{ matchType: 'CHAT_ID', matchValue: '1001', mode: 'IGNORE' }];
    expect(decideRule(custom, rules, sender()).action).toBe('IGNORE');
  });
});

describe('rule value normalization', () => {
  it('normalizes ids, usernames and tags', () => {
    expect(normalizeRuleValue('USER_ID', ' 0012345 ')).toBe('12345');
    expect(normalizeRuleValue('USERNAME', '@Some_User')).toBe('some_user');
    expect(normalizeRuleValue('TAG', '#Family')).toBe('family');
  });
  it('rejects invalid values', () => {
    expect(() => normalizeRuleValue('USER_ID', 'abc')).toThrow(RuleValidationError);
    expect(() => normalizeRuleValue('USERNAME', '@a')).toThrow(RuleValidationError);
    expect(() => normalizeRuleValue('TAG', 'bad tag!')).toThrow(RuleValidationError);
  });
});
