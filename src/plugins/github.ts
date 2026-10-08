import type { ToolDefinition } from '../ai/types.js';

export const GITHUB_TOOLS: ToolDefinition[] = [
  {
    name: 'add_github_collaborator',
    description: 'Adds a GitHub user as a collaborator to a repository.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name without owner (e.g., tg-auto)' },
        username: { type: 'string', description: 'GitHub username to add' },
        permission: { type: 'string', enum: ['pull', 'push', 'admin', 'maintain', 'triage'], description: 'Permission level (default: push)' }
      },
      required: ['repo', 'username']
    }
  }
];

export async function executeGithubTool(name: string, args: Record<string, unknown>): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return 'Error: GITHUB_TOKEN is not configured.';

  if (name === 'add_github_collaborator') {
    const repo = args.repo as string;
    const username = args.username as string;
    const permission = (args.permission as string) || 'push';
    
    // We assume the token's owner is the repo owner for simplicity, or we can fetch the owner
    try {
      // First get the authenticated user to know the owner
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!userRes.ok) return `Error: GitHub auth failed (${userRes.status})`;
      const user = (await userRes.json()) as { login: string };
      const owner = user.login;

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ permission })
      });
      if (res.status === 201 || res.status === 204) {
        return `Successfully sent an invitation to ${username} for repository ${repo} with ${permission} access.`;
      }
      return `Failed to add collaborator: GitHub API returned status ${res.status}`;
    } catch (e) {
      return `Error executing tool: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
  }
  return `Error: Unknown tool ${name}`;
}
