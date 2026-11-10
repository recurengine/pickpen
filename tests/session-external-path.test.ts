// 库外文件伪路径在 Session 层的处理：
// - Windows 盘符型 file:C:/... 自动清理远端（含祖先目录行），POSIX 型 file:/... 仅隐藏；
// - 均不进入 platformBlockedDetails（不再弹“文件名含不支持字符”）；
// - 清理 delete 跳过提交前本地复验；旧 pending 中的外部动作不落盘。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { PATH_MODE_PLAIN, treeRoot } from "../src/sync/path-codec";
import { ReconcileSession, type SyncStatus } from "../src/sync/session";
import type { BaseStore } from "../src/sync/base-store";
import type { PendingStore } from "../src/sync/pending-store";
import type { SnapshotRemote } from "../src/sync/remote";
import type { Entry, PendingLog, Snapshot } from "../src/sync/types";

const WIN_EXT = "file:C:/Users/Administrator/Downloads/100个思维模型.md";
const WIN_PARENT = "file:C:/Users";
const WIN_DIR = "file:C:";
const POSIX_EXT = "file:/Users/alber/Downloads/x.md";
const BAD = 'ima/课件/字课05"腠理".md';
const OK = "ok.md";
const A = "a".repeat(64);

const active = (hash = A, size = "10"): Entry => ({ state: "active", content_hash: hash, size });
const dir: Entry = { state: "active", kind: 2 };

