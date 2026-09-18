import type { CCBlock, CCMessage } from '../../types/commandcode.d.ts';
import type { Message, ToolResult, ToolUse } from '../types.js';

function extractText(content: CCBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * Converts Command Code messages into the fast-jev Message format.
 * `thinking` and `image` blocks are omitted from candidates (they remain untouched in original).
 * Messages flagged as `isMeta` or `isSummary` are never candidates.
 */
export function toFastJevMessages(messages: readonly CCMessage[]): Message[] {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const isSpecialMeta = Boolean(m.meta?.isMeta || m.meta?.isSummary);

    const textParts: string[] = [];
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];

    for (const block of m.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (
        !isSpecialMeta &&
        block.type === 'tool_use' &&
        'id' in block &&
        typeof block.id === 'string'
      ) {
        toolUses.push({
          tool_use_id: block.id,
          tool:
            'name' in block && typeof block.name === 'string'
              ? block.name
              : 'tool',
          input:
            'input' in block &&
            typeof block.input === 'object' &&
            block.input !== null
              ? (block.input as Record<string, unknown>)
              : {},
        });
      } else if (
        !isSpecialMeta &&
        block.type === 'tool_result' &&
        'tool_use_id' in block &&
        typeof block.tool_use_id === 'string'
      ) {
        const rawContent = Array.isArray(block.content) ? block.content : [];
        toolResults.push({
          tool_use_id: block.tool_use_id,
          text: extractText(rawContent),
          isError: 'is_error' in block ? Boolean(block.is_error) : false,
        });
      }
    }

    const msg: Message = {
      role,
      text: textParts.join('\n'),
      toolUses,
    };
    if (toolResults.length > 0) {
      msg.toolResults = toolResults;
    }
    return msg;
  });
}

/**
 * Re-applies fast-jev compaction decisions back onto the original Command Code messages.
 * Preserves message object identities when unchanged, leaves thinking/image/meta intact,
 * drops tool_use and tool_result pairs for drop_call, and replaces only text blocks for drop_result.
 */
export function toCommandCodeMessages(
  original: readonly CCMessage[],
  compacted: readonly Message[],
): CCMessage[] {
  // 1. Collect surviving tool_use_ids and their result texts in compacted
  const compactedUseIds = new Set<string>();
  const compactedResultTexts = new Map<string, string>();

  for (const m of compacted) {
    for (const tu of m.toolUses) {
      compactedUseIds.add(tu.tool_use_id);
    }
    for (const tr of m.toolResults ?? []) {
      compactedUseIds.add(tr.tool_use_id);
      compactedResultTexts.set(tr.tool_use_id, tr.text);
    }
  }

  // 2. Track original tool_result texts to detect drop_result modifications
  const originalResultTexts = new Map<string, string>();
  for (const m of original) {
    for (const b of m.content) {
      if (
        b.type === 'tool_result' &&
        'tool_use_id' in b &&
        typeof b.tool_use_id === 'string'
      ) {
        const rawContent = Array.isArray(b.content) ? b.content : [];
        originalResultTexts.set(b.tool_use_id, extractText(rawContent));
      }
    }
  }

  const out: CCMessage[] = [];

  for (const orig of original) {
    let touched = false;
    const newContent: CCBlock[] = [];

    for (const block of orig.content) {
      if (
        block.type === 'tool_use' &&
        'id' in block &&
        typeof block.id === 'string'
      ) {
        if (!compactedUseIds.has(block.id)) {
          // Tool call dropped
          touched = true;
          continue;
        }
        newContent.push(block);
      } else if (
        block.type === 'tool_result' &&
        'tool_use_id' in block &&
        typeof block.tool_use_id === 'string'
      ) {
        const id = block.tool_use_id;
        if (!compactedUseIds.has(id)) {
          // Tool result dropped along with tool call
          touched = true;
          continue;
        }

        const newText = compactedResultTexts.get(id);
        const origText = originalResultTexts.get(id);
        if (
          newText !== undefined &&
          origText !== undefined &&
          newText !== origText
        ) {
          // Tool result truncated (drop_result)
          touched = true;
          const rawContent = Array.isArray(block.content) ? block.content : [];
          const preservedNonText = rawContent.filter((b) => b.type !== 'text');
          const updatedContent: CCBlock[] = [
            { type: 'text', text: newText },
            ...preservedNonText,
          ];
          newContent.push({
            ...block,
            content: updatedContent,
          });
        } else {
          newContent.push(block);
        }
      } else {
        newContent.push(block);
      }
    }

    if (!touched) {
      // If untouched, preserve exact object reference
      out.push(orig);
      continue;
    }

    // If content becomes empty, drop the message ONLY if it had no thinking/image/meta
    if (newContent.length === 0) {
      const hasPreservedBlock = orig.content.some(
        (b) => b.type === 'thinking' || b.type === 'image',
      );
      const hasMeta = Boolean(
        orig.meta &&
          (orig.meta.isMeta ||
            orig.meta.isSummary ||
            Object.keys(orig.meta).length > 0),
      );
      if (!hasPreservedBlock && !hasMeta) {
        continue;
      }
    }

    out.push({
      ...orig,
      content: newContent,
    });
  }

  return out;
}
