import "dotenv/config";

import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------- ENV ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY");

// ---------- SUPABASE ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- MCP SERVER FACTORY ----------
function createMcpServer() {
  const server = new McpServer({
    name: "via-agent-demo",
    version: "0.1.0",
  });

  // Tool 1: Register Merchant
  server.tool(
    "register_merchant",
    "Register a merchant in the VIA network (stored in Supabase).",
    {
      name: z.string().min(1),
      category: z.string().min(1),
      country: z.string().min(1),
    },
    async ({ name, category, country }) => {
      const { data, error } = await supabase
        .from("merchants")
        .insert({ name, category, country })
        .select("id, created_at")
        .single();

      if (error) {
        return {
          content: [{ type: "text", text: `Supabase error: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Merchant registered\n` +
              `Name: ${name}\n` +
              `Category: ${category}\n` +
              `Country: ${country}\n` +
              `ID: ${data?.id}\n` +
              `Created: ${data?.created_at}`,
          },
        ],
      };
    }
  );

  // Tool 2: Create Intent
  server.tool(
    "create_intent",
    "Create a purchase intent (stored in Supabase).",
    {
      user_name: z.string().min(1),
      merchant_name: z.string().min(1),
      description: z.string().min(1),
      value: z.number().finite().nonnegative(),
    },
    async ({ user_name, merchant_name, description, value }) => {
      const { data, error } = await supabase
        .from("intents")
        .insert({ user_name, merchant_name, description, value })
        .select("id, created_at")
        .single();

      if (error) {
        return {
          content: [{ type: "text", text: `Supabase error: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Intent recorded\n` +
              `User: ${user_name}\n` +
              `Merchant: ${merchant_name}\n` +
              `Description: ${description}\n` +
              `Value: ${value}\n` +
              `ID: ${data?.id}\n` +
              `Created: ${data?.created_at}`,
          },
        ],
      };
    }
  );

  // Tool 3: Summary
  server.tool(
    "via_summary",
    "Return total merchants and intents stored in Supabase.",
    {},
    async () => {
      const merchantsRes = await supabase
        .from("merchants")
        .select("id", { count: "exact", head: true });

      const intentsRes = await supabase
        .from("intents")
        .select("id", { count: "exact", head: true });

      if (merchantsRes.error || intentsRes.error) {
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving counts`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `VIA Summary\n` +
              `Merchants: ${merchantsRes.count ?? 0}\n` +
              `Intents: ${intentsRes.count ?? 0}`,
          },
        ],
      };
    }
  );

  return server;
}

// ---------- EXPRESS APP ----------
const app = express();

app.use(cors());

// IMPORTANT: Use raw text, not express.json
app.use(express.text({ type: "*/*", limit: "1mb" }));

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

// Let Streamable HTTP handle both GET and POST
app.all("/mcp", async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);

    const rawBody = typeof req.body === "string" ? req.body : "";
    await transport.handleRequest(req, res, rawBody);

    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err: any) {
    console.error("MCP error:", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "Server error" });
  }
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`VIA MCP server listening on port ${PORT}`);
});
