import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createTask, listTasks, updateTask } from "../core/tasks.js";

/**
 * In-process MCP server letting the agent manage the kanban board: create cards
 * (including subtasks of a parent, for auto-breakdown), list them, and move/edit
 * them. Tools `mcp__tasks__task_{create,list,update}`; board edits are safe, so
 * they're in AUTO_ALLOWED_TOOLS.
 */
export const tasksMcp = createSdkMcpServer({
  name: "tasks",
  version: "1.0.0",
  tools: [
    tool(
      "task_create",
      "Create a kanban card. Pass parentId to make it a subtask when breaking a " +
        "larger task down.",
      {
        title: z.string().describe("Short card title."),
        notes: z.string().optional().describe("Optional details/acceptance criteria."),
        column: z.enum(["backlog", "doing", "done"]).optional().describe("Default backlog."),
        priority: z.enum(["low", "normal", "high"]).optional(),
        parentId: z.string().optional().describe("Parent card id, for a subtask."),
      },
      async (a) => {
        const t = createTask(a);
        return { content: [{ type: "text", text: `Created card "${t.title}" (id ${t.id}).` }] };
      },
    ),
    tool(
      "task_list",
      "List kanban cards, optionally filtered to one column.",
      { column: z.enum(["backlog", "doing", "done"]).optional() },
      async (a) => {
        const tasks = listTasks().filter((t) => !a.column || t.column === a.column);
        const text = tasks.length
          ? tasks.map((t) => `[${t.column}] ${t.id} ${t.title} (${t.priority})`).join("\n")
          : "No cards.";
        return { content: [{ type: "text", text }] };
      },
    ),
    tool(
      "task_update",
      "Update a card's column, priority, title or notes (e.g. move it to done).",
      {
        id: z.string(),
        column: z.enum(["backlog", "doing", "done"]).optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        title: z.string().optional(),
        notes: z.string().optional(),
      },
      async (a) => {
        const t = updateTask(a.id, a);
        return {
          content: [{ type: "text", text: t ? `Updated card ${a.id}.` : `No card with id ${a.id}.` }],
          isError: !t,
        };
      },
    ),
  ],
});
