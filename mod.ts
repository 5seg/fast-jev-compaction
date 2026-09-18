import { toCommandCodeMessages, toFastJevMessages } from './src/adapters/commandcode.js';
import { JevClient } from './src/client.js';
import { compact, reductionRatio } from './src/compact.js';
import { SYSTEM_ONE_URL } from './src/request.js';
import { collectToolCalls } from './src/state.js';
import type { CompactResult } from './src/types.js';
import type { CCMessage, CCModApi } from './types/commandcode.d.ts';

function parseNum(val: unknown, fallback: number): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function parseStr(val: unknown, fallback: string): string {
  if (typeof val === 'string' && val.length > 0) return val;
  return fallback;
}

function computeSignature(messages: readonly CCMessage[]): string {
  const len = messages.length;
  if (len === 0) return '0::0';
  const last = messages[len - 1];
  let lastChars = 0;
  for (const b of last?.content ?? []) {
    if ('text' in b && typeof b.text === 'string') lastChars += b.text.length;
    else if ('thinking' in b && typeof b.thinking === 'string') {
      lastChars += b.thinking.length;
    }
  }
  let totalChars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if ('text' in b && typeof b.text === 'string') totalChars += b.text.length;
      else if ('content' in b && Array.isArray(b.content)) {
        for (const sub of b.content) {
          if ('text' in sub && typeof sub.text === 'string') {
            totalChars += sub.text.length;
          }
        }
      }
    }
  }
  return `${len}:${last?.role ?? ''}_${lastChars}:${totalChars}`;
}

function estimateTotalTokens(messages: readonly CCMessage[]): number {
  let totalChars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if ('text' in b && typeof b.text === 'string') totalChars += b.text.length;
      else if ('content' in b && Array.isArray(b.content)) {
        for (const sub of b.content) {
          if ('text' in sub && typeof sub.text === 'string') {
            totalChars += sub.text.length;
          }
        }
      }
    }
  }
  return Math.ceil(totalChars / 3.5);
}

