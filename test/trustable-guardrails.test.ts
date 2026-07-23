import { describe, expect, it } from "vitest";
import {
	isSensitivePath,
	unsafeShellReason,
} from "../extensions/trustable-guardrails";

describe("Trustable Pi guardrails", () => {
	it.each([
		".env",
		"/workbench/demo/.env.production",
		"/home/user/.pi/agent/auth.json",
		"/home/user/.ssh/id_ed25519",
		"/home/user/.ops/config.json",
		"/workspace/.trustable/secrets/demo.env",
		"/proc/self/environ",
	])("blocks sensitive path %s", (path) => {
		expect(isSensitivePath(path)).toBe(true);
	});

	it.each([
		".env.example",
		".env.dist",
		"/home/user/.ssh/id_ed25519.pub",
		"src/config.ts",
	])("allows non-secret path %s", (path) => {
		expect(isSensitivePath(path)).toBe(false);
	});

	it.each([
		"cat .env",
		"sed -n '1,20p' /workbench/demo/.env.local",
		"printenv",
		"echo $JWT_SECRET",
		"node -e 'console.log(process.env)'",
		"python -c 'import os; print(os.environ)'",
	])("blocks shell secret access: %s", (command) => {
		expect(unsafeShellReason(command)).toBeTypeOf("string");
	});

	it.each([
		"npm run build",
		"git status --short",
		"cat .env.example",
		"grep -n TODO src/App.tsx",
	])("allows ordinary command: %s", (command) => {
		expect(unsafeShellReason(command)).toBeUndefined();
	});
});
