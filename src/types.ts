export type Role = 'user' | 'assistant';

export type Msg = {
  role: Role;
  content: string;
};

/**
 * Per-group agent configuration. Controls what tools, MCP servers,
 * plugins, and system prompt the agent gets.
 */
export type AgentConfig = {
  /** Tool names the agent is allowed to use (e.g. ["Read","Bash","mcp__*"]) */
  allowedTools: string[];
  /** Tool names explicitly blocked (e.g. ["mcp__ted__mcp_add"]) — takes precedence over allowedTools */
  disallowedTools?: string[];
  /** Whether to include the REPO and LOCAL plugin/skill directories */
  includePlugins: boolean;
  /** Whether to load user-configured MCP servers from the DB */
  includeUserMcpServers: boolean;
  /** Extra MCP servers injected for this group (keyed by name) */
  extraMcpServers?: Record<string, { type?: string; url?: string; command?: string; args?: string[] }>;
  /** Optional system prompt override (appended after default system parts) */
  systemPromptSuffix?: string;
  /** Model override for this group */
  model?: string;
  /** Permission mode override */
  permissionMode?: string;
};

export type StreamReq = {
  sessionId: string;
  history: Msg[];
  userId: string;
  systemPrompt?: string;
  sdkSessionId?: string;
  agentConfig?: AgentConfig;
};
