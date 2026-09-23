// Turns the worker's raw stream-json Claude output into readable lines for
// the dashboard. Unknown/unparseable lines pass through untouched.

type ClaudeEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
};

const summarizeInput = (input: Record<string, unknown> | undefined) => {
  if (!input) return '';
  const interesting =
    input.file_path ?? input.path ?? input.pattern ?? input.query ?? '';
  return typeof interesting === 'string' ? interesting : JSON.stringify(interesting);
};

export const formatClaudeLogs = (raw: string) => {
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      if (trimmed) lines.push(trimmed);
      continue;
    }
    let event: ClaudeEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      lines.push(trimmed);
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      lines.push('▸ claude session started');
    } else if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          lines.push(block.text.trim());
        } else if (block.type === 'tool_use') {
          lines.push(`→ ${block.name}(${summarizeInput(block.input)})`);
        }
      }
    } else if (event.type === 'result') {
      lines.push(`▸ result: ${event.result ?? event.subtype ?? ''}`);
    }
    // user (tool results) and other event types are noise — skipped
  }
  return lines.join('\n');
};
