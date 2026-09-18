export type CCBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string; [key: string]: unknown }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: CCBlock[];
      is_error?: boolean;
    }
  | { type: 'image'; source?: unknown; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface CCMessage {
  role: 'user' | 'assistant' | 'system';
  content: CCBlock[];
  meta?: {
    isMeta?: boolean;
    isSummary?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CCHooks {
  transformContext?: (
    context: { messages: CCMessage[]; state?: unknown; signal?: AbortSignal },
    ctx?: unknown,
  ) => Promise<CCMessage[]> | CCMessage[];
  onTurnEnd?: (
    event: {
      state?: unknown;
      usage?: { inputTokens?: number; outputTokens?: number };
    },
    ctx?: unknown,
  ) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

export interface CCModApi {
  name: string;
  cwd: string;
  ui: {
    notify: (message: string, level?: 'info' | 'warning' | 'error') => void;
    setStatus: (status: string | null) => { dispose: () => void } | void;
    capabilities: { readonly status: boolean };
    [key: string]: unknown;
  };
  hooks: (hooks: CCHooks) => { dispose: () => void } | void;
  addCommand: (cmd: {
    name: string;
    description?: string;
    handler: (
      ctx: unknown,
    ) =>
      | Promise<{ prompt?: string; message?: string } | void>
      | { prompt?: string; message?: string }
      | void;
  }) => { dispose: () => void } | void;
  addFlag: (
    name: string,
    opts: {
      type: 'boolean' | 'string';
      default?: boolean | string;
      description?: string;
    },
  ) => { dispose: () => void } | void;
  getFlag: (name: string) => boolean | string | undefined;
  on: (
    event: string,
    handler: (data: unknown) => void,
  ) => { dispose: () => void } | void;
  addRenderer?: (...args: unknown[]) => unknown;
  showEntry?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}
