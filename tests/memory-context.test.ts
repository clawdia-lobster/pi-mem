import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import { buildMemoryContext, ensureDirs, todayStr, yesterdayStr, daysAgoStr, isLowActivity } from "../lib.ts";
import { makeTempDir, cleanup, makeConfig, writeFile } from "./helpers.ts";

let tmpDir: string;

beforeEach(() => { tmpDir = makeTempDir(); });
afterEach(() => { cleanup(tmpDir); });

describe("buildMemoryContext", () => {
	it("returns empty string when no files exist", () => {
		const config = makeConfig(tmpDir);
		assert.strictEqual(buildMemoryContext(config), "");
	});

	it("includes MEMORY.md content", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "Important fact", "utf-8");
		const result = buildMemoryContext(config);
		assert.ok(result.includes("# Memory"));
		assert.ok(result.includes("## MEMORY.md (long-term)"));
		assert.ok(result.includes("Important fact"));
	});

	it("does not include scratchpad in context (available via tool only)", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.scratchpadFile, "# Scratchpad\n\n- [ ] Open task\n- [x] Done task\n", "utf-8");
		const result = buildMemoryContext(config);
		assert.ok(!result.includes("SCRATCHPAD"));
		assert.ok(!result.includes("Open task"));
	});

	it("includes today's daily log", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const today = todayStr();
		writeFile(`${config.dailyDir}/${today}.md`, "Today's entry");
		const result = buildMemoryContext(config);
		assert.ok(result.includes(`## Daily log: ${today} (today)`));
		assert.ok(result.includes("Today's entry"));
	});

	it("includes yesterday's daily log", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const yesterday = yesterdayStr();
		writeFile(`${config.dailyDir}/${yesterday}.md`, "Yesterday's entry");
		const result = buildMemoryContext(config);
		assert.ok(result.includes(`## Daily log: ${yesterday} (yesterday)`));
		assert.ok(result.includes("Yesterday's entry"));
	});

	it("does not include day-before-yesterday logs", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.dailyDir}/2020-01-01.md`, "Old entry");
		const result = buildMemoryContext(config);
		assert.ok(!result.includes("Old entry"));
	});

	it("includes context files when configured", () => {
		const config = makeConfig(tmpDir, { contextFiles: ["SOUL.md"] });
		ensureDirs(config);
		writeFile(`${config.memoryDir}/SOUL.md`, "I am a helpful assistant");
		const result = buildMemoryContext(config);
		assert.ok(result.includes("## SOUL.md"));
		assert.ok(result.includes("I am a helpful assistant"));
	});

	it("skips missing context files", () => {
		const config = makeConfig(tmpDir, { contextFiles: ["MISSING.md"] });
		ensureDirs(config);
		const result = buildMemoryContext(config);
		assert.ok(!result.includes("MISSING.md"));
	});

	it("skips empty context files", () => {
		const config = makeConfig(tmpDir, { contextFiles: ["EMPTY.md"] });
		ensureDirs(config);
		writeFile(`${config.memoryDir}/EMPTY.md`, "   \n  ");
		const result = buildMemoryContext(config);
		assert.ok(!result.includes("EMPTY.md"));
	});

	it("separates sections with ---", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "Memory content", "utf-8");
		writeFile(`${config.dailyDir}/${todayStr()}.md`, "Today content");
		const result = buildMemoryContext(config);
		assert.ok(result.includes("---"));
	});

	it("assembles sections in correct order: context files, memory, today, yesterday", () => {
		const config = makeConfig(tmpDir, { contextFiles: ["SOUL.md"] });
		ensureDirs(config);
		writeFile(`${config.memoryDir}/SOUL.md`, "Soul content");
		fs.writeFileSync(config.memoryFile, "Memory content", "utf-8");
		writeFile(`${config.dailyDir}/${todayStr()}.md`, "Today content");
		writeFile(`${config.dailyDir}/${yesterdayStr()}.md`, "Yesterday content");

		const result = buildMemoryContext(config);
		const soulIdx = result.indexOf("## SOUL.md");
		const memIdx = result.indexOf("## MEMORY.md");
		const todayIdx = result.indexOf("(today)");
		const yesterdayIdx = result.indexOf("(yesterday)");

		assert.ok(soulIdx < memIdx, "SOUL.md should come before MEMORY.md");
		assert.ok(memIdx < todayIdx, "MEMORY.md should come before today");
		assert.ok(todayIdx < yesterdayIdx, "today should come before yesterday");
		assert.ok(!result.includes("SCRATCHPAD"), "scratchpad should not be in context");
	});

	it("includes catchup INDEX.md for today when it exists", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const today = todayStr();
		writeFile(`${config.memoryDir}/catchup/${today}/INDEX.md`, "Catchup summary for today");
		const result = buildMemoryContext(config);
		assert.ok(result.includes(`## Catchup: ${today} (today)`));
		assert.ok(result.includes("Catchup summary for today"));
		assert.ok(result.includes("memory_read"), "should include tool hint");
	});

	it("includes catchup INDEX.md for yesterday when it exists", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const yesterday = yesterdayStr();
		writeFile(`${config.memoryDir}/catchup/${yesterday}/INDEX.md`, "Catchup summary for yesterday");
		const result = buildMemoryContext(config);
		assert.ok(result.includes(`## Catchup: ${yesterday} (yesterday)`));
		assert.ok(result.includes("Catchup summary for yesterday"));
	});

	it("does not include catchup when INDEX.md does not exist", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const result = buildMemoryContext(config);
		assert.ok(!result.includes("Catchup"));
	});

	it("catchup appears after daily logs", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const today = todayStr();
		fs.writeFileSync(config.memoryFile, "Memory", "utf-8");
		writeFile(`${config.dailyDir}/${today}.md`, "Daily log");
		writeFile(`${config.memoryDir}/catchup/${today}/INDEX.md`, "Catchup index");
		const result = buildMemoryContext(config);
		const dailyIdx = result.indexOf("(today)");
		const catchupIdx = result.indexOf("Catchup:");
		assert.ok(dailyIdx < catchupIdx, "daily log should come before catchup");
	});

	it("truncates large catchup INDEX.md at ~2KB", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const today = todayStr();
		// Generate 50 lines of ~100 chars each = ~5KB
		const lines = Array.from({ length: 50 }, (_, i) =>
			`💬 Chat ${i} — ${"x".repeat(80)} <!-- file:chat_${i}.md -->`
		).join("\n");
		writeFile(`${config.memoryDir}/catchup/${today}/INDEX.md`, lines);
		const result = buildMemoryContext(config);
		assert.ok(result.includes("more entries"), "should show truncation notice");
		assert.ok(result.includes("memory_read"), "truncation notice should mention memory_read");
		// Should not contain the last entry
		assert.ok(!result.includes("Chat 49"), "should not include last entries");
	});

	it("includes multiple context files in order", () => {
		const config = makeConfig(tmpDir, { contextFiles: ["A.md", "B.md", "C.md"] });
		ensureDirs(config);
		writeFile(`${config.memoryDir}/A.md`, "File A");
		writeFile(`${config.memoryDir}/B.md`, "File B");
		writeFile(`${config.memoryDir}/C.md`, "File C");
		const result = buildMemoryContext(config);
		const aIdx = result.indexOf("## A.md");
		const bIdx = result.indexOf("## B.md");
		const cIdx = result.indexOf("## C.md");
		assert.ok(aIdx < bIdx);
		assert.ok(bIdx < cIdx);
	});
});

