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
        "Keep it to ONE terse sentence (aim under ~150 chars) that captures the " +
        "meaning, not a paragraph or changelog. Returns the stored entry id.",
      {
        text: z
          .string()
          .max(500, "Memory text must be 500 characters or fewer — keep it to one terse sentence.")
          .describe(
            "The fact, as one short sentence. Drop filler, long file lists, and " +
              "play-by-play detail; record bulky detail in a commit or file, not here.",
          ),
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
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe(
            "Recall tier. warm (default) = recalled only when relevant; use for most " +
              "facts incl. records of work done. hot = injected into EVERY turn (costs " +
              "context permanently), reserve for a few always-relevant facts. cold = " +
              "archival, panel-only. When in doubt use warm, not hot.",
          ),
      },
      async (args) => {
        const TIMEOUT_MS = 5_000;
        const timer = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("memory_write timed out after 5s")), TIMEOUT_MS),
        );
        return Promise.race([
          (async () => {
            const e = memory.create({ text: args.text, tags: args.tags, salience: args.salience, tier: args.tier });
            return { content: [{ type: "text", text: `Remembered (id ${e.id}).` }] };
          })(),
          timer,
        ]);
      },
    ),
    tool(
      "memory_search",
      "Search your saved memories by meaning and keyword. Use this when a request " +
        "might relate to something you were told before — it matches related " +
        "concepts, not just exact words.",
      {
        query: z.string().describe("What to search for — a phrase or keywords."),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)."),
      },
      async (args) => {
        const hits = await memory.semanticSearch(args.query, args.limit ?? 10);
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
