/**
 * Pure logic extracted from the memory extension for testability.
 * No pi API dependencies — just file I/O and string manipulation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// --- Config ---

export interface MemoryConfig {
	memoryDir: string;
	memoryFile: string;
	scratchpadFile: string;
	dailyDir: string;
	notesDir: string;
	contextFiles: string[];
	searchDirs: string[];
	autocommit: boolean;
	timezone: string;
}

export interface FileConfig {
	dailyDir?: string;
	contextFiles?: string[];
	searchDirs?: string[];
	autocommit?: boolean;
}

export function loadConfigFile(memoryDir: string): FileConfig {
	const configPath = path.join(memoryDir, ".pi-mem.json");
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const result: FileConfig = {};
			if (typeof parsed.dailyDir === "string") result.dailyDir = parsed.dailyDir;
			if (Array.isArray(parsed.contextFiles)) result.contextFiles = parsed.contextFiles.filter((s: unknown) => typeof s === "string");
			if (Array.isArray(parsed.searchDirs)) result.searchDirs = parsed.searchDirs.filter((s: unknown) => typeof s === "string");
			if (typeof parsed.autocommit === "boolean") result.autocommit = parsed.autocommit;
			return result;
		} catch (parseErr: any) {
			console.warn(`Invalid JSON in ${configPath}: ${parseErr.message}`);
			return {};
		}
	} catch (readErr: any) {
		if (readErr.code === 'ENOENT') return {};
		console.warn(`Cannot read ${configPath}: ${readErr.message}`);
		return {};
	}
}

function parseCommaSeparated(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const items = value.split(",").map(f => f.trim()).filter(Boolean);
	return items;
}

export function buildConfig(env: Record<string, string | undefined> = process.env): MemoryConfig {
	const memoryDir = env.PI_MEMORY_DIR ?? path.join(env.HOME ?? "~", ".pi", "agent", "memory");

	// Load config.json from memory dir (env vars override file values)
	const fileConfig = loadConfigFile(memoryDir);

	const dailyDir = env.PI_DAILY_DIR ?? fileConfig.dailyDir ?? path.join(memoryDir, "daily");
	const contextFiles = parseCommaSeparated(env.PI_CONTEXT_FILES) ?? fileConfig.contextFiles ?? [];
	const searchDirs = parseCommaSeparated(env.PI_SEARCH_DIRS) ?? fileConfig.searchDirs ?? [];
	const autocommit = env.PI_AUTOCOMMIT !== undefined
		? (env.PI_AUTOCOMMIT === "1" || env.PI_AUTOCOMMIT === "true")
		: (fileConfig.autocommit ?? false);
	const timezone = normalizeTimeZone(env.PI_TIMEZONE ?? env.TZ ?? "UTC");

	return {
		memoryDir,
		memoryFile: path.join(memoryDir, "MEMORY.md"),
		scratchpadFile: path.join(memoryDir, "SCRATCHPAD.md"),
		dailyDir,
		notesDir: path.join(memoryDir, "notes"),
		contextFiles,
		searchDirs,
		autocommit,
		timezone,
	};
}

export function normalizeTimeZone(timeZone: string | undefined): string {
	const candidate = timeZone?.trim() || "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
		return candidate;
	} catch {
		return "UTC";
	}
}

// --- Date/time helpers ---

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: normalizeTimeZone(timeZone),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
	return { year: values.year, month: values.month, day: values.day };
}

function formatDateParts(parts: { year: number; month: number; day: number }): string {
	return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function todayStr(timeZone = "UTC", now = new Date()): string {
	return formatDateParts(localDateParts(now, timeZone));
}

export function yesterdayStr(timeZone = "UTC", now = new Date()): string {
	return daysAgoStr(1, timeZone, now);
}

/** Get a date string N days ago from today. */
export function daysAgoStr(n: number, timeZone = "UTC", now = new Date()): string {
	const parts = localDateParts(now, timeZone);
	const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - n, 12, 0, 0, 0));
	return formatDateParts(localDateParts(shifted, timeZone));
}

export function nowTimestamp(): string {
	return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

// --- File helpers ---

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch (e: any) {
		if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
			console.warn(`Cannot read ${filePath}: ${e.message}`);
		}
		return null;
	}
}

export function dailyPath(dailyDir: string, date: string): string {
	return path.join(dailyDir, `${date}.md`);
}

export function writeFileAtomic(filePath: string, data: string): void {
	const dir = path.dirname(filePath);
	const tmpPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(tmpPath, data, "utf-8");
	fs.renameSync(tmpPath, filePath);
}

/** Validate and normalize a relative file path within the memory directory. Returns null if path escapes memoryDir. */
export function safeResolvePath(memoryDir: string, filename: string): { resolved: string; normalized: string } | null {
	const normalized = path.normalize(filename).replace(/^\/+/, "");
	if (normalized.startsWith("..") || path.isAbsolute(filename)) return null;
	return { resolved: path.join(memoryDir, normalized), normalized };
}

export interface MemoryReadResult {
	text: string;
	details: Record<string, unknown>;
}

export function readMemoryFile(config: MemoryConfig, filename: string): MemoryReadResult {
	const result = safeResolvePath(config.memoryDir, filename);
	if (!result) {
		return { text: `Invalid path: ${filename}`, details: { found: false, reason: "invalid_path" } };
	}
	const content = readFileSafe(result.resolved);
	if (content) {
		return { text: content, details: { path: result.resolved, filename: result.normalized } };
	}
	return { text: `File not found: ${result.normalized}`, details: { found: false, reason: "missing_file", filename: result.normalized } };
}

