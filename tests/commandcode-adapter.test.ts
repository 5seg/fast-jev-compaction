import { describe, expect, it } from 'vitest';
import {
  toCommandCodeMessages,
  toFastJevMessages,
} from '../src/adapters/commandcode.js';
import type { CCMessage } from '../types/commandcode.d.ts';
import type { Message } from '../src/types.js';

describe('commandcode adapter', () => {
  it('converts CCMessage to fast-jev Message and preserves is_error and text', () => {
    const input: CCMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello, please read the file.' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I need to check foo.txt' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Read',
            input: { path: 'foo.txt' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: 'file content here' }],
            is_error: false,
          },
        ],
      },
    ];

    const fastJev = toFastJevMessages(input);
    expect(fastJev).toHaveLength(3);
    expect(fastJev[0]?.role).toBe('user');
    expect(fastJev[0]?.text).toBe('Hello, please read the file.');
    expect(fastJev[1]?.role).toBe('assistant');
    expect(fastJev[1]?.toolUses).toEqual([
      {
        tool_use_id: 'tu_1',
        tool: 'Read',
        input: { path: 'foo.txt' },
      },
    ]);
    expect(fastJev[2]?.toolResults).toEqual([
      {
        tool_use_id: 'tu_1',
        text: 'file content here',
        isError: false,
      },
    ]);
  });

  it('ignores tool calls on meta/summary messages', () => {
    const input: CCMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'meta_tu',
            name: 'Read',
            input: { path: 'summary.txt' },
          },
        ],
        meta: { isSummary: true },
      },
    ];
    const fastJev = toFastJevMessages(input);
    expect(fastJev[0]?.toolUses).toEqual([]);
  });

  it('returns identical references when nothing changed', () => {
    const input: CCMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'unchanged message' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_keep',
            name: 'Read',
            input: { path: 'a.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_keep',
            content: [{ type: 'text', text: 'kept result' }],
          },
        ],
      },
    ];

    const compacted: Message[] = [
      { role: 'user', text: 'unchanged message', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'tu_keep',
            tool: 'Read',
            input: { path: 'a.ts' },
          },
        ],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'tu_keep', text: 'kept result' }],
      },
    ];

    const result = toCommandCodeMessages(input, compacted);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(input[0]);
    expect(result[1]).toBe(input[1]);
    expect(result[2]).toBe(input[2]);
  });

  it('handles drop_call: drops both tool_use and tool_result', () => {
    const input: CCMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Run test' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling test' },
          {
            type: 'tool_use',
            id: 'tu_drop',
            name: 'Bash',
            input: { cmd: 'npm test' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_drop',
            content: [{ type: 'text', text: 'PASS' }],
          },
        ],
      },
    ];

    // compacted has no tu_drop (dropped)
    const compacted: Message[] = [
      { role: 'user', text: 'Run test', toolUses: [] },
      { role: 'assistant', text: 'calling test', toolUses: [] },
    ];

    const result = toCommandCodeMessages(input, compacted);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(input[0]); // untouched
    expect(result[1]?.content).toEqual([{ type: 'text', text: 'calling test' }]);
    // Third message lost its only content (the tool_result) and has no meta/thinking -> dropped
  });

  it('handles drop_result: truncates text while preserving image blocks and other blocks', () => {
    const input: CCMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Read',
            input: { path: 'big.png' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [
              { type: 'text', text: 'original long text here' },
              { type: 'image', source: 'base64data...' },
            ],
          },
        ],
      },
    ];

    const compacted: Message[] = [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'tu_1',
            tool: 'Read',
            input: { path: 'big.png' },
          },
        ],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [
          {
            tool_use_id: 'tu_1',
            text: '[fast-jev-compaction truncated 500 chars...]',
          },
        ],
      },
    ];

    const result = toCommandCodeMessages(input, compacted);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(input[0]); // tool_use untouched

    const resBlock = result[1]?.content[0];
    expect(resBlock?.type).toBe('tool_result');
    if (resBlock && resBlock.type === 'tool_result') {
      expect(resBlock.content).toEqual([
        {
          type: 'text',
          text: '[fast-jev-compaction truncated 500 chars...]',
        },
        { type: 'image', source: 'base64data...' },
      ]);
    }
  });

  it('preserves empty-after-prune message if it contains thinking or meta', () => {
    const input: CCMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Still planning' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Read',
            input: {},
          },
        ],
        meta: { custom: 123 },
      },
    ];

    const compacted: Message[] = [
      { role: 'assistant', text: '', toolUses: [] }, // tu_1 dropped
    ];

    const result = toCommandCodeMessages(input, compacted);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toEqual([
      { type: 'thinking', thinking: 'Still planning' },
    ]);
    expect(result[0]?.meta).toEqual({ custom: 123 });
  });

  it('handles multiple tool calls per message', () => {
    const input: CCMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { p: '1' } },
          { type: 'tool_use', id: 'tu_2', name: 'Read', input: { p: '2' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: 'res1' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: [{ type: 'text', text: 'res2' }],
          },
        ],
      },
    ];

    // Keep tu_1, drop tu_2
    const compacted: Message[] = [
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'tu_1', tool: 'Read', input: { p: '1' } }],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'tu_1', text: 'res1' }],
      },
    ];

    const result = toCommandCodeMessages(input, compacted);
    expect(result[0]?.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { p: '1' } },
    ]);
    expect(result[1]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [{ type: 'text', text: 'res1' }],
      },
    ]);
  });
});
