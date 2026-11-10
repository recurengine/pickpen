// 库外文件（TExternalFile / file: 伪路径）不进入 Local Snapshot。
import { describe, expect, it, vi } from "vitest";
import { TExternalFile, TFile, TFolder, type Vault } from "obsidian";

import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { createSyncFilter, defaultSelectiveSettings, type SelectiveSettings } from "../src/sync/selective";
import type { Entry, Snapshot } from "../src/sync/types";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function tf(path: string, content: string): TFile {
	return Object.assign(new TFile(), {
		path,
		stat: { mtime: 1, size: enc(content).byteLength },
	}) as TFile;
}

function ext(path: string, content = "external"): TExternalFile {
	return Object.assign(new TExternalFile(), {
		path,
		stat: { mtime: 1, size: enc(content).byteLength },
	}) as TExternalFile;
}

function tdir(path: string): TFolder {
	return Object.assign(new TFolder(), { path }) as TFolder;
}

function fakeVault(
	files: TFile[],
	dirs: TFolder[],
	contents: Map<string, Uint8Array>,
): { vault: Vault; readBinary: ReturnType<typeof vi.fn> } {
	const readBinary = vi.fn(async (p: string) => contents.get(p) ?? new Uint8Array(0));
	return {
		readBinary,
		vault: {
			getFiles: () => files,
			getAllLoadedFiles: () => [...dirs, ...files] as TFile[],
			getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
			getAbstractFileByPath: (p: string) => [...dirs, ...files].find((f) => f.path === p) ?? null,
			adapter: { readBinary },
		} as unknown as Vault,
	};
}

function testFilter(over: Partial<SelectiveSettings> = {}) {
	const defaults = defaultSelectiveSettings();
	const allConfigOff = {
		app: false, appearance: false, appearanceData: false, hotkey: false,
		corePlugin: false, corePluginData: false, communityPlugin: false, communityPluginData: false,
	};
	return createSyncFilter({
		selective: { ...defaults, ...over, excludedFolders: over.excludedFolders ?? [], config: allConfigOff },
		configDir: ".obsidian",
		selfDir: ".obsidian/plugins/pickpen",
		selfId: "pickpen",
	});
}

function base(entries: Record<string, Entry>): Snapshot {
	return {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "r1",
		entries,
	};
}

function ctx(over: {
	vault: Vault;
	base?: Snapshot | null;
	dirtyPaths?: string[];
	forceAudit?: boolean;
}) {
	return {
		vault: over.vault,
		base: over.base ?? null,
		dirtyPaths: over.dirtyPaths ? new Set(over.dirtyPaths) : undefined,
		forceAudit: over.forceAudit ?? false,
		filter: testFilter(),
		caseInsensitive: false,
		isMobile: false,
		maxFileSizeBytes: 30 * 1024 * 1024,
		pathEncrypted: false,
	};
}

const externalActive: Entry = { state: "active", content_hash: "a".repeat(64), size: "10" };

describe("完整审计跳过库外文件", () => {
	it("TExternalFile（含路径不匹配的兜底）与 file: 伪目录都不进 entries、不读盘、不 blocked", async () => {
		const ok = tf("ok.md", "ok");
		const byPath = ext("file:/Users/a/x.md", "a");
		const byShape = ext("weird-name.md", "b"); // 类型信号兜底：即使 path 不像 file: 也跳过
		const folder = tdir("file:");
		const { vault, readBinary } = fakeVault(
			[ok, byPath, byShape],
			[folder, tdir("file:C:")],
			new Map([
				["ok.md", enc("ok")],
				["file:/Users/a/x.md", enc("a")],
				["weird-name.md", enc("b")],
			]),
		);
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(ctx({ vault, forceAudit: true }));

		expect(Object.keys(res.snapshot.entries).sort()).toEqual(["ok.md"]);
		expect(res.blockedDetails).toEqual([]);
		expect(readBinary.mock.calls.map((c) => c[0])).toEqual(["ok.md"]);
	});

	it("Base 含库外 active 时，完整审计不把它合成为本地删除", async () => {
		const { vault } = fakeVault([], [], new Map());
		const b = new LocalSnapshotBuilder();
		const previous = base({ "file:C:/Users/a.md": externalActive });
		const res = await b.refresh(ctx({ vault, base: previous, forceAudit: true }));

		expect(res.snapshot.entries["file:C:/Users/a.md"]).toBeUndefined();
		expect(res.blockedDetails).toEqual([]);
	});
});

describe("dirty 增量跳过库外文件", () => {
	it("外部路径不写入快照、不 blocked、不读盘", async () => {
		const { vault, readBinary } = fakeVault([], [], new Map());
		const b = new LocalSnapshotBuilder();
		await b.refresh(ctx({ vault, forceAudit: true })); // 初始化 current
		readBinary.mockClear();

		const res = await b.refresh(
			ctx({
				vault,
				dirtyPaths: ["file:C:/Users/a.md", "file:/Users/b.md"],
			}),
		);

		expect(res.snapshot.entries["file:C:/Users/a.md"]).toBeUndefined();
		expect(res.snapshot.entries["file:/Users/b.md"]).toBeUndefined();
		expect(res.blockedDetails).toEqual([]);
		expect(readBinary).not.toHaveBeenCalled();
	});
});

describe("冷启动 Base 清理", () => {
	it("从 Base 克隆的 current 会剔除库外条目，普通条目保留", async () => {
		const { vault } = fakeVault([], [], new Map());
		const b = new LocalSnapshotBuilder();
		const previous = base({
			"file:/Users/a/x.md": externalActive,
			"file:C:/Users/b.md": externalActive,
			"keep.md": externalActive,
		});

		// 无 forceAudit、无 dirty：走 Base 骨架快照
		const res = await b.refresh(ctx({ vault, base: previous }));

		expect(res.snapshot.entries["file:/Users/a/x.md"]).toBeUndefined();
		expect(res.snapshot.entries["file:C:/Users/b.md"]).toBeUndefined();
		expect(res.snapshot.entries["keep.md"]).toEqual(externalActive);
	});
});
