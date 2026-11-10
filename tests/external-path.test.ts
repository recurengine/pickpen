// 库外文件（Obsidian 1.14.4+ TExternalFile）伪路径识别、同步范围排除与远端安全清理。
// 覆盖 path 谓词、selective 口径、planner 的 remoteCleanupPaths 顺序与边界。
import { describe, expect, it } from "vitest";

import {
	collectExternalCleanupPaths,
	isExternalCleanupCandidate,
	isExternalPath,
	restoreRejectReason,
} from "../src/sync/path";
import { plan } from "../src/sync/planner";
import { createSyncFilter, defaultSelectiveSettings } from "../src/sync/selective";
import type { Entry, Snapshot } from "../src/sync/types";

const A = "a".repeat(64);
const B = "b".repeat(64);

const active = (hash = A, size = "10"): Entry => ({ state: "active", content_hash: hash, size });
const dir: Entry = { state: "active", kind: 2 };
const deleted: Entry = { state: "deleted" };

function snap(entries: Record<string, Entry>): Snapshot {
	return {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "root-1",
		entries,
	};
}

function syncFilter() {
	const d = defaultSelectiveSettings();
	return createSyncFilter({
		selective: { ...d, excludedFolders: [] },
		configDir: ".obsidian",
		selfDir: ".obsidian/plugins/pickpen",
		selfId: "pickpen",
	});
}

function runPlan(
	base: Snapshot | null,
	local: Snapshot,
	remote: Snapshot,
	remoteCleanupPaths: string[] = [],
	remoteOversizedPaths: string[] = [],
) {
	return plan({
		base,
		local,
		remote,
		deviceId: "dev-1",
		filter: syncFilter(),
		remoteCleanupPaths,
		remoteOversizedPaths,
		now: new Date("2026-11-09T12:00:00Z"),
	});
}

describe("isExternalPath（宽口径：所有库外伪路径）", () => {
	it("命中 Obsidian TExternalFile 的路径形状与目录行", () => {
		for (const p of [
			"file:",
			"file:C:",
			"file:/Users/a/x.md",
			"file:C:/Users/a/x.md",
			"file:C:\\Users\\a\\x.md",
			"file:/C:/Users/a.md",
			"file:C:/Users",
		]) {
			expect(isExternalPath(p), p).toBe(true);
		}
	});

	it("不误伤普通名字与嵌套路径", () => {
		for (const p of [
			"file:Cat.md",
			"file:C",
			"file:1:/x",
			"notes/file:/x",
			"files:/x",
			"xfile:/x",
			"File:/x", // 大小写敏感：Obsidian 生成的是小写 file:
			"file:./x",
			"Users/a/x.md",
		]) {
			expect(isExternalPath(p), p).toBe(false);
		}
	});
});

describe("isExternalCleanupCandidate / collectExternalCleanupPaths（窄口径：只清 Windows 盘符型）", () => {
	it("只把 file:C:/... 形态视为可自动清理", () => {
		for (const p of ["file:C:/Users/a/x.md", "file:C:\\Users\\a\\x.md", "file:C:/Users"]) {
			expect(isExternalCleanupCandidate(p), p).toBe(true);
		}
		for (const p of ["file:/Users/a/x.md", "file:", "file:C:", "file:Cat.md", "notes/file:C:/x"]) {
			expect(isExternalCleanupCandidate(p), p).toBe(false);
		}
	});

	it("补齐集合中实际存在的祖先行，且不把 POSIX 型加入", () => {
		const paths = [
			"file:C:/Users/a/x.md",
			"file:C:/Users",
			"file:C:",
			"file:",
			"file:/Users/b/y.md",
			"file:/Users",
			"normal.md",
		];
		expect(collectExternalCleanupPaths(paths).sort()).toEqual([
			"file:C:",
			"file:C:/Users",
			"file:C:/Users/a/x.md",
		]);
	});

	it("入参里不存在的祖先不返回", () => {
		expect(collectExternalCleanupPaths(["file:C:/Users/a/x.md"])).toEqual(["file:C:/Users/a/x.md"]);
	});
});

