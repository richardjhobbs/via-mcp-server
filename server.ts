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
function buildMcpServer(sessionId: string) {
  const server = new McpServer({
    name: "via-agent-demo",
    version: "0.2.0",
  });

  // ---------- KB POLICY + REQUESTER TRUST ----------
  async function getCorpusPolicy(corpus: "human" | "technical") {
    const { data, error } = await supabase
      .from("kb_corpus_policy")
      .select("min_trust, mode")
      .eq("corpus", corpus)
      .maybeSingle();

    if (error || !data) {
      return { min_trust: 0, mode: "public" as const };
    }

    return {
      min_trust: Number((data as any).min_trust ?? 0),
      mode: (((data as any).mode ?? "public") as "public" | "gated" | "internal"),
    };
  }

  async function getRequesterTrust(requester_type: string, requester_id: string) {
    const { data, error } = await supabase
      .from("kb_requesters")
      .select("trust_score, status")
      .eq("requester_type", requester_type)
      .eq("requester_id", requester_id)
      .maybeSingle();

    if (error || !data) {
      return { trust_score: 0, status: "active" as const };
    }

    return {
      trust_score: Number((data as any).trust_score ?? 0),
      status: (((data as any).status ?? "active") as "active" | "blocked"),
    };
  }

  async function enforceKbAccess(params: {
    requester_type: string;
    requester_id: string;
    corpus: "human" | "technical";
  }) {
    const policy = await getCorpusPolicy(params.corpus);
    const requester = await getRequesterTrust(params.requester_type, params.requester_id);

    if (requester.status === "blocked") {
      return { ok: false as const, reason: "requester_blocked" };
    }

    if (requester.trust_score < policy.min_trust) {
      return { ok: false as const, reason: `trust_below_threshold:${policy.min_trust}` };
    }

    return { ok: true as const, reason: "allowed" };
  }

  // ---------- LOGGING ----------
  async function logKbAccess(params: {
    requester_type: string;
    requester_id: string;
    corpus: string | null;
    doc_ids: string[] | null; // IMPORTANT: matches Postgres text[]
    query: string | null;
    format: string | null;
    ok: boolean;
    error: string | null;
    source?: string | null;
  }) {
    const payload: any = {
      requester_type: params.requester_type,
      requester_id: params.requester_id,
      source: params.source ?? "mcp",
      session_id: sessionId,
      corpus: params.corpus,
      doc_ids: params.doc_ids, // IMPORTANT: array or null
      query: params.query,
      format: params.format,
      ok: params.ok,
      error: params.error,
    };

    const { error } = await supabase.from("kb_access_logs").insert(payload);
    if (error) {
      console.error("kb_access_logs insert failed:", error.message, payload);
    }
  }

  // ---------- WRITE TOOLS ----------
  server.registerTool(
    "register_merchant",
    {
      title: "register_merchant",
      description: "Register a merchant (writes to Supabase table: merchants).",
      inputSchema: {
        name: z.string().min(1),
        category: z.string().min(1),
        country: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true, // write tool
      },
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

  server.registerTool(
    "create_intent",
    {
      title: "create_intent",
      description: "Create a user intent (writes to Supabase table: intents).",
      inputSchema: {
        user_name: z.string().min(1),
        merchant_name: z.string().min(1),
        description: z.string().min(1),
        value: z.number().finite().nonnegative(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true, // write tool
      },
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

  // ---------- READ TOOL ----------
  server.registerTool(
    "via_summary",
    {
      title: "via_summary",
      description: "Counts from Supabase.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
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
    }
  );

  // ---------- KB TOOLS (READ-ONLY) ----------
  server.registerTool(
    "kb_list",
    {
      title: "kb_list",
      description: "List available VIA knowledge base documents.",
      inputSchema: {
        requester_type: z.string().min(1),
        requester_id: z.string().min(1),
        corpus: z.enum(["human", "technical"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ requester_type, requester_id, corpus, limit, offset }) => {
      const effectiveCorpus = (corpus ?? "human") as "human" | "technical";
      const effectiveLimit = limit ?? 20;
      const effectiveOffset = offset ?? 0;

      const access = await enforceKbAccess({
        requester_type,
        requester_id,
        corpus: effectiveCorpus,
      });

      if (!access.ok) {
        await logKbAccess({
          requester_type,
          requester_id,
          corpus: effectiveCorpus,
          doc_ids: null,
          query: null,
          format: `list(limit=${effectiveLimit},offset=${effectiveOffset})`,
          ok: false,
          error: access.reason,
        });

        return {
          content: [{ type: "text", text: `Access denied: ${access.reason}` }],
          isError: true,
        };
      }

      const items = kbList(effectiveCorpus, { limit: effectiveLimit, offset: effectiveOffset });

      await logKbAccess({
        requester_type,
        requester_id,
        corpus: effectiveCorpus,
        doc_ids: null,
        query: null,
        format: `list(limit=${effectiveLimit},offset=${effectiveOffset})`,
        ok: true,
        error: null,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  server.registerTool(
    "kb_get",
    {
      title: "kb_get",
      description: "Get a specific knowledge base document by id.",
      inputSchema: {
        requester_type: z.string().min(1),
        requester_id: z.string().min(1),
        id: z.string().min(1),
        format: z.enum(["markdown", "text", "outline_json"]).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ requester_type, requester_id, id, format }) => {
      try {
        const meta = kbGet(id, "outline_json" as any);
        const inferredCorpus = (meta?.corpus ?? "human") as "human" | "technical";

        const access = await enforceKbAccess({
          requester_type,
          requester_id,
          corpus: inferredCorpus,
        });

        if (!access.ok) {
          await logKbAccess({
            requester_type,
            requester_id,
            corpus: inferredCorpus,
            doc_ids: [id], // FIX: array
            query: null,
            format: format ?? null,
            ok: false,
            error: access.reason,
          });

          return {
            content: [{ type: "text", text: `Access denied: ${access.reason}` }],
            isError: true,
          };
        }

        const doc = kbGet(id, (format ?? "markdown") as any);

        await logKbAccess({
          requester_type,
          requester_id,
          corpus: inferredCorpus,
          doc_ids: [id], // FIX: array
          query: null,
          format: format ?? "markdown",
          ok: true,
          error: null,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
        };
      } catch (e: any) {
        await logKbAccess({
          requester_type,
          requester_id,
          corpus: null,
          doc_ids: [id], // FIX: array even on error
          query: null,
          format: format ?? null,
          ok: false,
          error: e?.message ?? "kb_get_error",
        });

        return {
          content: [{ type: "text", text: `kb_get error: ${e?.message ?? "unknown"}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "kb_search",
    {
      title: "kb_search",
      description: "Search knowledge base documents for a query string.",
      inputSchema: {
        requester_type: z.string().min(1),
        requester_id: z.string().min(1),
        query: z.string().min(1),
        corpus: z.enum(["human", "technical"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ requester_type, requester_id, query, corpus, limit, offset }) => {
      const effectiveCorpus = (corpus ?? "human") as "human" | "technical";
      const effectiveLimit = limit ?? 20;
      const effectiveOffset = offset ?? 0;

      const access = await enforceKbAccess({
        requester_type,
        requester_id,
        corpus: effectiveCorpus,
      });

      if (!access.ok) {
        await logKbAccess({
          requester_type,
          requester_id,
          corpus: effectiveCorpus,
          doc_ids: null,
          query,
          format: `search(limit=${effectiveLimit},offset=${effectiveOffset})`,
          ok: false,
          error: access.reason,
        });

        return {
          content: [{ type: "text", text: `Access denied: ${access.reason}` }],
          isError: true,
        };
      }

      const results = kbSearch(query, effectiveCorpus, {
        limit: effectiveLimit,
        offset: effectiveOffset,
      });

      const docIds =
        Array.isArray((results as any)?.results)
          ? (results as any).results.map((r: any) => r?.id).filter(Boolean).slice(0, 50)
          : [];

      await logKbAccess({
        requester_type,
        requester_id,
        corpus: effectiveCorpus,
        doc_ids: docIds.length ? docIds : null, // FIX: array or null
        query,
        format: `search(limit=${effectiveLimit},offset=${effectiveOffset})`,
        ok: true,
        error: null,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.registerTool(
    "kb_render",
    {
      title: "kb_render",
      description: "Render an answer pack from the knowledge base.",
      inputSchema: {
        requester_type: z.string().min(1),
        requester_id: z.string().min(1),
        query: z.string().min(1),
        audience: z.enum(["human", "technical"]),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ requester_type, requester_id, query, audience }) => {
      const effectiveCorpus = audience;

      const access = await enforceKbAccess({
        requester_type,
        requester_id,
        corpus: effectiveCorpus,
      });

      if (!access.ok) {
        await logKbAccess({
          requester_type,
          requester_id,
          corpus: effectiveCorpus,
          doc_ids: null,
          query,
          format: "render",
          ok: false,
          error: access.reason,
        });

        return {
          content: [{ type: "text", text: `Access denied: ${access.reason}` }],
          isError: true,
        };
      }

      const rendered = kbRender(query, audience);

      const sources =
        Array.isArray((rendered as any)?.sources) ? ((rendered as any).sources as string[]) : [];

      await logKbAccess({
        requester_type,
        requester_id,
        corpus: effectiveCorpus,
        doc_ids: sources.length ? sources : null, // FIX: array or null
        query,
        format: "render",
        ok: true,
        error: null,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(rendered, null, 2) }],
      };
    }
  );

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
app.use(express.text({ type: "*/*", limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);

    const raw = typeof req.body === "string" ? req.body : "";
    let parsed: any;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    if (sessionId && sessions[sessionId]) {
      await sessions[sessionId].transport.handleRequest(req, res, parsed);
      return;
    }

    if (!sessionId && isInitialize(parsed)) {
      const newSessionId = randomUUID();
      const server = buildMcpServer(newSessionId);
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
      error: "Bad Request: missing/invalid mcp-session-id, and request was not initialize",
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
