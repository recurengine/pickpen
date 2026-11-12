import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Applier, ApplyBlockedError } from "../src/sync/applier";
import { sha256Hex } from "../src/sync/content-hash";
import type { SnapshotRemote } from "../src/sync/remote";
import type { ApplyAction } from "../src/sync/types";

const enc = new TextEncoder();

function fsError(code: string): Error & { code: string } {
	return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

function appWith(opts: {
	fileByPath?: (path: string) => unknown;
	exists?: (path: string) => boolean | Promise<boolean>;
	readBinary?: (path: string) => Promise<ArrayBuffer>;
	writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
	remove?: (path: string) => Promise<void>;
	trashSystem?: (path: string) => Promise<boolean>;
	trashFile?: (file: unknown) => Promise<void>;
}): App {
	return {
		vault: {
			getFileByPath: opts.fileByPath ?? (() => null),
			adapter: {
				exists: opts.exists ?? (async () => false),
				mkdir: async () => {},
				readBinary: opts.readBinary ?? (async () => new ArrayBuffer(0)),
				writeBinary: opts.writeBinary ?? (async () => {}),
				remove: opts.remove ?? (async () => {}),
				trashSystem: opts.trashSystem,
			},
		},
		fileManager: { trashFile: opts.trashFile ?? (async () => {}) },
	} as unknown as App;
}

function makeApplier(app: App, blobs: Map<string, Uint8Array>): Applier {
	return new Applier(
		app,
		{ getBlob: async (hash: string) => blobs.get(hash) ?? new Uint8Array() } as unknown as SnapshotRemote,
		".pickpen",
	);
}

const baseArgs = {
	conflicts: [],
	expectedHashes: new Map<string, string>(),
	expectedRevision: 1n,
	expectedRootHash: "root",
	tmpDir: "tmp",
	isMobile: false,
};

describe("本地应用的文件系统错误处理", () => {
	it("trashFile 抛 ENOENT：删除目标已不存在，按幂等成功继续执行后续写入", async () => {
		const content = enc.encode("hello");
		const hash = await sha256Hex(content);
		const writeBinary = vi.fn(async () => {});
		const trashFile = vi.fn(async () => {
			throw fsError("ENOENT");
		});
		const app = appWith({
			fileByPath: (path) => (path === "gone.md" ? { path } : null),
			writeBinary,
			trashFile,
		});
		const applier = makeApplier(app, new Map([[hash, content]]));
		const actions: ApplyAction[] = [
			{ kind: "trash", path: "gone.md", content_hash: "", size: "0" },
			{ kind: "write", path: "a.md", content_hash: hash, size: String(content.length) },
		];

		const skipped = await applier.applyPlan({ ...baseArgs, actions });
		expect(skipped).toEqual([]);
		expect(trashFile).toHaveBeenCalledTimes(1);
		expect(writeBinary).toHaveBeenCalledWith("a.md", expect.anything());
	});

	it("trashUnindexed 的 remove 抛 ENOENT：同样按幂等成功处理", async () => {
		const remove = vi.fn(async () => {
			throw fsError("ENOENT");
		});
		const app = appWith({
			exists: (path) => path === "cfg.json",
			remove,
		});
		const applier = makeApplier(app, new Map());
		const actions: ApplyAction[] = [
			{ kind: "trash", path: "cfg.json", content_hash: "", size: "0" },
		];

		await expect(applier.applyPlan({ ...baseArgs, actions })).resolves.toEqual([]);
		expect(remove).toHaveBeenCalledWith("cfg.json");
	});

	it("trash 前读 hash 抛 EACCES：不能当成已删除，必须上抛", async () => {
		const app = appWith({
			fileByPath: () => ({ path: "a.md" }),
			exists: async () => true,
			readBinary: async () => {
				throw fsError("EACCES");
			},
		});
		const applier = makeApplier(app, new Map());
		const actions: ApplyAction[] = [
			{ kind: "trash", path: "a.md", content_hash: "", size: "0" },
		];

		await expect(
			applier.applyPlan({
				...baseArgs,
				actions,
				expectedHashes: new Map([["a.md", "old-hash"]]),
			}),
		).rejects.toMatchObject({ code: "EACCES" });
	});

	it("单个 write 持续 EPERM：其他 write 照常落地，最后抛 ApplyBlockedError", async () => {
		const bad = enc.encode("bad");
		const good = enc.encode("good");
		const hb = await sha256Hex(bad);
		const hg = await sha256Hex(good);
		const writeBinary = vi.fn(async (path: string) => {
			if (path === "bad.md") throw fsError("EPERM");
		});
		const app = appWith({ writeBinary });
		const applier = makeApplier(
			app,
			new Map([
				[hb, bad],
				[hg, good],
			]),
		);
		const actions: ApplyAction[] = [
			{ kind: "write", path: "bad.md", content_hash: hb, size: String(bad.length) },
			{ kind: "write", path: "good.md", content_hash: hg, size: String(good.length) },
		];

		let error: unknown;
		try {
			await applier.applyPlan({ ...baseArgs, actions });
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(ApplyBlockedError);
		expect((error as ApplyBlockedError).paths).toEqual(["bad.md"]);
		expect((error as ApplyBlockedError).errnos).toEqual(["EPERM"]);
		// bad.md 有界重试 3 次后放弃；good.md 仍然落地
		expect(writeBinary.mock.calls.map(([path]) => path)).toEqual([
			"bad.md",
			"bad.md",
			"bad.md",
			"good.md",
		]);
	});

	it("重放保护：用户在阻塞期间改过、删过或新建过目标时不覆盖", async () => {
		const remote = enc.encode("remote");
		const user = enc.encode("user");
		const plan = enc.encode("plan");
		const hr = await sha256Hex(remote);
		const hPlan = await sha256Hex(plan);

		// 1) 计划时目标存在，现在内容已被用户改过
		const changedApp = appWith({
			fileByPath: () => ({}),
			exists: async () => true,
			readBinary: async () => user.buffer.slice(0),
		});
		const changedApplier = makeApplier(changedApp, new Map([[hr, remote]]));
		await expect(
			changedApplier.applyPlan({
				...baseArgs,
				actions: [{ kind: "write", path: "a.md", content_hash: hr, size: String(remote.length) }],
				expectedHashes: new Map([["a.md", hPlan]]),
				expectedAbsent: new Set(),
			}),
		).resolves.toEqual(["a.md"]);

		// 2) 计划时目标存在，现在已被用户删除
		const deletedApp = appWith({ exists: async () => false });
		const deletedApplier = makeApplier(deletedApp, new Map([[hr, remote]]));
		await expect(
			deletedApplier.applyPlan({
				...baseArgs,
				actions: [{ kind: "write", path: "a.md", content_hash: hr, size: String(remote.length) }],
				expectedHashes: new Map([["a.md", hPlan]]),
				expectedAbsent: new Set(),
			}),
		).resolves.toEqual(["a.md"]);

		// 3) 计划时目标不存在，现在被用户新建
		const createdApp = appWith({
			fileByPath: () => ({}),
			exists: async () => true,
			readBinary: async () => user.buffer.slice(0),
		});
		const createdApplier = makeApplier(createdApp, new Map([[hr, remote]]));
		await expect(
			createdApplier.applyPlan({
				...baseArgs,
				actions: [{ kind: "write", path: "a.md", content_hash: hr, size: String(remote.length) }],
				expectedHashes: new Map(),
				expectedAbsent: new Set(["a.md"]),
			}),
		).resolves.toEqual(["a.md"]);
	});
});
