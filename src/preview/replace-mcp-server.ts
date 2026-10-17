import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { describeReplace, REPLACE_TOOL_DESCRIPTION, replaceInFiles } from './replace-in-files';

/**
 * Stdio MCP server exposing `replace_in_files` to the Gemini CLI (Claude gets
 * the same tool in-process via createSdkMcpServer). Registered once in the
 * isolated Gemini settings (gemini-setup.ts); the CLI spawns it per run with
 * the session clone as cwd, which is the only thing it reads — so a server
 * started outside a clone refuses rather than editing the wrong tree.
 *
 * Run with: tsx src/preview/replace-mcp-server.ts
 */
export const replaceToolInput = {
  find: z.string().describe('Exact text to find (case-sensitive, not a regex). At least 3 characters.'),
  replace: z.string().describe('Replacement text.'),
  include: z
    .array(z.string())
    .optional()
    .describe('Optional path fragments; only files whose path contains one are touched, e.g. ["src/components"].'),
};

const main = async () => {
  const dir = process.cwd();
  const server = new McpServer({ name: 'pilot', version: '1.0.0' });
  server.registerTool(
    'replace_in_files',
    { description: REPLACE_TOOL_DESCRIPTION, inputSchema: replaceToolInput },
    async ({ find, replace, include }) => {
      const result = replaceInFiles({ dir, find, replace, include });
      return {
        content: [{ type: 'text', text: describeReplace(result) }],
        isError: !result.ok,
      };
    }
  );
  await server.connect(new StdioServerTransport());
};

// Only start the server when executed directly (tests import the schema).
if (process.argv[1] && /replace-mcp-server\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`replace-mcp-server: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
