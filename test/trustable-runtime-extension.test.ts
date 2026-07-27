import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	loadTrustableRuntimeManifest,
	isManagedActionMutation,
	ManagedSemanticCircuit,
	MANAGED_REPEATED_STREAM_ERROR,
	managedAttemptSignature,
	managedBootstrapBlockReason,
	managedCheckerCommandBlockReason,
	managedGeneratedArtifactBlockReason,
	managedActionWasCreated,
	managedMcpInvocation,
	managedRedeployVerificationBlockReason,
	managedRepeatedStreamTextDetected,
	managedSecretAccessBlockReason,
	managedServiceMcpMutationBlockReason,
	managedShellCommandBlockReason,
	managedToolResultFailed,
	pathIsWithin,
	readTrustableRuntimeStatus,
	recordManagedMcpBootstrapResult,
	requestTrustableRedeploy,
	trustableRuntimeSystemPrompt,
} from "../extensions/trustable-runtime";

describe("Trustable Pi runtime extension", () => {
	it("moves the provider repetition guard to upstream Pi's extension boundary", () => {
		const phrase = Array.from(
			{ length: 32 },
			(_value, index) => `guard-word-${index}`,
		).join(" ");
		const repeated = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: Array.from({ length: 4 }, () => phrase).join(" "),
				},
			],
		};
		expect(managedRepeatedStreamTextDetected(repeated)).toBe(true);
		expect(MANAGED_REPEATED_STREAM_ERROR).toContain(
			"repeated the same streamed response",
		);

		const healthy = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: Array.from(
						{ length: 301 },
						(_value, index) => `healthy-turn-${index}`,
					).join(" "),
				},
			],
		};
		expect(managedRepeatedStreamTextDetected(healthy)).toBe(false);
	});

	it("revalidates the host manifest and standard MCP config inside Pi", async () => {
		const root = await mkdtemp(join(tmpdir(), "runtime-extension-"));
		const workbench = join(root, "workbench");
		const nested = join(workbench, "src");
		const manifestPath = join(root, "runtime.json");
		const watcherLog = join(root, "ops-ide-devel.log");
		const mcpConfig = join(root, "mcp.json");
		await mkdir(nested, { recursive: true });
		await writeFile(
			watcherLog,
			[
				"building packages/v1/projects.zip",
				"API_KEY=super-secret-value",
				'ops action update v1/login -p APP_SECRET "another-secret"',
				"deployed packages/v1/projects.zip",
			].join("\n"),
			{ mode: 0o600 },
		);
		await writeFile(
			join(workbench, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					openserverless: {},
					browser: {},
					mongodb: {},
				},
			}),
		);
		await writeFile(
			mcpConfig,
			JSON.stringify({
				mcpServers: {
					openserverless: {
						type: "stdio",
						command: "openserverless-mcp",
					},
					browser: {
						type: "stdio",
						command: "trustable-browser-mcp",
					},
					mongodb: {
						type: "stdio",
						command: "mongodb-mcp-server",
					},
				},
			}),
			{ mode: 0o600 },
		);
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 2,
				workbenches: [
					{
						app: "example",
						workspace: workbench,
						developmentUrl: "http://localhost:5173",
						browserUrl: "http://vite.example.test",
						requiredMcpServers: [
							"mongodb",
							"browser",
							"openserverless",
						],
						mcpConfig,
						watcherLog,
					},
				],
			}),
		);

		const manifest = loadTrustableRuntimeManifest(nested, {
			TRUSTABLE_MANAGED_RUNTIME: "1",
			TRUSTABLE_RUNTIME_CONFIG: manifestPath,
		});
		expect(manifest.requiredMcpServers).toEqual([
			"browser",
			"mongodb",
			"openserverless",
		]);
		expect(pathIsWithin(workbench, nested)).toBe(true);
		expect(pathIsWithin(workbench, join(root, "other"))).toBe(false);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"service MCPs as discovery and read-only verification",
		);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"Browser-visible application URL: http://vite.example.test",
		);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"ops ide devel watcher is the sole owner",
		);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"call trustable_runtime_status",
		);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"use opaque random session tokens with an expiry",
		);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"OpenServerless auth_setup tool once",
		);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"complete the mandatory MCP bootstrap",
		);
		expect(trustableRuntimeSystemPrompt(manifest)).toContain(
			"Only the user may change application environment values",
		);
		const status = readTrustableRuntimeStatus(manifest, 2);
		expect(status.lines.join("\n")).toContain(
			"deployed packages/v1/projects.zip",
		);
		expect(status.lines.join("\n")).not.toContain("super-secret-value");
		expect(status.lines.join("\n")).not.toContain("another-secret");
		expect(status.lines.join("\n")).toContain("[REDACTED]");
	});

	it("enforces user-owned app env files while leaving value-free status available", () => {
		expect(
			managedSecretAccessBlockReason(
				"read",
				{ path: ".env" },
				"/workbench/example",
			),
		).toContain("application env access");
		expect(
			managedSecretAccessBlockReason(
				"write",
				{ path: ".env.production" },
				"/workbench/example",
			),
		).toContain("application env access");
		expect(
			managedSecretAccessBlockReason(
				"shell",
				{ command: "sed -n '1,20p' packages/.env" },
				"/workbench/example",
			),
		).toContain("application env file");
		expect(
			managedSecretAccessBlockReason(
				"mcp",
				{ server: "openserverless", tool: "secret_status" },
				"/workbench/example",
			),
		).toBeUndefined();
		expect(
			managedSecretAccessBlockReason(
				"mcp",
				{ server: "openserverless", tool: "secret_ensure" },
				"/workbench/example",
			),
		).toContain("automatic environment-secret creation");
		expect(
			managedSecretAccessBlockReason(
				"mcp",
				{
					tool: "openserverless_secret_ensure",
					args: '{"name":"APP_SECRET"}',
				},
				"/workbench/example",
				["openserverless"],
			),
		).toContain("automatic environment-secret creation");
		expect(
			managedSecretAccessBlockReason(
				"mcp",
				{ server: "openserverless", tool: "auth-setup" },
				"/workbench/example",
			),
		).toBeUndefined();
		expect(
			managedSecretAccessBlockReason(
				"mcp",
				{ server: "openserverless", tool: "secret_bind" },
				"/workbench/example",
			),
		).toBeUndefined();
	});

	it("blocks generated wrappers and archives while allowing business modules", () => {
		const workspace = "/workbench/example";
		expect(
			managedGeneratedArtifactBlockReason(
				"edit",
				{ path: "packages/v1/login/__main__.py" },
				workspace,
			),
		).toContain("OpenServerless-generated wrapper");
		expect(
			managedGeneratedArtifactBlockReason(
				"write",
				{ path: "/workbench/example/packages/v1/login.zip" },
				workspace,
			),
		).toContain("deploy artifact");
		expect(
			managedGeneratedArtifactBlockReason(
				"edit",
				{ path: "packages/v1/login/login.py" },
				workspace,
			),
		).toBeUndefined();
		expect(
			managedGeneratedArtifactBlockReason(
				"edit",
				{ path: "src/App.tsx" },
				workspace,
			),
		).toBeUndefined();
	});

	it("requires an MCP-generated wrapper before a new action business module", async () => {
		const workspace = await mkdtemp(
			join(tmpdir(), "runtime-extension-workbench-"),
		);
		const action = join(workspace, "packages", "v1", "users");
		await mkdir(action, { recursive: true });
		expect(
			managedGeneratedArtifactBlockReason(
				"write",
				{ path: "packages/v1/users/users.py" },
				workspace,
			),
		).toContain("action scaffold");
		await writeFile(join(action, "__main__.py"), "# generated\n");
		expect(
			managedGeneratedArtifactBlockReason(
				"write",
				{ path: "packages/v1/users/users.py" },
				workspace,
			),
		).toBeUndefined();
	});

	it("keeps service MCPs read-only during reproducible application work", () => {
		for (const [server, tool] of [
			["postgres", "postgres_execute_sql"],
			["redis", "redis_set"],
			["mongodb", "insert_many"],
			["s3", "put_object"],
			["milvus", "upsert"],
		]) {
			expect(
				managedServiceMcpMutationBlockReason("mcp", {
					server,
					tool,
				}),
			).toContain(`mutating ${server} MCP tool`);
		}
		expect(
			managedServiceMcpMutationBlockReason("mcp", {
				server: "postgres",
				tool: "postgres_list_objects",
			}),
		).toBeUndefined();
		expect(
			managedServiceMcpMutationBlockReason(
				"mcp",
				{
					tool: "postgres_execute_sql",
					args: '{"sql":"drop table users"}',
				},
				["postgres"],
			),
		).toContain("mutating postgres MCP tool");
		expect(
			managedServiceMcpMutationBlockReason("mcp", {
				server: "redis",
				tool: "get",
			}),
		).toBeUndefined();
		expect(
			managedServiceMcpMutationBlockReason("mcp", {
				server: "openserverless",
				tool: "auth_setup",
			}),
		).toBeUndefined();
	});

	it("fails closed when the managed marker or manifest does not match", async () => {
		const root = await mkdtemp(join(tmpdir(), "runtime-extension-"));
		expect(() => loadTrustableRuntimeManifest(root, {})).toThrow(
			"requires TRUSTABLE_MANAGED_RUNTIME=1",
		);
	});

	it("blocks deploy commands that race the managed development watcher", () => {
		expect(
			managedShellCommandBlockReason("bash", {
				command:
					"cd /workbench/app && timeout 120 ops ide deploy 2>&1 | tail -20",
			}),
		).toContain("managed ops ide devel watcher");
		expect(
			managedShellCommandBlockReason("bash", {
				command:
					"sleep 5 && cd /workbench/app && timeout 180 ops ide deploy",
			}),
		).toContain("do not retry");
		expect(
			managedShellCommandBlockReason("shell", {
				command: "ops ide devel --fast",
			}),
		).toContain("managed ops ide devel watcher");
	});

	it("allows read-only commands that only mention the blocked command", () => {
		expect(
			managedShellCommandBlockReason("bash", {
				command: "rg 'ops ide deploy' AGENTS.md",
			}),
		).toBeUndefined();
	});

	it("blocks destructive alternatives to MCP-owned application state", () => {
		for (const command of [
			"ops action update v1/login login.py",
			"psql -c 'create table users(id text)'",
			"pip install redis",
			"python generate_wrappers.py",
			"rm -rf packages/v1/login",
			"cat > packages/v1/login/login.py <<'PY'",
			"sed -i 's/a/b/' src/App.tsx",
			"git reset --hard HEAD~1",
		]) {
			expect(
				managedShellCommandBlockReason("bash", { command }),
			).toBeTruthy();
		}
	});

	it("blocks direct inspection and polling of watcher-owned action archives", () => {
		for (const command of [
			"ls -la /workbench/example/packages/v1/login.zip",
			"find packages -type f -name '*.zip'",
			"until [ -f packages/v1/register.zip ]; do sleep 2; done",
			"stat packages/setup/init-admin.zip",
		]) {
			expect(
				managedShellCommandBlockReason("bash", { command }),
			).toContain("watcher-owned packages/**/*.zip");
		}
	});

	it("allows the managed source checker without archive probing", () => {
		expect(
			managedShellCommandBlockReason("bash", {
				command: "timeout 60 check_openserverless_actions.sh .",
			}),
		).toBeUndefined();
	});

	it("allows one unmasked checker run and blocks repetition without mutation", () => {
		const command = "timeout 60 check_openserverless_actions.sh .";
		expect(
			managedCheckerCommandBlockReason(command, false),
		).toBeUndefined();
		expect(managedCheckerCommandBlockReason(command, true)).toContain(
			"repeated action checker",
		);
		expect(
			managedCheckerCommandBlockReason(
				`${command} 2>&1 | head -40`,
				false,
			),
		).toContain("masked action checker");
	});

	it("recognizes mutations that authorize one fresh checker run", () => {
		expect(isManagedActionMutation("edit", { path: "src/App.tsx" })).toBe(
			true,
		);
		expect(
			isManagedActionMutation("mcp", {
				server: "openserverless",
				tool: "action_add_postgresql",
			}),
		).toBe(true);
		expect(
			isManagedActionMutation("mcp", {
				server: "openserverless",
				tool: "action_invoke",
			}),
		).toBe(false);
		expect(isManagedActionMutation("mcp", { server: "postgres" })).toBe(
			false,
		);
		expect(
			isManagedActionMutation(
				"mcp",
				{
					tool: "openserverless_action_new",
					args: '{"endpoint":"v1/users"}',
				},
				["openserverless"],
			),
		).toBe(true);
	});

	it("normalizes the real pi-mcp-adapter proxy shape", () => {
		expect(
			managedMcpInvocation("mcp", {}, ["openserverless"]),
		).toEqual({ mode: "status", args: {} });
		expect(
			managedMcpInvocation(
				"mcp",
				{ server: "openserverless" },
				["openserverless"],
			),
		).toEqual({
			mode: "list",
			server: "openserverless",
			args: {},
		});
		// Regression: trulongrun6 used the adapter's lazy-connect shape for
		// every server; it must not be misclassified as global status.
		expect(
			managedMcpInvocation(
				"mcp",
				{ connect: "openserverless" },
				["openserverless"],
			),
		).toEqual({
			mode: "connect",
			server: "openserverless",
			args: {},
		});
		expect(
			managedMcpInvocation(
				"mcp",
				{
					tool: "openserverless_action_new",
					args: '{"endpoint":"v1/users","public":true}',
				},
				["openserverless"],
			),
		).toEqual({
			mode: "call",
			server: "openserverless",
			tool: "action_new",
			args: { endpoint: "v1/users", public: true },
		});
	});

	it("requires one safe host redeploy after a real action creation batch", async () => {
		const invocation = managedMcpInvocation(
			"mcp",
			{
				tool: "openserverless_action_new",
				args: '{"endpoint":"v1/users"}',
			},
			["openserverless"],
		);
		const created = {
			toolCallId: "create-1",
			toolName: "mcp",
			input: {},
			content: [
				{
					type: "text",
					text: "Created endpoint at /api/my/v1/users",
				},
			],
			isError: false,
			details: { mode: "call", success: true },
		};
		expect(managedActionWasCreated(invocation, created)).toBe(true);
		expect(
			managedActionWasCreated(invocation, {
				...created,
				content: [
					{
						type: "text",
						text: "Check passed: endpoint already exists; no changes made.",
					},
				],
			}),
		).toBe(false);
		expect(
			managedRedeployVerificationBlockReason(
				"trustable_runtime_status",
				{},
				true,
				["openserverless"],
			),
		).toContain("trustable_runtime_redeploy");
		expect(
			managedRedeployVerificationBlockReason(
				"edit",
				{ path: "packages/v1/users/users.py" },
				true,
				["openserverless"],
			),
		).toBeUndefined();
		expect(
			managedRedeployVerificationBlockReason(
				"trustable_runtime_redeploy",
				{},
				true,
				["openserverless"],
			),
		).toBeUndefined();

		let requestedUrl = "";
		const result = await requestTrustableRedeploy(
			"example",
			async (input) => {
				requestedUrl = String(input);
				return new Response(
					[
						"event: status",
						"data: Deploying actions...",
						"",
						"event: done",
						"data: /guest/v1/users",
						"data: /guest/v1/login",
						"",
					].join("\n"),
					{ status: 200 },
				);
			},
		);
		expect(requestedUrl).toBe(
			"http://127.0.0.1:8910/api/redeploy?name=example",
		);
		expect(result).toEqual({
			app: "example",
			actionList: "/guest/v1/users\n/guest/v1/login",
		});
		await expect(
			requestTrustableRedeploy("example", async () => {
				return new Response(
					"event: error\ndata: ops ide deploy failed\n\n",
					{ status: 200 },
				);
			}),
		).rejects.toThrow("ops ide deploy failed");
		await expect(
			requestTrustableRedeploy(
				"example",
				async (_input, init) => {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						text: () =>
							new Promise<string>((_resolve, reject) => {
								init?.signal?.addEventListener(
									"abort",
									() => reject(new Error("stream aborted")),
									{ once: true },
								);
							}),
					} as Response;
				},
				5,
			),
		).rejects.toThrow("timed out after 5ms");
	});

	it("requires successful status and every required server listing before work", () => {
		const listed = new Set<string>(["browser"]);
		expect(
			managedBootstrapBlockReason(
				"mcp",
				{},
				false,
				listed,
				["browser", "openserverless"],
			),
		).toBeUndefined();
		expect(
			managedBootstrapBlockReason(
				"write",
				{ path: "src/App.tsx" },
				true,
				listed,
				["browser", "openserverless"],
			),
		).toContain('mcp({connect:"openserverless"})');
		expect(
			managedBootstrapBlockReason(
				"mcp",
				{ connect: "openserverless" },
				false,
				listed,
				["browser", "openserverless"],
			),
		).toBeUndefined();
		expect(
			managedBootstrapBlockReason(
				"mcp",
				{
					tool: "openserverless_action_new",
					args: '{"endpoint":"v1/users"}',
				},
				true,
				new Set(["browser", "openserverless"]),
				["browser", "openserverless"],
			),
		).toBeUndefined();
	});

	it("accepts successful connect-all bootstrap and ignores failed connects", () => {
		const required = ["browser", "openserverless"];
		const listed = new Set<string>();
		let statusSeen = false;

		// Regression: this is the exact discovery shape Pi used in trulongrun6.
		for (const server of required) {
			statusSeen = recordManagedMcpBootstrapResult(
				managedMcpInvocation("mcp", { connect: server }, required),
				true,
				statusSeen,
				listed,
			);
		}
		expect(statusSeen).toBe(true);
		expect(listed).toEqual(new Set(required));
		expect(
			managedBootstrapBlockReason(
				"write",
				{ path: "src/App.tsx" },
				statusSeen,
				listed,
				required,
			),
		).toBeUndefined();

		const failedListed = new Set<string>();
		expect(
			recordManagedMcpBootstrapResult(
				managedMcpInvocation(
					"mcp",
					{ connect: "openserverless" },
					required,
				),
				false,
				false,
				failedListed,
			),
		).toBe(false);
		expect(failedListed.size).toBe(0);
	});

	it("opens the semantic circuit after three equivalent failures and resets on progress", () => {
		const signature = managedAttemptSignature(
			"mcp",
			{
				tool: "openserverless_action_new",
				args: '{"endpoint":"v1/users"}',
			},
			["openserverless"],
		);
		const circuit = new ManagedSemanticCircuit();
		for (let index = 0; index < 3; index += 1) {
			expect(circuit.blockReason(signature)).toBeUndefined();
			circuit.recordFailure(signature);
		}
		expect(circuit.blockReason(signature)).toContain(
			"three semantically equivalent failures",
		);
		circuit.recordSuccess("write:packages/v1/users/users.py", true);
		expect(circuit.blockReason(signature)).toBeUndefined();
	});

	it("recognizes adapter semantic failures even when isError is false", () => {
		expect(
			managedToolResultFailed({
				toolCallId: "call-1",
				toolName: "mcp",
				input: {},
				content: [{ type: "text", text: "call completed" }],
				isError: false,
				details: { mode: "call", error: "connection refused" },
			}),
		).toBe(true);
		expect(
			managedToolResultFailed({
				toolCallId: "call-2",
				toolName: "mcp",
				input: {},
				content: [{ type: "text", text: "healthy" }],
				isError: false,
				details: { mode: "call", success: true },
			}),
		).toBe(false);
	});
});
