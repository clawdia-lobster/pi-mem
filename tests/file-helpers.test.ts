import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSafe, ensureDirs, safeResolvePath, writeFileAtomic, readMemoryFile } from "../lib.ts";
import { makeTempDir, cleanup, makeConfig, writeFile } from "./helpers.ts";

let tmpDir: string;

beforeEach(() => { tmpDir = makeTempDir(); });
afterEach(() => { cleanup(tmpDir); });

describe("readFileSafe", () => {
	it("reads an existing file", () => {
		const filePath = path.join(tmpDir, "test.md");
		fs.writeFileSync(filePath, "hello world", "utf-8");
		assert.strictEqual(readFileSafe(filePath), "hello world");
	});

	it("returns null for non-existent file", () => {
		assert.strictEqual(readFileSafe(path.join(tmpDir, "nope.md")), null);
	});

	it("returns null for directory path", () => {
		assert.strictEqual(readFileSafe(tmpDir), null);
	});

	it("reads empty file as empty string", () => {
		const filePath = path.join(tmpDir, "empty.md");
		fs.writeFileSync(filePath, "", "utf-8");
		assert.strictEqual(readFileSafe(filePath), "");
	});

	it("reads file with unicode content", () => {
		const filePath = path.join(tmpDir, "unicode.md");
		fs.writeFileSync(filePath, "Hello \u2192 World \ud83d\ude80", "utf-8");
		assert.strictEqual(readFileSafe(filePath), "Hello \u2192 World \ud83d\ude80");
	});
});

describe("ensureDirs", () => {
	it("creates all directories", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		assert.ok(fs.existsSync(config.memoryDir));
		assert.ok(fs.existsSync(config.dailyDir));
		assert.ok(fs.existsSync(config.notesDir));
	});

	it("is idempotent — calling twice doesn't throw", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		ensureDirs(config);
		assert.ok(fs.existsSync(config.memoryDir));
	});

	it("doesn't destroy existing files in directories", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const testFile = path.join(config.memoryDir, "existing.md");
		fs.writeFileSync(testFile, "keep me", "utf-8");
		ensureDirs(config);
		assert.strictEqual(fs.readFileSync(testFile, "utf-8"), "keep me");
	});
});

describe("writeFileAtomic", () => {
	it("writes file that can be read back", () => {
		const filePath = path.join(tmpDir, "atomic.md");
		writeFileAtomic(filePath, "atomic content");
		assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "atomic content");
	});

	it("overwrites existing file", () => {
		const filePath = path.join(tmpDir, "atomic.md");
		fs.writeFileSync(filePath, "old", "utf-8");
		writeFileAtomic(filePath, "new");
		assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "new");
	});

	it("does not leave temp files behind", () => {
		const filePath = path.join(tmpDir, "atomic.md");
		writeFileAtomic(filePath, "content");
		const files = fs.readdirSync(tmpDir);
		assert.ok(!files.some(f => f.startsWith(".tmp-")));
	});
});

describe("safeResolvePath", () => {
	it("allows simple filenames", () => {
		const result = safeResolvePath("/mem", "SOUL.md");
		assert.ok(result);
		assert.strictEqual(result.normalized, "SOUL.md");
		assert.strictEqual(result.resolved, path.join("/mem", "SOUL.md"));
	});

	it("allows subdirectory paths", () => {
		const result = safeResolvePath("/mem", "catchup/2026-04-26/file.md");
		assert.ok(result);
		assert.strictEqual(result.normalized, "catchup/2026-04-26/file.md");
		assert.strictEqual(result.resolved, path.join("/mem", "catchup/2026-04-26/file.md"));
	});

	it("blocks .. traversal", () => {
		assert.strictEqual(safeResolvePath("/mem", "../etc/passwd"), null);
	});

	it("blocks nested .. traversal", () => {
		assert.strictEqual(safeResolvePath("/mem", "foo/../../etc/passwd"), null);
	});

	it("blocks deep nested .. traversal", () => {
		assert.strictEqual(safeResolvePath("/mem", "catchup/2026/../../../etc/passwd"), null);
	});

	it("blocks absolute paths", () => {
		assert.strictEqual(safeResolvePath("/mem", "/etc/passwd"), null);
	});

	it("allows paths that resolve within memoryDir after normalization", () => {
		const result = safeResolvePath("/mem", "catchup/2026/../2026/file.md");
		assert.ok(result);
		assert.strictEqual(result.normalized, "catchup/2026/file.md");
	});
});

describe("readMemoryFile", () => {
	it("reads existing file and returns content with details", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(path.join(config.memoryDir, "SOUL.md"), "soul content", "utf-8");
		const result = readMemoryFile(config, "SOUL.md");
		assert.strictEqual(result.text, "soul content");
		assert.strictEqual(result.details.found, undefined);
		assert.strictEqual(result.details.filename, "SOUL.md");
		assert.ok(result.details.path?.includes("SOUL.md"));
	});

	it("returns error text for non-existent file", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const result = readMemoryFile(config, "NOPE.md");
		assert.strictEqual(result.text, "File not found: NOPE.md");
		assert.strictEqual(result.details.found, false);
		assert.strictEqual(result.details.reason, "missing_file");
		assert.strictEqual(result.details.filename, "NOPE.md");
	});

	it("returns error text for invalid path traversal", () => {
		const config = makeConfig(tmpDir);
		const result = readMemoryFile(config, "../etc/passwd");
		assert.strictEqual(result.text, "Invalid path: ../etc/passwd");
		assert.strictEqual(result.details.found, false);
		assert.strictEqual(result.details.reason, "invalid_path");
	});

	it("reads file in subdirectory", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const subdir = path.join(config.memoryDir, "notes");
		fs.mkdirSync(subdir, { recursive: true });
		fs.writeFileSync(path.join(subdir, "lessons.md"), "lesson content", "utf-8");
		const result = readMemoryFile(config, "notes/lessons.md");
		assert.strictEqual(result.text, "lesson content");
		assert.strictEqual(result.details.filename, "notes/lessons.md");
	});
});
