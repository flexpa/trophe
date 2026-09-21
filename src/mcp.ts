import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createActions } from "./actions.js";
import { openStore, recordSchemas } from "./store.js";

/** Creates a local MCP server with the same contracts and actions as the CLI. */
export function createServer(directory: string): McpServer {
  const actions = createActions(openStore(directory));
  const server = new McpServer({ name: "trophe", version: "0.1.0" });
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: actions.map(action => ({
      name: action.name,
      description: action.description,
      inputSchema: z.toJSONSchema(action.schema, { io: "input" }),
      annotations: {
        readOnlyHint: action.readOnly,
        destructiveHint: ["put_food", "update_meal", "set_profile"].includes(action.name),
        idempotentHint: true,
        openWorldHint: false,
      },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const action = actions.find(candidate => candidate.name === request.params.name);
      if (!action) throw new Error(`Unknown tool: ${request.params.name}`);
      const result = action.run(request.params.arguments ?? {});
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  for (const [name, file] of [
    ["guide", "../SKILL.md"], ["schema-guide", "../SCHEMA.md"], ["fhir-guide", "../FHIR.md"],
  ] as const) {
    server.registerResource(name, `trophe://${name}`, { mimeType: "text/markdown" }, uri => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFileSync(new URL(file, import.meta.url), "utf8") }],
    }));
  }
  server.registerResource("schemas", "trophe://schemas", { mimeType: "application/json" }, uri => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(
      Object.fromEntries(Object.entries(recordSchemas).map(([kind, schema]) => [kind, z.toJSONSchema(schema)])),
    ) }],
  }));
  return server;
}

/** Serves MCP over standard input/output; no network listener is opened. */
export async function serve(directory: string): Promise<void> {
  await createServer(directory).connect(new StdioServerTransport());
}