describe("restoreRejectReason", () => {
	it("库外路径优先于平台非法判定", () => {
		expect(restoreRejectReason("file:C:/Users/a.md", true)).toBe("external");
		expect(restoreRejectReason('a"b.md', true)).toBe("platform");
		expect(restoreRejectReason("normal.md", true)).toBeNull();
		expect(restoreRejectReason('a"b.md', false)).toBeNull(); // 仅 Windows 检查平台字符
	});
});

describe("selective.isExcluded：库外路径永不进入同步范围", () => {
	const f = syncFilter();

	it("文件与目录视角都排除", () => {
		expect(f.isExcluded("file:/Users/a/x.md")).toBe(true);
		expect(f.isExcluded("file:C:/Users/a/x.md")).toBe(true);
		expect(f.isExcluded("file:C:/Users", true)).toBe(true);
		expect(f.isExcluded("file:", true)).toBe(true);
	});

	it("普通名字不受影响", () => {
		expect(f.isExcluded("file:Cat.md")).toBe(false);
		expect(f.isExcluded("notes/file:/x.md")).toBe(false);
	});
});

describe("planner.remoteCleanupPaths：只删远端，不产生本地动作", () => {
	it("远端 active 库外路径 → delete + target tombstone，无 apply_actions", () => {
		const p = runPlan(null, snap({}), snap({ "file:C:/Users/a.md": active() }), ["file:C:/Users/a.md"]);
		expect(p.deletes).toEqual(["file:C:/Users/a.md"]);
		expect(p.target_entries["file:C:/Users/a.md"]).toEqual({ state: "deleted", kind: undefined });
		expect(p.apply_actions).toEqual([]);
		expect(p.puts).toEqual([]);
	});

	it("清理必须排在 excluded 之前：isExcluded 命中时仍会删除", () => {
		const path = "file:C:/Users/a.md";
		expect(syncFilter().isExcluded(path)).toBe(true);
		const p = runPlan(null, snap({}), snap({ [path]: active() }), [path]);
		expect(p.deletes).toEqual([path]);
	});

	it("未列入 cleanup 的 POSIX 型路径只被 excluded 跳过，远端保留", () => {
		const path = "file:/Users/a.md";
		const p = runPlan(null, snap({}), snap({ [path]: active() }));
		expect(p.deletes).toEqual([]);
		expect(p.target_entries[path]).toEqual(active());
		expect(p.apply_actions).toEqual([]);
	});

	it("远端已是 tombstone → 不重复提交 delete", () => {
		const path = "file:C:/Users/a.md";
		const p = runPlan(null, snap({}), snap({ [path]: deleted }), [path]);
		expect(p.deletes).toEqual([]);
		expect(p.target_entries[path]).toEqual(deleted);
	});

	it("远端不存在该路径 → 不产生 delete", () => {
		const p = runPlan(null, snap({}), snap({}), ["file:C:/Users/a.md"]);
		expect(p.deletes).toEqual([]);
		expect(p.target_entries["file:C:/Users/a.md"]).toBeUndefined();
	});

	it("清理优先于远端超限分支（超限条目也能直接删）", () => {
		const path = "file:C:/Users/big.md";
		const p = runPlan(
			null,
			snap({}),
			snap({ [path]: active(A, "999999") }),
			[path],
			[path],
		);
		expect(p.deletes).toEqual([path]);
		expect(p.target_entries[path].state).toBe("deleted");
	});

	it("目录行祖先一并清理，普通路径不受影响", () => {
		const p = runPlan(
			null,
			snap({}),
			snap({
				"file:C:": dir,
				"file:C:/Users": dir,
				"file:C:/Users/a.md": active(),
				"ok.md": active(B),
			}),
			["file:C:", "file:C:/Users", "file:C:/Users/a.md"],
		);
		expect(p.deletes.sort()).toEqual(["file:C:", "file:C:/Users", "file:C:/Users/a.md"]);
		expect(p.target_entries["file:C:"].state).toBe("deleted");
		expect(p.target_entries["file:C:/Users"].state).toBe("deleted");
		expect(p.target_entries["file:C:/Users/a.md"].state).toBe("deleted");
		// Base 缺失 + 远端正常文件 → Bootstrap 下载，不受清理影响
		expect(p.apply_actions).toEqual([{ kind: "write", path: "ok.md", content_hash: B, size: "10" }]);
	});
});
