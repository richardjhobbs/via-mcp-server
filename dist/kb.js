import { readFile } from "node:fs/promises";
import path from "node:path";
let docs = [];
let byId = new Map();
function kbRoot() {
    return path.join(process.cwd(), "kb");
}
function stripMarkdown(md) {
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
function buildOutline(md) {
    const headings = [];
    for (const line of md.split("\n")) {
        const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
        if (m)
            headings.push({ level: m[1].length, text: m[2].trim() });
    }
    return { headings };
}
async function loadManifest(corpus) {
    const p = path.join(kbRoot(), corpus, "manifest.json");
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
}
async function loadCorpus(corpus) {
    const manifest = await loadManifest(corpus);
    const out = [];
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
    if (docs.length === 0) {
        throw new Error("KB not initialized. Call kbInit().");
    }
}
/* ------------------------------------------------------------------ */
/* LIST WITH PAGINATION */
/* ------------------------------------------------------------------ */
export function kbList(corpus, options) {
    assertReady();
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const filtered = docs.filter((d) => corpus ? d.corpus === corpus : true);
    const sliced = filtered.slice(offset, offset + limit);
    return {
        total: filtered.length,
        limit,
        offset,
        results: sliced.map((d) => ({
            id: d.id,
            title: d.title,
            corpus: d.corpus,
            tags: d.tags,
            file: d.file,
        })),
    };
}
/* ------------------------------------------------------------------ */
/* GET */
/* ------------------------------------------------------------------ */
export function kbGet(id, format = "markdown") {
    assertReady();
    const d = byId.get(id);
    if (!d)
        throw new Error(`Unknown document id: ${id}`);
    if (format === "markdown") {
        return { id: d.id, title: d.title, corpus: d.corpus, format, content: d.markdown };
    }
    if (format === "text") {
        return { id: d.id, title: d.title, corpus: d.corpus, format, content: d.text };
    }
    return { id: d.id, title: d.title, corpus: d.corpus, format, content: d.outline };
}
/* ------------------------------------------------------------------ */
/* SEARCH WITH PAGINATION */
/* ------------------------------------------------------------------ */
export function kbSearch(query, corpus, options) {
    assertReady();
    const q = query.trim().toLowerCase();
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    if (!q) {
        return {
            query,
            corpus: corpus ?? "all",
            total: 0,
            limit,
            offset,
            results: [],
        };
    }
    const scored = docs
        .filter((d) => (corpus ? d.corpus === corpus : true))
        .map((d) => {
        const hay = `${d.title}\n${d.tags.join(" ")}\n${d.text}`.toLowerCase();
        const score = hay.split(q).length - 1;
        return { d, score };
    })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
    const sliced = scored.slice(offset, offset + limit);
    return {
        query,
        corpus: corpus ?? "all",
        total: scored.length,
        limit,
        offset,
        results: sliced.map(({ d, score }) => ({
            id: d.id,
            title: d.title,
            corpus: d.corpus,
            tags: d.tags,
            score,
        })),
    };
}
/* ------------------------------------------------------------------ */
/* RENDER */
/* ------------------------------------------------------------------ */
export function kbRender(query, audience) {
    const search = kbSearch(query, audience, { limit: 3 });
    const top = search.results.slice(0, 3);
    const sources = top.map((r) => r.id);
    return {
        audience,
        query,
        sources,
    };
}
