import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { memory, formatMemories } from "../core/memory.js";

/**
 * In-process MCP server giving the agent a durable memory: write facts worth
 * remembering, search them, and list them. Backs the same store the panel
 * Memory view edits and that `runner.ts` injects into each turn. Tools are
 * addressable as `mcp__memory__memory_{write,search,list}` and are read/write
 * but safe, so they're in AUTO_ALLOWED_TOOLS — recall/store stays frictionless.
 */
export const memoryMcp = createSdkMcpServer({
  name: "memory",
  version: "1.0.0",
  tools: [
    tool(
      "memory_write",
      "Save a durable fact worth remembering across future conversations " +
        "(a preference, a project detail, a decision, how the user likes things). " +
        "Keep each fact short and self-contained. Returns the stored entry id.",
      {
        text: z.string().describe("The fact to remember, as one concise sentence."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional short tags for grouping/recall, e.g. ['deploy','preferences']."),
        salience: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Importance 0..1 (default 0.5). Use higher for durable preferences."),
      },
      async (args) => {
        const e = memory.create({ text: args.text, tags: args.tags, salience: args.salience });
        return { content: [{ type: "text", text: `Remembered (id ${e.id}).` }] };
      },
    ),
    tool(
      "memory_search",
      "Search your saved memories by keyword. Use this when a request might " +
        "relate to something you were told before.",
      {
        query: z.string().describe("Keywords to search for."),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)."),
      },
      async (args) => {
        const hits = memory.search(args.query, args.limit ?? 10);
        const text = hits.length ? formatMemories(hits) : "No matching memories.";
        return { content: [{ type: "text", text }] };
      },
    ),
    tool(
      "memory_list",
      "List your most salient saved memories.",
      {
        limit: z.number().int().min(1).max(50).optional().describe("Max entries (default 20)."),
      },
      async (args) => {
        const all = memory.list().slice(0, args.limit ?? 20);
        const text = all.length ? formatMemories(all) : "No memories saved yet.";
        return { content: [{ type: "text", text }] };
      },
    ),
  ],
});