export default function (cmd: CCModApi): void {
  // Register flags
  cmd.addFlag('apiKey', {
    type: 'string',
    default: '',
    description: 'TypeSafe API key (defaults to TYPESAFE_API_KEY env)',
  });
  cmd.addFlag('model', {
    type: 'string',
    default: 'jev-latest',
    description: 'Jev model name',
  });
  cmd.addFlag('baseUrl', {
    type: 'string',
    default: '',
    description: 'Custom TypeSafe API endpoint (defaults to System One URL)',
  });
  cmd.addFlag('contextTokens', {
    type: 'string',
    default: '200000',
    description: 'Model context window limit in tokens',
  });
  cmd.addFlag('compactAtPercent', {
    type: 'string',
    default: '45',
    description: 'Trigger compaction when context % exceeds this threshold',
  });
  cmd.addFlag('keepThreshold', {
    type: 'string',
    default: '0.5',
    description: 'Probability threshold to keep call or result (0..1)',
  });
  cmd.addFlag('preserveRecentMessages', {
    type: 'string',
    default: '6',
    description: 'Number of recent messages pinned from compaction',
  });
  cmd.addFlag('maxStateTokens', {
    type: 'string',
    default: '25000',
    description: 'Max estimated tokens for the compaction state',
  });
  cmd.addFlag('maxRequestTokens', {
    type: 'string',
    default: '30000',
    description: 'Max estimated tokens per Jev request batch',
  });
  cmd.addFlag('truncateHeadChars', {
    type: 'string',
    default: '300',
    description: 'Characters to retain when tool result is dropped',
  });

  const getApiKey = () =>
    parseStr(cmd.getFlag('apiKey'), process.env.TYPESAFE_API_KEY ?? '');
  const getModel = () => parseStr(cmd.getFlag('model'), 'jev-latest');
  const getBaseUrl = () => parseStr(cmd.getFlag('baseUrl'), '');
  const getContextTokens = () => parseNum(cmd.getFlag('contextTokens'), 200_000);
  const getCompactAtPercent = () => parseNum(cmd.getFlag('compactAtPercent'), 45);
  const getKeepThreshold = () => parseNum(cmd.getFlag('keepThreshold'), 0.5);
  const getPreserveRecent = () =>
    parseNum(cmd.getFlag('preserveRecentMessages'), 6);
  const getMaxStateTokens = () => parseNum(cmd.getFlag('maxStateTokens'), 25_000);
  const getMaxRequestTokens = () =>
    parseNum(cmd.getFlag('maxRequestTokens'), 30_000);
  const getTruncateHeadChars = () =>
    parseNum(cmd.getFlag('truncateHeadChars'), 300);

  // Mod closure state
  let lastTurnTokens = 0;
  let warnedSummary = false;
  let lastSignature = '';
  let lastSuccessOutput: CCMessage[] | null = null;
  let lastFailedSignature = '';
  let lastError: string | null = null;
  let lastStats: CompactResult['stats'] | null = null;

  // Hooks registration
  cmd.hooks({
    onTurnEnd: (event) => {
      const usage = event?.usage;
      if (usage) {
        const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (total > 0) {
          lastTurnTokens = total;
        }
      }
    },
    transformContext: async ({ messages }) => {
      // 1. Check if built-in compaction already summarized
      if (messages.some((m) => m.meta?.isSummary)) {
        if (!warnedSummary) {
          warnedSummary = true;
          cmd.ui.notify(
            'fast-jev-compaction: detected built-in summary; backing off',
            'info',
          );
        }
        return messages;
      }

      const signature = computeSignature(messages);

      // 2. Signature unchanged since last successful run -> reuse cached output
      if (signature === lastSignature && lastSuccessOutput) {
        return lastSuccessOutput;
      }

      // 3. Last run failed and signature unchanged -> do not retry immediately
      if (signature === lastFailedSignature) {
        return messages;
      }

      // 4. Token threshold check
      const currentTokens =
        lastTurnTokens > 0 ? lastTurnTokens : estimateTotalTokens(messages);
      const contextLimit = getContextTokens();
      const triggerPercent = getCompactAtPercent();
      const thresholdTokens = (contextLimit * triggerPercent) / 100;

      if (currentTokens < thresholdTokens) {
        return messages;
      }

      // 5. Candidate tool calls check
      const fastJevMsgs = toFastJevMessages(messages);
      const preserveRecent = getPreserveRecent();
      const calls = collectToolCalls(fastJevMsgs, preserveRecent);
      const candidates = calls.filter((c) => !c.pinned);
      if (candidates.length === 0) {
        return messages;
      }

      // 6. Check API key presence
      const apiKey = getApiKey();
      if (!apiKey) {
        const missingKeyMsg = 'TYPESAFE_API_KEY is not configured';
        lastError = missingKeyMsg;
        lastFailedSignature = signature;
        cmd.ui.notify(`fast-jev-compaction: ${missingKeyMsg}`, 'warning');
        return messages;
      }

      // 7. Run compaction with TypeSafe JevClient
      try {
        const baseUrl = getBaseUrl();
        const client = new JevClient({
          apiKey,
          model: getModel(),
          baseUrl: baseUrl || undefined,
        });

        const result = await compact(fastJevMsgs, client, {
          keepThreshold: getKeepThreshold(),
          preserveRecentMessages: preserveRecent,
          maxStateTokens: getMaxStateTokens(),
          maxRequestTokens: getMaxRequestTokens(),
          truncateHeadChars: getTruncateHeadChars(),
        });

        const compactedCC = toCommandCodeMessages(messages, result.messages);

        lastSuccessOutput = compactedCC;
        lastSignature = signature;
        lastFailedSignature = '';
        lastError = null;
        lastStats = result.stats;

        const ratio = Math.round(reductionRatio(result) * 100);
        cmd.ui.setStatus(
          `⚡ Jev: ${ratio}% saved (${result.stats.kept} kept, ${result.stats.resultsDropped} trunc, ${result.stats.callsDropped} drop) [${result.stats.ms}ms]`,
        );

        if (result.stats.resultsDropped > 0 || result.stats.callsDropped > 0) {
          cmd.ui.notify(
            `fast-jev-compaction: ${ratio}% reduction (${result.stats.resultsDropped} truncated, ${result.stats.callsDropped} dropped)`,
            'info',
          );
        }

        return compactedCC;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = errMsg;
        lastFailedSignature = signature;
        cmd.ui.notify(`fast-jev-compaction: ${errMsg}`, 'warning');
        return messages;
      }
    },
  });

  // Register /jev-status reporting command
  cmd.addCommand({
    name: 'jev-status',
    description: 'Show fast-jev-compaction status and last run stats',
    handler: () => {
      const currentTokens = lastTurnTokens;
      const contextLimit = getContextTokens();
      const pct =
        contextLimit > 0 ? Math.round((currentTokens / contextLimit) * 100) : 0;
      const endpoint = getBaseUrl() || SYSTEM_ONE_URL;
      const keyConfigured = Boolean(getApiKey());

      const lines = [
        '⚡ **fast-jev-compaction Status**',
        `• Model: ${getModel()}`,
        `• Endpoint: ${endpoint}`,
        `• API Key: ${keyConfigured ? 'Configured' : 'Missing (TYPESAFE_API_KEY not set)'}`,
        `• Context Tokens: ${currentTokens || 'N/A'} / ${contextLimit} (${pct}%, trigger at ${getCompactAtPercent()}%)`,
        `• Last Signature: ${lastSignature || '(none)'}`,
      ];
      if (lastStats) {
        const ratio = Math.round(
          lastStats.charsBefore > 0
            ? ((lastStats.charsBefore - lastStats.charsAfter) /
                lastStats.charsBefore) *
                100
            : 0,
        );
        lines.push(
          `• Last run: ${ratio}% saved, ${lastStats.messagesBefore} → ${lastStats.messagesAfter} messages (${lastStats.ms}ms)`,
          `• Calls: ${lastStats.calls} total (${lastStats.kept} kept, ${lastStats.resultsDropped} truncated, ${lastStats.callsDropped} dropped, ${lastStats.pinned} pinned)`,
          `• State stage: ${lastStats.stateStage || 'full'} (~${lastStats.stateTokens} tokens in ${lastStats.requests} req)`,
        );
      }
      if (lastError) {
        lines.push(`• Last error: ${lastError}`);
      }
      return { message: lines.join('\n') };
    },
  });
}