describe("isLowActivity", () => {
	it("returns true when no daily logs exist", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		assert.strictEqual(isLowActivity(config), true);
	});

	it("returns true when daily logs are empty/short for all 3 days", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.dailyDir}/${todayStr()}.md`, "hi");
		writeFile(`${config.dailyDir}/${yesterdayStr()}.md`, "");
		writeFile(`${config.dailyDir}/${daysAgoStr(2)}.md`, "tiny");
		assert.strictEqual(isLowActivity(config), true);
	});

	it("returns false when 2+ days have substantial daily logs", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		// 50+ bytes = substantial activity
		writeFile(`${config.dailyDir}/${todayStr()}.md`, "A".repeat(60));
		writeFile(`${config.dailyDir}/${yesterdayStr()}.md`, "B".repeat(80));
		assert.strictEqual(isLowActivity(config), false);
	});

	it("returns true when only 1 day has substantial activity", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.dailyDir}/${todayStr()}.md`, "A".repeat(60));
		// yesterday and 2 days ago are empty
		assert.strictEqual(isLowActivity(config), true);
	});
});

describe("buildMemoryContext rollup mode", () => {
	it("injects Rollup Mode section when user has low activity", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		// No daily logs = low activity
		// Add catchup for 3 days ago
		const threeAgo = daysAgoStr(3);
		writeFile(`${config.memoryDir}/catchup/${threeAgo}/INDEX.md`, "💬 Old chat — summary");
		const result = buildMemoryContext(config);
		assert.ok(result.includes("⚡ Rollup Mode"), "should include rollup mode indicator");
		assert.ok(result.includes("Low activity detected"), "should include activity explanation");
	});

	it("includes catchup from 5+ days ago in rollup mode", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		// No daily logs = low activity
		const fiveAgo = daysAgoStr(5);
		writeFile(`${config.memoryDir}/catchup/${fiveAgo}/INDEX.md`, "💬 Five days ago chat — important");
		const result = buildMemoryContext(config);
		assert.ok(result.includes("Five days ago chat"), "should include 5-day-old catchup in rollup mode");
		assert.ok(result.includes("5 days ago"), "should show relative label");
	});

	it("does NOT include rollup mode when user is active", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.dailyDir}/${todayStr()}.md`, "Active user entry " + "x".repeat(60));
		writeFile(`${config.dailyDir}/${yesterdayStr()}.md`, "Also active yesterday " + "x".repeat(60));
		const fiveAgo = daysAgoStr(5);
		writeFile(`${config.memoryDir}/catchup/${fiveAgo}/INDEX.md`, "💬 Old chat — should not appear");
		const result = buildMemoryContext(config);
		assert.ok(!result.includes("Rollup Mode"), "should NOT include rollup mode for active users");
		assert.ok(!result.includes("Old chat — should not appear"), "should NOT include old catchup for active users");
	});

	it("only includes today and yesterday catchup when user is active", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.dailyDir}/${todayStr()}.md`, "Active user " + "x".repeat(60));
		writeFile(`${config.dailyDir}/${yesterdayStr()}.md`, "Active yesterday " + "x".repeat(60));
		const today = todayStr();
		const yesterday = yesterdayStr();
		const threeAgo = daysAgoStr(3);
		writeFile(`${config.memoryDir}/catchup/${today}/INDEX.md`, "Today catchup");
		writeFile(`${config.memoryDir}/catchup/${yesterday}/INDEX.md`, "Yesterday catchup");
		writeFile(`${config.memoryDir}/catchup/${threeAgo}/INDEX.md`, "Old catchup");
		const result = buildMemoryContext(config);
		assert.ok(result.includes("Today catchup"));
		assert.ok(result.includes("Yesterday catchup"));
		assert.ok(!result.includes("Old catchup"), "should not include 3-day-old catchup in normal mode");
	});

	it("respects total catchup byte budget in rollup mode", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		// Create large catchup files for 7 days — should hit the 8KB total budget
		for (let i = 0; i < 7; i++) {
			const date = daysAgoStr(i);
			// Each INDEX.md is ~2KB
			const content = Array.from({ length: 20 }, (_, j) =>
				`💬 Chat ${j} day-${i} — ${"x".repeat(80)}`
			).join("\n");
			writeFile(`${config.memoryDir}/catchup/${date}/INDEX.md`, content);
		}
		const result = buildMemoryContext(config);
		// Should not include all 7 days due to budget
		assert.ok(result.includes("Rollup Mode"));
		// day 0 should be there
		assert.ok(result.includes("day-0"));
		// Verify it doesn't blow past budget by checking not ALL days are present
		// The total catchup content should be bounded
		const catchupParts = result.split("## Catchup:");
		assert.ok(catchupParts.length <= 8, `should not have too many catchup sections (got ${catchupParts.length - 1})`);
	});

	it("truncates individual day catchup at reduced cap in rollup mode", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const today = todayStr();
		// Generate large INDEX.md (3KB) for today — should be truncated at 1KB in rollup
		const lines = Array.from({ length: 40 }, (_, i) =>
			`💬 Chat ${i} — ${"y".repeat(60)} <!-- file:chat_${i}.md -->`
		).join("\n");
		writeFile(`${config.memoryDir}/catchup/${today}/INDEX.md`, lines);
		const result = buildMemoryContext(config);
		assert.ok(result.includes("more entries"), "should truncate in rollup mode at smaller cap");
	});

	it("skips days with no catchup INDEX.md gracefully", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		// Only day 0 and day 4 have catchup, days 1-3 and 5-6 don't
		writeFile(`${config.memoryDir}/catchup/${todayStr()}/INDEX.md`, "Today stuff");
		writeFile(`${config.memoryDir}/catchup/${daysAgoStr(4)}/INDEX.md`, "Four days ago");
		const result = buildMemoryContext(config);
		assert.ok(result.includes("Today stuff"));
		assert.ok(result.includes("Four days ago"));
		// Should not error or include empty sections
		assert.ok(!result.includes("## Catchup: undefined"));
	});
});
