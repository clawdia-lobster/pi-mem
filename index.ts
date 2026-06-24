/**
 * Memory Extension
 *
 * Plain-Markdown memory system inspired by OpenClaw's approach.
 * No embeddings, no vector search — just files on disk injected into context.
 *
 * Layout (under ~/.pi/agent/memory/):
 *   MEMORY.md              — curated long-term memory (decisions, preferences, durable facts)
 *   SCRATCHPAD.md           — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md    — daily append-only log (today + yesterday loaded at session start)
 *
 * Tools:
 *   memory_write  — write to MEMORY.md or daily log
 *   memory_read   — read any memory file or list daily logs
 *   scratchpad    — add/check/uncheck/clear items on the scratchpad checklist
 *
 * Context injection:
 *   - MEMORY.md + SCRATCHPAD.md + today's + yesterday's daily logs injected into every turn
 *   - Snapshot captured once at session start, identical on every turn
 *
 * Dashboard widget:
 *   - Scratchpad open items, read fresh on each render
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
	type MemoryConfig,
	type ScratchpadItem,
	buildConfig,
	todayStr,
	yesterdayStr,
	nowTimestamp,
	shortSessionId,
	readFileSafe,
	dailyPath,
	ensureDirs,
	parseScratchpad,
	serializeScratchpad,
	buildMemorySnapshot,
	readMemoryFile,
	searchMemory,
	writeFileAtomic,
	toggleScratchpadItem,
} from "./lib.ts";

const config = buildConfig();

// Memory snapshot cached for the session. Captured once at session_start,
// appended identically via before_agent_start on every turn.
let sessionMemoryContext: string | null = null;

function isExpectedError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const code = (error as any).code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

function gitCommit(message: string, filePath?: string) {
	if (!config.autocommit) return;
	try {
		if (filePath) {
			execFileSync("git", ["add", filePath], { cwd: config.memoryDir, stdio: "ignore", timeout: 5000 });
		}
		execFileSync("git", ["commit", "-m", message, "--allow-empty-message", "--no-verify"], { cwd: config.memoryDir, stdio: "ignore", timeout: 5000 });
	} catch (e: any) {
		if (!isExpectedError(e)) console.warn(`git commit failed: ${e.message}`);
	}
}

async function showDashboard(ctx: any) {
	if (!ctx.hasUI) return;

	ctx.ui.setWidget("memory-dashboard", (_tui: any, theme: any) => {
		const mdTheme = getMarkdownTheme();
		const container = new Container();
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		let lastExpanded: boolean | undefined;

		const origRender = container.render.bind(container);
		container.render = (width: number) => {
			const expanded = ctx.ui.getToolsExpanded();

			if (cachedLines && cachedWidth === width && lastExpanded === expanded) {
				return cachedLines;
			}

			container.clear();

			// Read scratchpad fresh on each render
			const scratchContent = readFileSafe(config.scratchpadFile);
			const openItems: string[] = [];
			if (scratchContent?.trim()) {
				const lines = scratchContent.trim().split("\n");
				for (const l of lines) {
					if (l.match(/^- \[ \]/) && !l.match(/^<!--.*-->$/)) {
						openItems.push(l.replace(/^- /, ""));
					}
				}
			}

			if (expanded) {
				if (openItems.length > 0) {
					const scratchMd = `## Scratchpad\n\n${openItems.join("\n")}`;
					container.addChild(new Markdown(scratchMd, 1, 0, mdTheme));
				} else {
					container.addChild(new Text(theme.fg("muted", "Scratchpad is empty."), 1, 0));
				}
			} else {
				const parts: string[] = [];
				if (openItems.length > 0) {
					parts.push(`${openItems.length} scratchpad item${openItems.length > 1 ? "s" : ""}`);
				} else {
					parts.push("Scratchpad empty");
				}
				const hint = keyHint("expandTools", "to expand");
				const line = theme.fg("muted", parts.join(", ")) + " " + theme.fg("dim", `(${hint})`);
				container.addChild(new Text(line, 1, 0));
			}

			cachedLines = origRender(width);
			cachedWidth = width;
			lastExpanded = expanded;
			return cachedLines;
		};

		const origInvalidate = container.invalidate.bind(container);
		container.invalidate = () => {
			cachedWidth = undefined;
			cachedLines = undefined;
			lastExpanded = undefined;
			origInvalidate();
		};

		return container;
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		sessionMemoryContext = buildMemorySnapshot(config);
		await showDashboard(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await showDashboard(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		ctx.ui.setWidget("memory-dashboard", undefined);
	});

	pi.on("session_shutdown", async () => {
		sessionMemoryContext = null;
	});

	// Inject memory into the system prompt once per user prompt, before the
	// agent loop starts.  Using before_agent_start (instead of the context
	// event) guarantees the memory is injected exactly once per turn, not
	// before every LLM call within a turn (which includes tool-result
	// continuations and causes spurious extra turns / token waste).
	//
	// The memory text is a frozen snapshot captured at session_start. It is
	// identical on every turn, preserving KV prefix cache stability.
	pi.on("before_agent_start", async (event) => {
		if (!sessionMemoryContext) return;

		const memoryInstructions = [
			"\n\n## Memory",
			"The following memory files have been loaded. Use the memory_write tool to persist important information.",
			"- Decisions, preferences, and durable facts -> MEMORY.md",
			"- Day-to-day notes and running context -> daily/<YYYY-MM-DD>.md",
			"- Things to fix later or keep in mind -> scratchpad tool",
			"- Scratchpad is NOT auto-loaded. Use memory_read(target='scratchpad') to fetch it when needed.",
			'- If someone says "remember this," write it immediately.',
			"",
			"### Daily Log Rule",
			"After meaningful interactions, call memory_write(target='daily') with a brief 1-2 sentence summary.",
			"**Log when:** task completed, decision made, bug fixed, new info discovered, config changed.",
			"**Skip when:** greetings, goodbyes, chitchat, simple acks, trivial factual questions.",
			'Log the outcome, not the question (e.g. "Debugged import error — missing __init__.py" not "User asked about imports").',
			"",
			sessionMemoryContext,
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + memoryInstructions,
		};
	});

	// memory_write tool
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to memory files. Three targets:",
			"- 'long_term': Write to MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"- 'note': Create or update a file in notes/ (e.g. lessons.md, self-review.md). Pass filename. Mode: 'append' or 'overwrite'.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily", "note"] as const, {
				description: "Where to write: 'long_term' for MEMORY.md, 'daily' for today's daily log, 'note' for notes/<filename>",
			}),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "Write mode. Default: 'append'. Daily always appends.",
				}),
			),
			filename: Type.Optional(
				Type.String({ description: "Filename for 'note' target (e.g. 'lessons.md')" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs(config);
			const { target, content, mode, filename } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "note") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'note'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(config.notesDir, safe);
				const existing = readFileSafe(filePath) ?? "";

				if (mode === "overwrite") {
					const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
					writeFileAtomic(filePath, stamped);
					gitCommit(`note: ${safe}`, path.relative(config.memoryDir, filePath));
					return {
						content: [{ type: "text", text: `Wrote notes/${safe}` }],
						details: { path: filePath, target, mode: "overwrite", sessionId: sid, timestamp: ts },
					};
				}

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				writeFileAtomic(filePath, existing + separator + stamped);
				gitCommit(`note: ${safe}`, path.relative(config.memoryDir, filePath));
				return {
					content: [{ type: "text", text: `Appended to notes/${safe}` }],
					details: { path: filePath, target, mode: "append", sessionId: sid, timestamp: ts },
				};
			}

			if (target === "daily") {
				const date = todayStr(config.timezone);
				const filePath = dailyPath(config.dailyDir, date);
				const existing = readFileSafe(filePath) ?? "";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				writeFileAtomic(filePath, existing + separator + stamped);
				gitCommit(`daily: ${date}`, path.relative(config.memoryDir, filePath));
				return {
					content: [{ type: "text", text: `Appended to daily/${date}.md` }],
					details: { path: filePath, target, mode: "append", sessionId: sid, timestamp: ts },
				};
			}

			// long_term
			const existing = readFileSafe(config.memoryFile) ?? "";

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				writeFileAtomic(config.memoryFile, stamped);
				gitCommit("memory: overwrite", path.relative(config.memoryDir, config.memoryFile));
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md` }],
					details: { path: config.memoryFile, target, mode: "overwrite", sessionId: sid, timestamp: ts },
				};
			}

			const separator = existing.trim() ? "\n\n" : "";
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			writeFileAtomic(config.memoryFile, existing + separator + stamped);
			gitCommit("memory: append", path.relative(config.memoryDir, config.memoryFile));
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md` }],
				details: { path: config.memoryFile, target, mode: "append", sessionId: sid, timestamp: ts },
			};
		},
	});

	// scratchpad tool
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, {
				description: "What to do",
			}),
			text: Type.Optional(
				Type.String({ description: "Item text for add, or substring to match for done/undo" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs(config);
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(config.scratchpadFile) ?? "";
			let items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return { content: [{ type: "text", text: "Scratchpad is empty." }], details: {} };
				}
				return {
					content: [{ type: "text", text: serializeScratchpad(items) }],
					details: { count: items.length, open: items.filter((i) => !i.done).length },
				};
			}

			if (action === "add") {
				if (!text) {
					return { content: [{ type: "text", text: "Error: 'text' is required for add." }], details: {} };
				}
				items.push({ done: false, text, meta: `<!-- ${ts} [${sid}] -->` });
				writeFileAtomic(config.scratchpadFile, serializeScratchpad(items));
				gitCommit("scratchpad: add", path.relative(config.memoryDir, config.scratchpadFile));
				return {
					content: [{ type: "text", text: `Added: - [ ] ${text}\n\n${serializeScratchpad(items)}` }],
					details: { action, sessionId: sid, timestamp: ts },
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return { content: [{ type: "text", text: `Error: 'text' is required for ${action}.` }], details: {} };
				}
				try {
					const updated = toggleScratchpadItem(existing, text, action);
					writeFileAtomic(config.scratchpadFile, updated);
					gitCommit(`scratchpad: ${action}`, path.relative(config.memoryDir, config.scratchpadFile));
					return {
						content: [{ type: "text", text: `Updated.\n\n${updated}` }],
						details: { action, sessionId: sid, timestamp: ts },
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: e.message }],
						details: {},
					};
				}
			}

			if (action === "clear_done") {
				const before = items.length;
				items = items.filter((i) => !i.done);
				const removed = before - items.length;
				writeFileAtomic(config.scratchpadFile, serializeScratchpad(items));
				gitCommit("scratchpad: clear_done", path.relative(config.memoryDir, config.scratchpadFile));
				return {
					content: [{ type: "text", text: `Cleared ${removed} done item(s).\n\n${serializeScratchpad(items)}` }],
					details: { action, removed },
				};
			}

			return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {} };
		},
	});

	// memory_read tool
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'file': Read any file by exact path (e.g. 'SOUL.md', 'catchup/2026-04-26/file.md'). Pass filename. If the exact file is missing and the directory has an INDEX.md with <!-- file:... --> entries, I resolve by title/query within that index.",
			"- 'note': Read a file from notes/ (e.g. 'lessons.md'). Pass filename.",
			"- 'list': List all files in the memory directory.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "file", "note", "list"] as const, {
				description: "What to read",
			}),
			date: Type.Optional(
				Type.String({ description: "Date for daily log (YYYY-MM-DD). Default: today." }),
			),
			filename: Type.Optional(
				Type.String({ description: "Filename for 'file' target (e.g. 'lessons.md', 'SOUL.md')" }),
			),

		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs(config);
			const { target, date, filename } = params;

			if (target === "list") {
				const sections: string[] = [];
				try {
					const rootFiles = fs.readdirSync(config.memoryDir).filter(f => f.endsWith(".md") || f.endsWith(".json")).sort();
					if (rootFiles.length > 0) sections.push(`Files:\n${rootFiles.map(f => `- ${f}`).join("\n")}`);
				} catch (e: any) {
					if (!isExpectedError(e)) console.warn(`Cannot list memory dir: ${e.message}`);
				}
				try {
					const noteFiles = fs.readdirSync(config.notesDir).filter(f => f.endsWith(".md")).sort();
					if (noteFiles.length > 0) sections.push(`Notes:\n${noteFiles.map(f => `- notes/${f}`).join("\n")}`);
				} catch (e: any) {
					if (!isExpectedError(e)) console.warn(`Cannot list notes dir: ${e.message}`);
				}
				try {
					const dailyFiles = fs.readdirSync(config.dailyDir).filter(f => f.endsWith(".md")).sort().reverse();
					if (dailyFiles.length > 0) sections.push(`Daily logs (${dailyFiles.length}):\n${dailyFiles.slice(0, 10).map(f => `- daily/${f}`).join("\n")}${dailyFiles.length > 10 ? `\n  ... and ${dailyFiles.length - 10} more` : ""}`);
				} catch (e: any) {
					if (!isExpectedError(e)) console.warn(`Cannot list daily dir: ${e.message}`);
				}
				try {
					const catchupDir = path.join(config.memoryDir, "catchup");
					const catchupDates = fs.readdirSync(catchupDir).filter(f => {
						try { return fs.statSync(path.join(catchupDir, f)).isDirectory(); } catch { return false; }
					}).sort().reverse();
					if (catchupDates.length > 0) sections.push(`Catchup (${catchupDates.length} dates):\n${catchupDates.slice(0, 10).map(d => `- catchup/${d}/`).join("\n")}${catchupDates.length > 10 ? `\n  ... and ${catchupDates.length - 10} more` : ""}`);
				} catch (e: any) {
					if (!isExpectedError(e)) console.warn(`Cannot list catchup dir: ${e.message}`);
				}
				if (sections.length === 0) {
					return { content: [{ type: "text", text: "Memory directory is empty." }], details: {} };
				}
				return { content: [{ type: "text", text: sections.join("\n\n") }], details: {} };
			}

			if (target === "file") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'file'." }], details: {} };
				}
				const result = readMemoryFile(config, filename);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			}

			if (target === "note") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'note'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(config.notesDir, safe);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `Note not found: notes/${safe}` }], details: {} };
				}
				return { content: [{ type: "text", text: content }], details: { path: filePath, filename: `notes/${safe}` } };
			}

			if (target === "daily") {
				const d = date ?? todayStr(config.timezone);
				const filePath = dailyPath(config.dailyDir, d);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `No daily log for ${d}.` }], details: {} };
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: filePath, date: d },
				};
			}

			if (target === "scratchpad") {
				const content = readFileSafe(config.scratchpadFile);
				if (!content?.trim()) {
					return { content: [{ type: "text", text: "SCRATCHPAD.md is empty or does not exist." }], details: {} };
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: config.scratchpadFile },
				};
			}

			// long_term
			const content = readFileSafe(config.memoryFile);
			if (!content) {
				return { content: [{ type: "text", text: "MEMORY.md is empty or does not exist." }], details: {} };
			}
			return {
				content: [{ type: "text", text: content }],
				details: { path: config.memoryFile },
			};
		},
	});

	// memory_search tool
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs, notes/, and any other .md files).",
			"Matches filenames and file contents. Case-insensitive substring search (not keyword/tokenized).",
			"Returns matching files and lines with paths.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.String({ description: "Search query (case-insensitive substring match)" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum results to return (default: 20)", default: 20 }),
			),
		}),
		async execute(_toolCallId, params) {
			ensureDirs(config);
			const { query, max_results } = params;
			const limit = max_results ?? 20;

			const result = searchMemory(config, query, limit);

			if (result.fileMatches.length === 0 && result.lineResults.length === 0) {
				return { content: [{ type: "text", text: `No results for "${query}".` }], details: {} };
			}

			const parts: string[] = [];
			if (result.fileMatches.length > 0) {
				parts.push(`Files matching "${query}":\n${result.fileMatches.map(f => `- ${f}`).join("\n")}`);
			}
			if (result.lineResults.length > 0) {
				parts.push(`Content matches:\n${result.lineResults.map(r => `${r.file}:${r.line}: ${r.text}`).join("\n")}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { query, fileMatches: result.fileMatches.length, lineMatches: result.lineResults.length },
			};
		},
	});
}
