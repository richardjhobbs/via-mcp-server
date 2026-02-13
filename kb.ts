import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// -----------------------------
// Types
// -----------------------------
type Corpus = "human" | "technical";
type DocFormat = "markdown" | "text" | "outline_json";

type ManifestDoc = {
  id: string;
  title: string;
  file: string;
  tags: string[];
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
  absPath: string;
  markdown: string;
  text: string;
  outline: { headings: { level: number; text: string }[] };
};

type KbIndex = {
  versionHuman: string;
  versionTechnical: string;
  byId: Map<string, LoadedDoc>;
  docs: LoadedDoc[];
};

let KB: KbIndex | null = null;

// -----------------------------
// Config
// -----------------------------
function kbRoot(): string {
  // Repo root at runtime should be process.cwd()
  // We assume /kb lives at cwd/kb
  return path.join(process.cwd(), "kb");
}

async function loadManifest(corpus: Corpus): Promise<Manifest> {
  const manifestPath = path.join(kbRoot(), corpus, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);

  const schema = z.object({
    corpus: z.enum(["human", "technical"]),
    version: z.string().min(1),
    documents: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        file: z.string().min(1),
        tags: z.array(z.string()).default([]),
      })
    ),
  });

  return schema.parse(parsed) as Manifest;
}

function stripMarkdown(md: string): string {
  // Minimal, safe cleanup (keep content readable)
  let t = md;

  // Remove fenced code blocks but keep code content lightly
  t = t.replace(/```[\s\S]*?```/g, (block) => {
    const inner = block.replace(/^```.*\n/, "").replace(/\n```$/, "");
    return inner.trim();
  });

  // Remove inline code ticks
  t = t.replace(/`([^`]+)`/g, "$1");

  // Remove markdown links [text](url) -> text
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // Remove emphasis markers
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");

  // Remove heading hashes but keep line
  t = t.replace(/^#{1,6}\s+/gm, "");

  // Collapse extra blank lines
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

function buildOutline(md: string) {
  const headings: { level: number; text: string }[] = [];
  for (const line of md.split("\n")) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (m) headings.push({ level: m[1].length, text: m[2].trim() });
  }
  return { headings };
}

async function loadDoc(corpus: Corpus, d: ManifestDoc): Promise<LoadedDoc> {
  const absPath = path.join(kbRoot(), corpus, d.file);
  const markdown = await readFile(absPath, "utf8");
  const text = stripMarkdown(markdown);
  const outline = buildOutline(markdown);

  return {
    id: d.id,
    corpus,
    title: d.title,
    tags: d.tags ?? [],
    file: d.file,
    absPath,
    markdown,
    text,
    outline,
  };
}

export async function kbInit(): Promise<void> {
  const human = await loadManifest("human");
  const technical = await loadManifest("technical");

  const docs: LoadedDoc[] = [];
  for (const d of human.documents) docs.push(await loadDoc("human", d));
  for (const d of technical.documents) docs.push(await loadDoc("technical", d));

  const byId = new Map<string, LoadedDoc>();
  for (const doc of docs) byId.set(doc.id, doc);

  KB = {
    versionHuman: human.version,
    versionTechnical: technical.version,
    byId,
    docs,
  };
}

function assertKbLoaded() {
  if (!KB) {
    throw new Error("KB not initialized. Call kbInit() on server startup.");
  }
}

export function kbList(corpus?: Corpus) {
  assertKbLoaded();
  const docs = KB!.docs
    .filter((d) => (corpus ? d.corpus === corpus : true))
    .map((d) => ({
      id: d.id,
      title: d.title,
      corpus: d.corpus,
      tags: d.tags,
      file: d.file,
    }));

  return {
    version: corpus
      ? corpus === "human"
        ? KB!.versionHuman
        : KB!.versionTechnical
      : { human: KB!.versionHuman, technical: KB!.versionTechnical },
    documents: docs,
  };
}

export function kbGet(id: string, format: DocFormat = "markdown") {
  assertKbLoaded();
  const doc = KB!.byId.get(id);
  if (!doc) throw new Error(`Unknown document id: ${id}`);

  if (format === "markdown") {
    return {
      id: doc.id,
      title: doc.title,
      corpus: doc.corpus,
      format,
      content: doc.markdown,
    };
  }
  if (format === "text") {
    return {
      id: doc.id,
      title: doc.title,
      corpus: doc.corpus,
      format,
      content: doc.text,
    };
  }
  return {
    id: doc.id,
    title: doc.title,
    corpus: doc.corpus,
    format,
    content: doc.outline,
  };
}

export function kbSearch(query: string, corpus?: Corpus) {
  assertKbLoaded();
  const q = query.trim().toLowerCase();
  if (!q) return { query, results: [] as any[] };

  const scored = KB!.docs
    .filter((d) => (corpus ? d.corpus === corpus : true))
    .map((d) => {
      const hay = `${d.title}\n${d.tags.join(" ")}\n${d.text}`.toLowerCase();
      const hits = hay.split(q).length - 1;
      return { d, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10);

  return {
    query,
    corpus: corpus ?? "all",
    results: scored.map(({ d, hits }) => ({
      id: d.id,
      title: d.title,
      corpus: d.corpus,
      tags: d.tags,
      score: hits,
    })),
  };
}

export function kbRender(query: string, audience: Corpus) {
  assertKbLoaded();

  // Simple deterministic renderer: select top docs, stitch key content
  const search = kbSearch(query, audience);
  const top = search.results.slice(0, 3);

  const sources = top.map((x) => x.id);
  const excerpts = top.map((x) => {
    const doc = KB!.byId.get(x.id)!;
    const excerpt = doc.text.slice(0, 900);
    return {
      id: doc.id,
      title: doc.title,
      excerpt,
    };
  });

  const summary =
    audience === "human"
      ? `This answer pack pulls from the Human Track documents most relevant to: "${query}".`
      : `This answer pack pulls from the Technical Track documents most relevant to: "${query}".`;

  return {
    audience,
    query,
    summary,
    sources,
    excerpts,
  };
}
