// 文件系统错误分类：桌面端 Node errno 与移动端 Capacitor 文案统一在这里判定。
// 只做错误语义收敛，不依赖 Obsidian API，供 applier/session 等模块共用。

/** 读取错误链上的字符串 errno（Node 的 code、Capacitor 的 code/NOT_FOUND 等）。 */
export function fsErrnoOf(err: unknown): string {
	let current: unknown = err;
	for (let depth = 0; depth < 3 && current !== null && typeof current === "object"; depth++) {
		const e = current as { code?: unknown; name?: unknown; cause?: unknown };
		if (typeof e.code === "string" && e.code !== "") return e.code;
		if (e.name === "NotFoundError") return "ENOENT";
		current = e.cause;
	}
	return "";
}

/** 读盘/删除时「路径已不存在」：按本地已删/消失处理，不应当成异常。 */
export function isMissingPathError(err: unknown): boolean {
	const errno = fsErrnoOf(err);
	if (errno === "ENOENT") return true;
	// Capacitor（移动端）的文件系统错误用字符串码区分
	if (errno !== "" && /not[_ ]?found/i.test(errno)) return true;
	const message =
		err instanceof Error
			? err.message
			: typeof (err as { message?: unknown } | null)?.message === "string"
				? ((err as { message: string }).message)
				: "";
	// 桌面端是 ENOENT / No such file；移动端 Capacitor 的文案是 File does not exist
	return /not found|enoent|no such file|does not exist/i.test(message);
}

const BUSY_ERRNOS = new Set(["EPERM", "EACCES", "EBUSY", "ETXTBSY"]);

/** 文件当前不可写/被占用（权限、只读属性、杀软或云同步锁）：可重试、可单文件隔离。 */
export function isBusyPathError(err: unknown): boolean {
	return BUSY_ERRNOS.has(fsErrnoOf(err));
}

/** 给读盘异常补上相对路径，便于上报归因；保留 name/code/cause，避免上层 errno 分类失效。 */
export function withPathContext(err: unknown, path: string): Error {
	const original = err instanceof Error ? err : new Error(String(err));
	const wrapped = new Error(`读取 ${path} 失败：${original.message || original.name}`);
	wrapped.name = original.name || "Error";
	const target = wrapped as Error & { code?: unknown; cause?: unknown };
	const code = (original as { code?: unknown }).code;
	if (code !== undefined) target.code = code;
	target.cause = original;
	return wrapped;
}

/**
 * 本地写入被系统拒绝（如 Windows EPERM）：文件已隔离、整轮不再因它失败。
 * message 只含 errno，不采集用户路径；路径明细只进本地调试日志。
 */
export class LocalWriteBlockedError extends Error {
	readonly errno: string;

	constructor(errno: string) {
		super(`本地文件写入被系统拒绝（${errno || "UNKNOWN"}），已跳过并稍后重试`);
		this.name = "LocalWriteBlockedError";
		this.errno = errno;
	}
}
