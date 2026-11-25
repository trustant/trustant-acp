import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	consumeNotebookBootstrap,
	resetNotebookBootstrapForTest,
} from "../server/notebook-local";

describe("consumeNotebookBootstrap", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
		resetNotebookBootstrapForTest();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const on = { TRUSTANT_BOOTSTRAP_NOTEBOOK: "1" } as NodeJS.ProcessEnv;

	it("is false without the env flag", async () => {
		writeFileSync(join(dir, "template.md"), "step one\n");
		expect(await consumeNotebookBootstrap(dir, {})).toEqual({ run: false });
	});

	it("runs once when flagged and template.md has steps", async () => {
		writeFileSync(join(dir, "template.md"), "step one\n\n---\n\nstep two\n");
		expect(await consumeNotebookBootstrap(dir, on)).toEqual({ run: true });
		expect(await consumeNotebookBootstrap(dir, on)).toEqual({ run: false });
	});

	it("is false when there is no working copy", async () => {
		expect(await consumeNotebookBootstrap(dir, on)).toEqual({ run: false });
	});
});
