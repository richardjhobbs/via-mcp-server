import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const server = new McpServer({
  name: "via-agent-demo",
  version: "0.1.0",
});

server.tool(
  "register_merchant",
  "Register a merchant in VIA network",
  z.object({
    name: z.string(),
    category: z.string(),
    country: z.string(),
  }),
  async ({ name, category, country }) => {
    const { error } = await supabase
      .from("merchants")
      .insert({ name, category, country });

    if (error) throw error;

    return {
      content: [{ type: "text", text: `Merchant ${name} registered.` }],
    };
  }
);

server.tool(
  "create_intent",
  "Create a user purchase intent",
  z.object({
    user_name: z.string(),
    merchant_name: z.string(),
    description: z.string(),
    value: z.number(),
  }),
  async ({ user_name, merchant_name, description, value }) => {
    const { error } = await supabase
      .from("intents")
      .insert({ user_name, merchant_name, description, value });

    if (error) throw error;

    return {
      content: [{ type: "text", text: `Intent created for ${merchant_name}.` }],
    };
  }
);

const app = express();
app.use(express.json());

const transport = new StreamableHTTPServerTransport(server);

app.post("/mcp", async (req, res) => {
  await transport.handleRequest(req, res);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`VIA MCP server running on port ${PORT}`);
});

