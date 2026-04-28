import { readFileSync } from 'node:fs';
import type { AgentConfig } from './types.js';

/**
 * A nick group maps a set of IRC nicks to a specific agent configuration,
 * userId, and sessionId. This lets different users (admin vs public) get
 * different agent capabilities.
 */
export type NickGroup = {
  /** Human-readable group name (e.g. "admin", "public") */
  name: string;
  /**
   * Nicks belonging to this group (lowercased). Use ["*"] as a wildcard
   * catch-all for any nick not matched by an earlier group.
   */
  nicks: string[];
  /** The userId this group's messages are posted under */
  userId: string;
  /** The sessionId this group's messages land in */
  sessionId: string;
  /** Whether messages must mention the bot nick */
  requireMention: boolean;
  /** Agent configuration for this group */
  agentConfig: AgentConfig;
};

export type NickGroupsConfig = {
  groups: NickGroup[];
};

/**
 * Default admin config — matches the current hardcoded behavior in
 * activities.ts. Used when no nick-groups config is provided.
 */
export const DEFAULT_ADMIN_CONFIG: AgentConfig = {
  allowedTools: [
    'Read', 'Write', 'Edit',
    'Glob', 'Grep',
    'Bash',
    'WebSearch', 'WebFetch',
    'Skill', 'Agent',
    'TodoWrite',
    'NotebookEdit',
    'mcp__*',
  ],
  includePlugins: true,
  includeUserMcpServers: true,
};

let _config: NickGroupsConfig | null = null;

/**
 * Load nick groups from the config file. Returns null if the file
 * doesn't exist (falls back to legacy IRC_ALLOWED_NICKS behavior).
 */
export function loadNickGroups(path?: string): NickGroupsConfig | null {
  const configPath = path ?? process.env.NICK_GROUPS_CONFIG ?? '/etc/sleet1213/nick-groups.json';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as NickGroupsConfig;
    // Normalise nicks to lowercase
    for (const g of parsed.groups) {
      g.nicks = g.nicks.map((n) => n.toLowerCase());
    }
    _config = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve an IRC nick to its group. Returns the first group whose nicks
 * list contains the nick (case-insensitive), or the first group with a
 * "*" wildcard. Returns null if no group matches.
 */
export function resolveNickGroup(nick: string, config?: NickGroupsConfig): NickGroup | null {
  const cfg = config ?? _config;
  if (!cfg) return null;
  const lc = nick.toLowerCase();
  // First pass: exact match
  for (const g of cfg.groups) {
    if (g.nicks.includes(lc)) return g;
  }
  // Second pass: wildcard
  for (const g of cfg.groups) {
    if (g.nicks.includes('*')) return g;
  }
  return null;
}

/**
 * Check if a nick is allowed by any group in the config.
 */
export function isNickAllowed(nick: string, config?: NickGroupsConfig): boolean {
  return resolveNickGroup(nick, config) !== null;
}
