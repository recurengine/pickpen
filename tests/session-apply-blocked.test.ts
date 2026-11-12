// pending 恢复遇到系统拒绝写入（EPERM）：
// - 失败文件被隔离，本轮不再继续正常同步，pending 保留
// - 状态卡展示为未同步（write_failed），不把 EPERM 当成整轮崩溃
// - 不写 Base、不清 pending，下一轮/手动同步继续重试
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { ReconcileSession } from "../src/sync/session";
import type { BaseStore } from "../src/sync/base-store";
import type { PendingStore } from "../src/sync/pending-store";
import type { SnapshotRemote } from "../src/sync/remote";
import type { PendingLog } from "../src/sync/types";

const enc = new TextEncoder();

function fsError(code: string): Error & { code: string } {
	return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

function fakeDeps(content: Uint8Array, pending: PendingLog) {
	let pendingState: PendingLog | null = pending;
	const writeBinary = vi.fn(async (path: string) => {
		if (path === "core.json") throw fsError("EPERM");
	});
	const saveBase = vi.fn(async () => {});
	const clear = vi.fn(async () => {
		pendingState = null;
	});
	const commitSnapshot = vi.fn(async () => ({ revision: 2n, rootHash: "r2", changed: true }));
	const head = {
		revision: 1n,
		rootHash: "r1",
		unchanged: false,
		syncIntervalMs: 0n,
		maxFileSizeBytes: 30n * 1024n * 1024n,
		localDebounceMs: 0n,
		pathEncryptionVersion: 0,
	};
	return {
		writeBinary,
		saveBase,
		clear,
		commitSnapshot,
		deps: {
			app: {
				vault: {
					configDir: ".obsidian",
					adapter: {
						readBinary: vi.fn(async () => content),
						writeBinary,
						stat: vi.fn(async () => null),
						read: vi.fn(async () => ""),
						exists: vi.fn(async () => false),
						mkdir: vi.fn(async () => {}),
						rmdir: vi.fn(async () => {}),
					},
					getFiles: () => [],
					getAllLoadedFiles: () => [],
					getFileByPath: () => null,
					getAbstractFileByPath: () => null,
					trash: vi.fn(async () => {}),
				},
				workspace: { getLeavesOfType: () => [] },
			} as unknown as App,
			getSettings: () => ({ accessToken: "t", vaultId: "42", deviceId: "dev-1" }),
			baseStore: {
				getBase: () => null,
				saveBase,
				reset: vi.fn(),
				flush: vi.fn(async () => {}),
			} as unknown as BaseStore,
			pendingStore: {
				getPending: () => pendingState,
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
					entries: {},
				})),
				hasBlobs: vi.fn(async () => new Set<string>()),
				putBlob: vi.fn(async () => {}),
				getBlob: vi.fn(async () => content),
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

function lastStatus(deps: { onStatus: unknown }) {
	const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
	return onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0] as {
		lastError: string;
		allSynced: boolean;
		blockedDetails: Array<{ path: string; reason: string }>;
	};
}

describe("pending 恢复遇到 EPERM", () => {
	it("隔离失败文件、保留 pending、状态展示 write_failed，不再继续正常同步", async () => {
		const content = enc.encode("core");
		const hash = await sha256Hex(content);
		const pending: PendingLog = {
			schema_version: 2,
			vault_id: "42",
			base_revision: "1",
			base_root_hash: "r1",
			target_root_hash: "r1",
			phase: "applying",
			target_revision: "1",
			apply_actions: [
				{ kind: "write", path: "core.json", content_hash: hash, size: String(content.length) },
			],
			created_at: new Date().toISOString(),
			path_mode: 0,
		};
		const { deps, writeBinary, saveBase, clear, commitSnapshot } = fakeDeps(content, pending);
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		// 有界重试 3 次后隔离；不再进入正常同步（不提交、不写 Base、不清 pending）
		expect(writeBinary.mock.calls.filter(([path]) => path === "core.json")).toHaveLength(3);
		expect(commitSnapshot).not.toHaveBeenCalled();
		expect(saveBase).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
		const status = lastStatus(deps);
		expect(status.lastError).toBe("部分文件暂时无法写入，已保留待重试");
		expect(status.blockedDetails).toEqual([{ path: "core.json", reason: "write_failed" }]);
		expect(status.allSynced).toBe(false);
		session.dispose();
	});

	it("解除占用后手动同步重试成功：清 pending、写 Base、清除 blocked", async () => {
		const content = enc.encode("core");
		const hash = await sha256Hex(content);
		const pending: PendingLog = {
			schema_version: 2,
			vault_id: "42",
			base_revision: "1",
			base_root_hash: "r1",
			target_root_hash: "r1",
			phase: "applying",
			target_revision: "1",
			apply_actions: [
				{ kind: "write", path: "core.json", content_hash: hash, size: String(content.length) },
			],
			created_at: new Date().toISOString(),
			path_mode: 0,
		};
		const { deps, writeBinary, saveBase, clear } = fakeDeps(content, pending);
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);
		expect(clear).not.toHaveBeenCalled();

		// 用户解除只读/占用后手动同步：interactive 绕过退避，立即重放 pending
		writeBinary.mockImplementation(async () => {});
		session.requestRun({ forceAudit: true, interactive: true });
		await waitForIdle(session);

		expect(clear).toHaveBeenCalled();
		expect(saveBase).toHaveBeenCalled();
		const status = lastStatus(deps);
		expect(status.lastError).toBe("");
		expect(status.blockedDetails).toEqual([]);
		expect(status.allSynced).toBe(true);
		session.dispose();
	});
});
