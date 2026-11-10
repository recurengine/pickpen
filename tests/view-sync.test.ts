// 打开视图同步辅助：库外文件不参与 capture/save/refresh。
import { describe, expect, it, vi } from "vitest";
import { MarkdownView, TExternalFile, type App } from "obsidian";

import {
	captureAllOpenViews,
	captureOpenViews,
	openMarkdownViews,
	refreshOpenViews,
	saveDirtyOpenViews,
	type OpenMarkdownViewState,
} from "../src/view-sync";

function externalView(path = "file:/Users/a/x.md"): MarkdownView {
	return Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
		file: Object.assign(new TExternalFile(), { path }),
		editor: { getValue: () => "", setValue: vi.fn() },
	});
}

function appWithViews(views: MarkdownView[]): App {
	return { workspace: { getLeavesOfType: () => views.map((view) => ({ view })) } } as unknown as App;
}

describe("库外文件视图", () => {
	it("openMarkdownViews 对库外路径直接返回空", () => {
		expect(openMarkdownViews(appWithViews([externalView()]), "file:/Users/a/x.md")).toEqual([]);
	});

	it("captureOpenViews 对库外路径直接返回空", async () => {
		expect(await captureOpenViews({} as App, "file:/Users/a/x.md")).toEqual([]);
	});

	it("captureAllOpenViews 跳过 TExternalFile", async () => {
		expect(await captureAllOpenViews(appWithViews([externalView()]))).toEqual([]);
	});

	it("saveDirtyOpenViews 不保存库外文件", async () => {
		const save = vi.fn(async () => {});
		const state = {
			view: { save },
			path: "file:/Users/a/x.md",
			buffer: "dirty",
			dirty: true,
			saved: false,
		} as unknown as OpenMarkdownViewState;

		await expect(saveDirtyOpenViews({} as App, [state])).resolves.toBe(0);
		expect(save).not.toHaveBeenCalled();
	});

	it("refreshOpenViews 不刷新库外文件", async () => {
		const setValue = vi.fn();
		const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
			file: Object.assign(new TExternalFile(), { path: "file:/Users/a/x.md" }),
			editor: { getValue: () => "old", setValue },
		});
		const state = {
			view,
			path: "file:/Users/a/x.md",
			buffer: "old",
			dirty: false,
			saved: true,
		} as OpenMarkdownViewState;

		await refreshOpenViews({} as App, [state], new TextEncoder().encode("new"));
		expect(setValue).not.toHaveBeenCalled();
	});
});
