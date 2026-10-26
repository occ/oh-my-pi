import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function session(cwd: string, additionalDirectories: string[] = []): ToolSession {
	return {
		cwd,
		additionalDirectories,
		workspaceBound: true,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(path.dirname(cwd), "artifacts"),
		settings: Settings.isolated({ "edit.mode": "replace" }),
		enableLsp: false,
	};
}

describe("delegated filesystem workspace writes", () => {
	let root: string;
	let worktree: string;
	let primary: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-write-"));
		worktree = path.join(root, "worktree");
		primary = path.join(root, "primary");
		await fs.mkdir(worktree);
		await fs.mkdir(primary);
		await Bun.write(path.join(primary, "foreign.txt"), "foreign baseline\n");
	});
	afterEach(async () => {
		await removeWithRetries(root);
	});

	it("writes relative files only in the bound checkout and preserves foreign primary files", async () => {
		const tool = new WriteTool(session(worktree));
		await tool.execute("relative", { path: "result.txt", content: "worktree result\n" });
		expect(await Bun.file(path.join(worktree, "result.txt")).text()).toBe("worktree result\n");
		for (const target of [path.join(primary, "foreign.txt"), "../primary/foreign.txt"]) {
			await expect(tool.execute("escape", { path: target, content: "overwrite\n" })).rejects.toThrow(
				/Delegated workspace/,
			);
		}
		expect(await Bun.file(path.join(primary, "foreign.txt")).text()).toBe("foreign baseline\n");
		expect(await Bun.file(path.join(primary, "result.txt")).exists()).toBe(false);
	});

	it("rejects existing, missing-tail and dangling symlink destinations", async () => {
		if (process.platform === "win32") return;
		await fs.symlink(primary, path.join(worktree, "outside"));
		await fs.symlink(path.join(primary, "missing.txt"), path.join(worktree, "dangling"));
		const tool = new WriteTool(session(worktree));
		for (const target of ["outside/foreign.txt", "outside/new/deep.txt", "dangling"]) {
			await expect(tool.execute("symlink", { path: target, content: "escape\n" })).rejects.toThrow(
				/Delegated workspace/,
			);
		}
		expect(await Bun.file(path.join(primary, "foreign.txt")).text()).toBe("foreign baseline\n");
		expect(await Bun.file(path.join(primary, "new/deep.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(primary, "missing.txt")).exists()).toBe(false);
	});

	it("permits explicitly declared roots and local scratch without restricting ordinary parent sessions", async () => {
		const tool = new WriteTool(session(worktree, [primary]));
		await tool.execute("declared", { path: path.join(primary, "permitted.txt"), content: "declared\n" });
		await tool.execute("scratch", { path: "local://memo.txt", content: "scratch\n" });
		expect(await Bun.file(path.join(primary, "permitted.txt")).text()).toBe("declared\n");
		expect(await Bun.file(path.join(root, "artifacts/local/memo.txt")).text()).toBe("scratch\n");
		const parent = session(worktree);
		parent.workspaceBound = false;
		await new WriteTool(parent).execute("parent", { path: path.join(primary, "parent.txt"), content: "parent\n" });
		expect(await Bun.file(path.join(primary, "parent.txt")).text()).toBe("parent\n");
	});

	it("rejects explicit bash cwd outside the bound roots before running the command", async () => {
		const tool = new BashTool(session(worktree));
		await expect(tool.execute("cwd-escape", { command: "pwd", cwd: primary })).rejects.toThrow(/Delegated workspace/);
	});
});