function fakeDeps(overrides: {
	manifestEntries: Snapshot["entries"];
	headRoot: string;
	baseEntries?: Snapshot["entries"];
	unchanged?: boolean;
	pending?: PendingLog | null;
	files?: { path: string; stat: { mtime: number; size: number } }[];
	exists?: (path: string) => boolean;
	blob?: Uint8Array;
} = { manifestEntries: {}, headRoot: "r1" }) {
	const base: Snapshot = {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "r1",
		entries: overrides.baseEntries ?? {},
	};
	let pending = overrides.pending ?? null;
	const files = overrides.files ?? [];
	const writeBinary = vi.fn(async () => {});
	const readBinary = vi.fn(async () => new Uint8Array());
	const exists = vi.fn(async (p: string) => overrides.exists?.(p) ?? false);
	const head = {
		revision: 1n,
		rootHash: overrides.headRoot,
		unchanged: overrides.unchanged ?? false,
		syncIntervalMs: 0n,
		maxFileSizeBytes: 30n * 1024n * 1024n,
		localDebounceMs: 0n,
		pathEncryptionVersion: 0,
	};
	const saveBase = vi.fn(async () => {});
	const commitSnapshot = vi.fn(async () => ({
		revision: 2n,
		rootHash: overrides.headRoot,
		changed: true,
	}));
	const clear = vi.fn(async () => {
		pending = null;
	});
	return {
		saveBase,
		writeBinary,
		readBinary,
		exists,
		commitSnapshot,
		clear,
		deps: {
			app: {
				vault: {
					configDir: ".obsidian",
					adapter: {
						readBinary,
						writeBinary,
						stat: vi.fn(async () => null),
						read: vi.fn(async () => ""),
						exists,
						mkdir: vi.fn(async () => {}),
						rmdir: vi.fn(async () => {}),
					},
					getFiles: () => files,
					getAllLoadedFiles: () => [],
					getFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
					getAbstractFileByPath: () => null,
					trash: vi.fn(async () => {}),
				},
				workspace: { getLeavesOfType: () => [] },
			},
			getSettings: () => ({ accessToken: "t", vaultId: "42", deviceId: "dev-1" }),
			baseStore: {
				getBase: vi.fn(() => base as Snapshot | null),
				saveBase,
				reset: vi.fn(),
				flush: vi.fn(async () => {}),
			} as unknown as BaseStore,
			pendingStore: {
				getPending: () => pending,
				writePrepared: vi.fn(async () => {}),
				markCommitted: vi.fn(async () => {}),
				markApplying: vi.fn(async () => {}),
				clear,
			} as unknown as PendingStore,
			localBuilder: new LocalSnapshotBuilder(),
			pluginDir: ".obsidian/plugins/pickpen",
			pluginId: "pickpen",
			remote: {
				pollHead: vi.fn(async () => ({ ...head })),
				getHead: vi.fn(async () => ({ ...head })),
				getManifest: vi.fn(async () => ({
					revision: head.revision,
					rootHash: head.rootHash,
					vaultId: "42",
					entries: overrides.manifestEntries,
				})),
				hasBlobs: vi.fn(async () => new Set<string>()),
				putBlob: vi.fn(async () => {}),
				getBlob: vi.fn(async () => overrides.blob ?? new Uint8Array()),
				commitSnapshot,
			} as unknown as SnapshotRemote,
			caseInsensitive: false,
			onStatus: vi.fn(),
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function waitForIdle(session: ReconcileSession): Promise<void> {
	for (let i = 0; i < 200 && session.isRunning(); i++) await tick();
}

function statuses(deps: { onStatus: unknown }): SyncStatus[] {
	const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
	return onStatus.mock.calls.map((c) => c[0] as SyncStatus);
}

function lastStatus(deps: { onStatus: unknown }): SyncStatus {
	const all = statuses(deps);
	return all[all.length - 1];
}

describe("库外伪路径的远端清理", () => {
	let original: typeof Platform;
	beforeEach(() => {
		original = { ...Platform };
		Object.assign(Platform, { isWin: true });
	});
	afterEach(() => {
		Object.assign(Platform, original);
	});

	it("Windows 盘符型（含祖先目录）被删除；POSIX 型仅隐藏；真实非法名仍 blocked", async () => {
		const entries: Snapshot["entries"] = {
			[WIN_DIR]: dir,
			[WIN_PARENT]: dir,
			[WIN_EXT]: active(),
			[POSIX_EXT]: active(),
			[BAD]: active(),
		};
		const headRoot = await treeRoot(entries, PATH_MODE_PLAIN);
		const { deps, writeBinary, readBinary, exists, commitSnapshot } = fakeDeps({
			manifestEntries: entries,
			headRoot,
			// 模拟库外文件正被 Obsidian 打开：本地索引与磁盘都能看到它们
			files: [
				{ path: WIN_EXT, stat: { mtime: 1, size: 2 } },
				{ path: POSIX_EXT, stat: { mtime: 1, size: 2 } },
			],
			exists: (p) => p === WIN_EXT || p === POSIX_EXT,
		});
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(commitSnapshot).toHaveBeenCalledTimes(1);
		const commitArg = (commitSnapshot.mock.calls as unknown[][])[0][0] as {
			deletes: { path: string }[];
		};
		const deletes = commitArg.deletes.map((d) => d.path).sort();
		expect(deletes).toEqual([WIN_DIR, WIN_PARENT, WIN_EXT].sort());
		expect(writeBinary).not.toHaveBeenCalled();
		// 外部文件存在与否都不参与提交前复验，清理因此不会失败
		expect(exists).not.toHaveBeenCalledWith(WIN_EXT);
		expect(readBinary).not.toHaveBeenCalledWith(WIN_EXT);
		expect(readBinary).not.toHaveBeenCalledWith(POSIX_EXT);

		const status = lastStatus(deps);
		expect(status.lastError).toBe("");
		expect(status.blockedDetails).toEqual([{ path: BAD, reason: "path_invalid_on_platform" }]);
	});

	it("Head 未变且 Base 只有库外 active 时不会早退，清理仍执行", async () => {
		const entries: Snapshot["entries"] = { [WIN_EXT]: active() };
		const { deps, commitSnapshot } = fakeDeps({
			manifestEntries: entries,
			baseEntries: entries,
			headRoot: "r1",
			unchanged: true,
		});
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(commitSnapshot).toHaveBeenCalledTimes(1);
		const commitArg = (commitSnapshot.mock.calls as unknown[][])[0][0] as {
			deletes: { path: string; enc_path: string }[];
		};
		expect(commitArg.deletes).toEqual([{ path: WIN_EXT, enc_path: "" }]);
	});

	it("Base 只有 POSIX 型残留时不强制清理（可以正常早退）", async () => {
		const entries: Snapshot["entries"] = { [POSIX_EXT]: active() };
		const { deps, commitSnapshot } = fakeDeps({
			manifestEntries: entries,
			baseEntries: entries,
			headRoot: "r1",
			unchanged: true,
		});
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(commitSnapshot).not.toHaveBeenCalled();
		expect(lastStatus(deps).blockedDetails).toEqual([]);
	});
});

describe("pending 恢复中的库外伪路径", () => {
	let original: typeof Platform;
	beforeEach(() => {
		original = { ...Platform };
		Object.assign(Platform, { isWin: true });
	});
	afterEach(() => {
		Object.assign(Platform, original);
	});

	it("外部 write 全部跳过、不展示 blocked、计入 unverified；合法文件照常落地", async () => {
		const emptyHash = await sha256Hex(new Uint8Array());
		const entries: Snapshot["entries"] = {
			[WIN_EXT]: active(emptyHash, "0"),
			[POSIX_EXT]: active(emptyHash, "0"),
			[BAD]: active(emptyHash, "0"),
			[OK]: active(emptyHash, "0"),
		};
		const headRoot = await treeRoot(entries, PATH_MODE_PLAIN);
		const pending: PendingLog = {
			schema_version: 2,
			vault_id: "42",
			base_revision: "1",
			base_root_hash: "r1",
			target_root_hash: headRoot,
			phase: "applying",
			target_revision: "2",
			apply_actions: [
				{ kind: "write", path: WIN_EXT, content_hash: emptyHash, size: "0" },
				{ kind: "write", path: POSIX_EXT, content_hash: emptyHash, size: "0" },
				{ kind: "write", path: BAD, content_hash: emptyHash, size: "0" },
				{ kind: "write", path: OK, content_hash: emptyHash, size: "0" },
			],
			created_at: "2026-11-09T12:00:00Z",
		};
		const { deps, writeBinary, saveBase, clear } = fakeDeps({
			manifestEntries: entries,
			headRoot,
			unchanged: true,
			pending,
		});
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(writeBinary).toHaveBeenCalledTimes(1);
		expect(writeBinary).toHaveBeenCalledWith(OK, expect.anything());
		for (const p of [WIN_EXT, POSIX_EXT, BAD]) {
			expect(writeBinary).not.toHaveBeenCalledWith(p, expect.anything());
		}
		expect(clear).toHaveBeenCalled();

		const opts = (saveBase.mock.calls[0] as unknown[])[1] as {
			unverified: (path: string) => boolean;
		};
		expect(opts.unverified(WIN_EXT)).toBe(true);
		expect(opts.unverified(POSIX_EXT)).toBe(true);
		expect(opts.unverified(BAD)).toBe(true);

		// 恢复阶段的状态卡只把真实非法名列为 blocked，外部路径不能出现
		const blocked = statuses(deps)
			.flatMap((s) => s.blockedDetails)
			.map((d) => d.path);
		expect(blocked).toContain(BAD);
		expect(blocked).not.toContain(WIN_EXT);
		expect(blocked).not.toContain(POSIX_EXT);
	});
});
