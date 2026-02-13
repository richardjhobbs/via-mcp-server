import { readFile } from "node:fs/promises";
import path from "node:path";

type Corpus = "human" | "technical";
type Format = "markdown" | "text" | "outline_json";

type ManifestDoc = {
  id: string;
  title: string;
  file: string;
  tags?: string[];
};

type Manifest = {
  corpus: Corpus;
  version: string;
  documents: ManifestDoc[];
};

type LoadedDoc = {
  id: string;
  corpus: Corpus;
  title: string;
  tags: string[];
  file: string;
  markdown: string;
  text: string;
  outline: { headings: { level: number; text: string }[] };
};

let docs: LoadedDoc[] = [];
let byId = new Map<string, LoadedDoc>();

function kbRoot() {
  return path.join(process.cwd(), "kb");
}

function stripMarkdown(md: string) {
  // keep it simple and robust
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildOutline(md: string) {
  const headings: { level: number; text: string }[] = [];
  for (const line of md.split("\n")) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (m) headings.push({ level: m[1].length, text: m[2].trim() });
  }
  return { headings };
}

async function loadManifest(corpus: Corpus): Promise<Manifest> {
  const p = path.join(kbRoot(), corpus, "manifest.json");
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw);
}

async function loadCorpus(corpus: Corpus) {
  const manifest = await loadManifest(corpus);
  const out: LoadedDoc[] = [];

  for (const d of manifest.documents) {
    const filePath = path.join(kbRoot(), corpus, d.file);
    const markdown = await readFile(filePath, "utf8");
    out.push({
      id: d.id,
      corpus,
      title: d.title,
      tags: d.tags ?? [],
      file: d.file,
      markdown,
      text: stripMarkdown(markdown),
      outline: buildOutline(markdown),
    });
  }

  return out;
}

export async function kbInit() {
  const human = await loadCorpus("human");
  const technical = await loadCorpus("technical");

  docs = [...human, ...technical];
  byId = new Map(docs.map((d) => [d.id, d]));
}

function assertReady() {
  if (docs.length === 0) throw new Error("KB not initialized. Call kbInit().");
}

export function kbList(corpus?: Corpus) {
  assertReady();
  return docs
    .filter((d) => (corpus ? d.corpus === corpus : true))
    .map((d) => ({
      id: d.id,
      title: d.title,
      corpus: d.corpus,
      tags: d.tags,
      file: d.file,
    }));
}

export function kbGet(id: string, format: Format = "markdown") {
  assertReady();
  const d = byId.get(id);
  if (!d) throw new Error(`Unknown document id: ${id}`);

  if (format === "markdown") {
    return { id: d.id, title: d.title, corpus: d.corpus, format, content: d.markdown };
  }
  if (format === "text") {
    return { id: d.id, title: d.title, corpus: d.corpus, format, content: d.text };
  }
  return { id: d.id, title: d.title, corpus: d.corpus, format, content: d.outline };
}

export function kbSearch(query: string, corpus?: Corpus) {
  assertReady();
  const q = query.trim().toLowerCase();
  if (!q) return { query, corpus: corpus ?? "all", results: [] as any[] };

  const scored = docs
    .filter((d) => (corpus ? d.corpus === corpus : true))
    .map((d) => {
      const hay = `${d.title}\n${d.tags.join(" ")}\n${d.text}`.toLowerCase();
      const score = hay.split(q).length - 1;
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    query,
    corpus: corpus ?? "all",
    results: scored.map(({ d, score }) => ({
      id: d.id,
      title: d.title,
      corpus: d.corpus,
      tags: d.tags,
      score,
    })),
  };
}

export function kbRender(query: string, audience: Corpus) {
  const search = kbSearch(query, audience);
  const top = search.results.slice(0, 3);
  const sources = top.map((r: any) => r.id);

  // small, deterministic pack for agents
  return {
    audience,
    query,
    sources,
  };
}
