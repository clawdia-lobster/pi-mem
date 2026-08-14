import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { gitCommit } from "../lib.ts";
import { makeTempDir, cleanup, writeFile, makeConfig } from "./helpers.ts";

function initRepo(dir: string): void {
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

function commitCount(dir: string): number {
	try {
		const out = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		return parseInt(out.trim(), 10);
	} catch {
		return 0; // no commits yet
	}
}

function withCapturedWarnings(fn: () => void): string[] {
	const warnings: string[] = [];
	const orig = console.warn;
	console.warn = (msg: unknown) => warnings.push(String(msg));
	try { fn(); } finally { console.warn = orig; }
	return warnings;
}

describe("gitCommit", () => {
	let dir = "";
	afterEach(() => { if (dir) cleanup(dir); });

	it("stages and commits the given file", () => {
		dir = makeTempDir();
		initRepo(dir);
		const config = makeConfig(dir, { autocommit: true, memoryDir: dir });
		writeFile(path.join(dir, "daily", "2026-01-01.md"), "entry");
		gitCommit(config, "daily: 2026-01-01", "daily/2026-01-01.md");
		assert.strictEqual(commitCount(dir), 1);
		const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf-8" });
		assert.ok(files.includes("daily/2026-01-01.md"));
	});

	it("treats 'nothing to commit' as success (concurrent session swept the index)", () => {
		dir = makeTempDir();
		initRepo(dir);
		const config = makeConfig(dir, { autocommit: true, memoryDir: dir });
		writeFile(path.join(dir, "daily", "2026-01-01.md"), "entry");
		gitCommit(config, "daily: 2026-01-01", "daily/2026-01-01.md");
		// Second call with unchanged file: git add is a no-op and commit exits 1
		// with "nothing to commit" — this is the concurrent-commit race and must
		// not warn.
		const warnings = withCapturedWarnings(() =>
			gitCommit(config, "daily: 2026-01-01", "daily/2026-01-01.md"));
		assert.deepStrictEqual(warnings, []);
		assert.strictEqual(commitCount(dir), 1);
	});

	it("is a no-op when autocommit is disabled", () => {
		dir = makeTempDir();
		initRepo(dir);
		const config = makeConfig(dir, { autocommit: false, memoryDir: dir });
		writeFile(path.join(dir, "MEMORY.md"), "fact");
		gitCommit(config, "memory: append", "MEMORY.md");
		assert.strictEqual(commitCount(dir), 0);
	});
});
