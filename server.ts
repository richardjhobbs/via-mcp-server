import "dotenv/config";
import { kbInit, kbList, kbGet, kbSearch, kbRender } from "./kb.js";

import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------- ENV ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

// ---------- SUPABASE ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- KB INIT ----------
await kbInit();

// ---------- MCP SERVER ----------
function buildMcpServer() {
  const server = new McpServer({
    name: "via-agent-demo",
    version: "0.1.0",
  });

  server.tool(
    "register_merchant",
    "Register a merchant (writes to Supabase table: merchants).",
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
              `✅ Merchant registered\n` +
              `Name: ${name}\nCategory: ${category}\nCountry: ${country}\n` +
              `ID: ${data?.id ?? "n/a"}\nCreated: ${data?.created_at ?? "n/a"}`,
          },
        ],
      };
    }
  );

  server.tool(
    "create_intent",
    "Create a user intent (writes to Supabase table: intents).",
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
              `🧠 Intent recorded\n` +
              `User: ${user_name}\nMerchant: ${merchant_name}\n` +
              `Description: ${description}\nValue: ${value}\n` +
              `ID: ${data?.id ?? "n/a"}\nCreated: ${data?.created_at ?? "n/a"}`,
          },
        ],
      };
    }
  );

  server.tool("via_summary", "Counts from Supabase.", {}, async () => {
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
            text:
              `Merchants error: ${merchantsRes.error?.message ?? "none"}\n` +
              `Intents error: ${intentsRes.error?.message ?? "none"}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `VIA Summary\nMerchants: ${merchantsRes.count ?? 0}\nIntents: ${intentsRes.count ?? 0}`,
        },
      ],
    };
  });

  return server;
}

// ---------- SESSION STORE ----------
type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const sessions: Record<string, Session> = {};

function getSessionId(req: Request) {
  const v = req.header("mcp-session-id");
  return v && v.trim() ? v.trim() : undefined;
}

function isInitialize(parsedBody: any): boolean {
  if (!parsedBody) return false;
  if (Array.isArray(parsedBody)) {
    return parsedBody.some((x) => x?.jsonrpc === "2.0" && x?.method === "initialize");
  }
  return parsedBody?.jsonrpc === "2.0" && parsedBody?.method === "initialize";
}

// ---------- EXPRESS ----------
const app = express();
app.use(cors());

// IMPORTANT: accept raw text so we control JSON parsing
app.use(express.text({ type: "*/*", limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);

    // Parse JSON ourselves
    const raw = typeof req.body === "string" ? req.body : "";
    let parsed: any;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    // Existing session: route message to the right transport
    if (sessionId && sessions[sessionId]) {
      await sessions[sessionId].transport.handleRequest(req, res, parsed);
      return;
    }

    // New session: only allowed for initialize
    if (!sessionId && isInitialize(parsed)) {
      const newSessionId = randomUUID();

      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      sessions[newSessionId] = { server, transport };

      transport.onclose = () => {
        delete sessions[newSessionId];
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    res.status(400).json({
      error:
        "Bad Request: missing/invalid mcp-session-id, and request was not initialize",
    });
  } catch (err: any) {
    console.error("POST /mcp error:", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "Server error" });
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = getSessionId(req);
  if (!sessionId || !sessions[sessionId]) {
    res.status(400).send("Invalid or missing mcp-session-id");
    return;
  }
  await sessions[sessionId].transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = getSessionId(req);
  if (!sessionId || !sessions[sessionId]) {
    res.status(400).send("Invalid or missing mcp-session-id");
    return;
  }
  await sessions[sessionId].transport.handleRequest(req, res);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`VIA MCP server listening on port ${PORT}`));
