import { afterEach, describe, expect, it, vi } from 'vitest';
import { TenantLimiter } from '../../src/ai/router/global-limiter.js';
import { executeGithubTool } from '../../src/plugins/github.js';

describe('per-workspace AI limiter', () => {
  it('one busy workspace cannot use up another workspace’s requests-per-minute', () => {
    let tenant = 1;
    const limiter = new TenantLimiter(() => tenant, () => 1_000);
    expect(limiter.tryAcquire(2)).toBe(true);
    expect(limiter.tryAcquire(2)).toBe(true);
    expect(limiter.tryAcquire(2)).toBe(false);
    tenant = 2;
    expect(limiter.tryAcquire(2)).toBe(true);
    expect(limiter.inWindow()).toBe(1);
  });
});

describe('GitHub tool arguments', () => {
  const saved = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
    vi.unstubAllGlobals();
  });

  it('rejects path-like or invalid names before calling GitHub', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await executeGithubTool('add_github_collaborator', { repo: '../../orgs/x', username: 'a' })).toContain('invalid repository');
    expect(await executeGithubTool('add_github_collaborator', { repo: 'tg-auto', username: 'a/b' })).toContain('invalid GitHub username');
    expect(await executeGithubTool('add_github_collaborator', { repo: 'tg-auto', username: 'ali', permission: 'owner' })).toContain('invalid permission');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
