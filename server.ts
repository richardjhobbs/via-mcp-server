// server.ts
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

type Merchant = {
  id: string;
  name: string;
  category?: string;
  country?: string;
  created_at: string;
};

type Intent = {
  id: string;
  user_name: string;
  merchant_name: string;
  description: string;
  value: number;
  created_at: string;
};

// Simple in-memory demo storage (good enough to prove “agentic” behaviour publicly)
const merchants: Merchant[] = [];
const intents: Intent[] = [];

function createMcpServer() {
  const server = new McpServer({
    name: "via-mcp-server",
    version: "0.1.0",
  });

  // Tool 1: Register a merchant
  server.tool(
    "register_merchant",
    "Register a merchant (demo stores it in memory).",
    {
      name: z.string().min(1, "name is required"),
      category: z.string().optional(),
      country: z.string().optional(),
    },
    async ({ name, category, country }) => {
      const item: Merchant = {
        id: randomUUID(),
        name,
        category,
        country,
        created_at: new Date().toISOString(),
      };

      merchants.unshift(item);

      return {
        content: [
          {
            type: "text",
            text: `✅ Registered merchant: ${item.name}\nID: ${item.id}\nCategory: ${item.category ?? "n/a"}\nCountry: ${item.country ?? "n/a"}`,
          },
        ],
      };
    }
  );

  // Tool 2: Create an “intent” (this is the agentic demo)
  server.tool(
    "create_intent",
    "Create a user intent to buy something from a merchant (demo stores it in memory).",
    {
      user_name: z.string().min(1, "user_name is required"),
      merchant_name: z.string().min(1, "merchant_name is required"),
      description: z.string().min(1, "description is required"),
      value: z.number().finite().nonnegative(),
    },
    async ({ user_name, merchant_name, description, value }) => {
      const item: Intent = {
        id: randomUUID(),
        user_name,
        merchant_name,
        description,
        value,
        created_at: new Date().toISOString(),
      };

      intents.unshift(item);

      return {
        content: [
          {
            type: "text",
            text: `🧠 Intent captured\nUser: ${item.user_name}\nMerchant: ${item.merchant_name}\nWhat: ${item.description}\nValue: ${item.value}\nID: ${item.id}`,
          },
        ],
      };
    }
  );

  // Tool 3: Quick “dashboard” summary
  server.tool(
    "via_summary",
    "Return a quick summary of merchants and intents captured by the server.",
    {},
    async () => {
      const latestMerchant = merchants[0];
      const latestIntent = intents[0];

      return {
        content: [
          {
            type: "text",
            text:
              `VIA MCP Summary\n` +
              `Merchants: ${merchants.length}\n` +
              `Intents: ${intents.length}\n\n` +
              `Latest merchant: ${latestMerchant ? latestMerchant.name : "none"}\n` +
              `Latest intent: ${latestIntent ? `${latestIntent.user_name} -> ${latestIntent.merchant_name}` : "none"}`,
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check for Render
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// MCP endpoint (Streamable HTTP)
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();

    // Stateful mode (server generates a session id)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err: any) {
    console.error("MCP /mcp error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`VIA MCP Server listening on port ${PORT}`);
});
