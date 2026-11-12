import { describe, expect, it } from "vitest";
import {
	fsErrnoOf,
	isBusyPathError,
	isMissingPathError,
	LocalWriteBlockedError,
	withPathContext,
} from "../src/sync/fs-errors";

describe("文件系统错误分类", () => {
	it("识别 ENOENT 的 code/message/cause 与 Capacitor 文案", () => {
		expect(isMissingPathError(Object.assign(new Error("boom"), { code: "ENOENT" }))).toBe(true);
		expect(isMissingPathError(new Error("ENOENT: no such file or directory, open 'a.md'"))).toBe(true);
		expect(isMissingPathError(new Error("File does not exist"))).toBe(true);
		expect(isMissingPathError(Object.assign(new Error("nf"), { name: "NotFoundError" }))).toBe(true);
		expect(isMissingPathError(Object.assign(new Error("nf"), { code: "NOT_FOUND" }))).toBe(true);
		const caused = new Error("wrapper");
		(caused as Error & { cause?: unknown }).cause = Object.assign(new Error("inner"), {
			code: "ENOENT",
		});
		expect(isMissingPathError(caused)).toBe(true);
		const caused2 = new Error("failed");
		(caused2 as Error & { cause?: unknown }).cause = Object.assign(new Error("inner"), {
			code: "ENOENT",
		});
		expect(isMissingPathError(caused2)).toBe(true);
	});

	it("只把 EPERM/EACCES/EBUSY/ETXTBSY 识别为可重试的占用错误", () => {
		for (const code of ["EPERM", "EACCES", "EBUSY", "ETXTBSY"]) {
			expect(isBusyPathError(Object.assign(new Error(code), { code }))).toBe(true);
			expect(fsErrnoOf(Object.assign(new Error(code), { code }))).toBe(code);
		}
		expect(isBusyPathError(Object.assign(new Error("io"), { code: "EIO" }))).toBe(false);
		expect(isBusyPathError(new Error("operation not permitted"))).toBe(false); // 不靠文案误判
		expect(isBusyPathError(new Error("普通错误"))).toBe(false);
	});

	it("withPathContext 保留 name/code/cause", () => {
		const original = Object.assign(new Error("permission denied"), { code: "EACCES" });
		original.name = "FsError";
		const wrapped = withPathContext(original, "a.md");
		expect(wrapped.message).toContain("a.md");
		expect(wrapped.name).toBe("FsError");
		expect((wrapped as Error & { code?: string }).code).toBe("EACCES");
		expect((wrapped as Error & { cause?: unknown }).cause).toBe(original);
	});

	it("LocalWriteBlockedError 只包含 errno，不泄露路径", () => {
		const err = new LocalWriteBlockedError("EPERM");
		expect(err.name).toBe("LocalWriteBlockedError");
		expect(err.errno).toBe("EPERM");
		expect(err.message).toContain("EPERM");
		expect(err.message).not.toContain("/");
	});
});
