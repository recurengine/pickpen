// 库外文件（Obsidian 1.14.4+ TExternalFile）识别：类型信号 + 路径形状双保险。
// 远端 Manifest 只有路径字符串，类型判定仅用于本地扫描/事件/视图层。

import { TExternalFile, type TAbstractFile } from "obsidian";

import { normalize } from "../excludes";
import { isExternalPath } from "./path";

/** 旧 Obsidian（< 1.14.4）没有 TExternalFile 运行时导出：必须先判 typeof，
 * 直接 `x instanceof TExternalFile` 会在 undefined 上抛 TypeError。
 * 拆成工厂便于单测 undefined 分支。 */
export function makeExternalFileMatcher(ctor: unknown): (file: unknown) => boolean {
	if (typeof ctor !== "function") return () => false;
	return (file) => file instanceof ctor;
}

const matchExternalFile = makeExternalFileMatcher(TExternalFile);

/** 本地 vault 条目是否是库外文件（类型信号；路径兜底见 isExternalPath） */
export function isExternalFile(file: unknown): boolean {
	return matchExternalFile(file);
}

/** 本地 vault 条目是否应跳过：类型信号优先，旧宿主/路径变体用首段形状兜底 */
export function isExternalVaultEntry(file: TAbstractFile | null | undefined): boolean {
	if (!file) return false;
	return isExternalFile(file) || isExternalPath(normalize(file.path));
}