export function ensureDirs(config: MemoryConfig): void {
	fs.mkdirSync(config.memoryDir, { recursive: true });
	fs.mkdirSync(config.dailyDir, { recursive: true });
	fs.mkdirSync(config.notesDir, { recursive: true });
}

// --- Scratchpad ---

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string;
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
				if (lines[j].match(/^- \[([ xX])\] /)) break;
				if (lines[j].match(/^<!--.*-->$/)) {
					meta = lines[j];
					break;
				}
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function toggleScratchpadItem(content: string, search: string, action: 'done' | 'undo'): string {
	const items = parseScratchpad(content);
	const needle = search.toLowerCase();
	const targetDone = action === 'done';

	const matchIndices: number[] = [];
	for (let i = 0; i < items.length; i++) {
		if (items[i].done !== targetDone && items[i].text.toLowerCase().includes(needle)) {
			matchIndices.push(i);
		}
	}

	if (matchIndices.length === 0) {
		throw new Error(`No matching ${targetDone ? "open" : "done"} item found for: "${search}"`);
	}

	if (matchIndices.length > 1) {
		const matchTexts = matchIndices.map(i => `- ${items[i].done ? '[x]' : '[ ]'} ${items[i].text}`).join('\n');
		throw new Error(`Ambiguous match: "${search}" matches ${matchIndices.length} items:\n${matchTexts}`);
	}

	items[matchIndices[0]].done = targetDone;
	return serializeScratchpad(items);
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return lines.join("\n") + "\n";
}

// --- Memory snapshot builder ---

export function buildMemorySnapshot(config: MemoryConfig): string {
	ensureDirs(config);
	const sections: string[] = [];

	for (const fileName of config.contextFiles) {
		const filePath = path.join(config.memoryDir, fileName);
		const content = readFileSafe(filePath);
		if (content?.trim()) {
			sections.push(`## ${fileName}\n\n${content.trim()}`);
		}
	}

	const longTerm = readFileSafe(config.memoryFile);
	if (longTerm?.trim()) {
		sections.push(`## MEMORY.md (long-term)\n\n${longTerm.trim()}`);
	}

	const today = todayStr(config.timezone);
	const yesterday = yesterdayStr(config.timezone);

	const todayContent = readFileSafe(dailyPath(config.dailyDir, today));
	if (todayContent?.trim()) {
		sections.push(`## Daily log: ${today} (today)\n\n${todayContent.trim()}`);
	}

	const yesterdayContent = readFileSafe(dailyPath(config.dailyDir, yesterday));
	if (yesterdayContent?.trim()) {
		sections.push(`## Daily log: ${yesterday} (yesterday)\n\n${yesterdayContent.trim()}`);
	}

	const catchupDir = path.join(config.memoryDir, "catchup");
	for (let i = 0; i < 2; i++) {
		const date = daysAgoStr(i, config.timezone);
		const label = i === 0 ? "today" : "yesterday";
		const indexPath = path.join(catchupDir, date, "INDEX.md");
		const catchupContent = readFileSafe(indexPath)?.trim();
		if (catchupContent) {
			const header = `## Catchup: ${date} (${label})`;
			const hint = `_Read full details: memory_read(target='file', filename='catchup/${date}/FILENAME.md')_`;
			sections.push(`${header}\n${hint}\n\n${catchupContent}`);
		}
	}

	if (sections.length === 0) {
		return "";
	}

	return sections.join("\n\n---\n\n");
}

// --- Search ---

export interface SearchResult {
	fileMatches: string[];
	lineResults: { file: string; line: number; text: string }[];
}

export function searchMemory(config: MemoryConfig, query: string, maxResults: number = 20): SearchResult {
	const needle = query.toLowerCase();
	const fileMatches: string[] = [];
	const lineResults: { file: string; line: number; text: string }[] = [];

	function searchFile(filePath: string, displayName: string) {
		if (displayName.toLowerCase().includes(needle) && !fileMatches.includes(displayName)) {
			fileMatches.push(displayName);
		}
		const content = readFileSafe(filePath);
		if (!content) return;
		const lines = content.split("\n");
		for (let i = 0; i < lines.length && lineResults.length < maxResults; i++) {
			if (lines[i].toLowerCase().includes(needle)) {
				lineResults.push({ file: displayName, line: i + 1, text: lines[i].trimEnd() });
			}
		}
	}

	function searchDir(dir: string, prefix: string) {
		try {
			const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort();
			for (const f of files) {
				if (lineResults.length >= maxResults) break;
				searchFile(path.join(dir, f), prefix ? `${prefix}/${f}` : f);
			}
		} catch {}
	}

	searchDir(config.memoryDir, "");
	searchDir(config.dailyDir, "daily");
	searchDir(config.notesDir, "notes");

	// Search extra dirs configured via PI_SEARCH_DIRS
	for (const dirName of config.searchDirs) {
		if (lineResults.length >= maxResults) break;
		const dirPath = path.join(config.memoryDir, dirName);
		try {
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			// Search .md files directly in the dir
			const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith(".md"));
			for (const f of mdFiles) {
				if (lineResults.length >= maxResults) break;
				searchFile(path.join(dirPath, f.name), `${dirName}/${f.name}`);
			}
			// Search one level of subdirectories (e.g. catchup/2026-04-20/*.md)
			const subDirs = entries.filter(e => e.isDirectory());
			for (const sub of subDirs) {
				if (lineResults.length >= maxResults) break;
				searchDir(path.join(dirPath, sub.name), `${dirName}/${sub.name}`);
			}
		} catch {}
	}

	return { fileMatches, lineResults };
}
