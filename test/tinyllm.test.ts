import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
	createModels,
	InMemoryModelsStore,
	normalizeContext,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	bootstrapProvider,
	createTinyllmProvider,
	discoverModels,
	mapDiscoveredModels,
	normalizeBaseUrl,
	registerFastMode,
	rewriteFastPayload,
} from "../extensions/tinyllm.ts";

const quiet = () => {};

function catalogModel(provider: Parameters<typeof getBuiltinModels>[0], id: string): Model<Api> {
	const model = getBuiltinModels(provider).find((candidate) => candidate.id === id);
	assert.ok(model, `${provider}/${id} must exist in Pi's catalog`);
	return model as Model<Api>;
}

function withoutRouting(model: Model<Api>) {
	const { id: _id, provider: _provider, api: _api, baseUrl: _baseUrl, ...metadata } = model;
	return metadata;
}

test("discovery preserves catalog metadata, source order, fast filtering, and supported routes", () => {
	const warnings: string[] = [];
	const models = mapDiscoveredModels(
		[
			"anthropic/claude-sonnet-4-6",
			"openai/gpt-5.5-fast",
			"openai/gpt-5.5",
			"deepseek/deepseek-v4-pro",
			"anthropic/claude-sonnet-4-6",
			"anthropic/claude-sonnet-4-6-fast",
			"alias/gpt-5.5",
			"openai/not-real",
			"missing-slash",
			"openai//gpt-5.5",
		],
		"http://127.0.0.1:8080/",
		(message) => warnings.push(message),
	);

	assert.deepEqual(
		models.map(({ id, api, baseUrl }) => ({ id, api, baseUrl })),
		[
			{
				id: "anthropic/claude-sonnet-4-6",
				api: "anthropic-messages",
				baseUrl: "http://127.0.0.1:8080/anthropic",
			},
			{
				id: "openai/gpt-5.5",
				api: "openai-responses",
				baseUrl: "http://127.0.0.1:8080/v1",
			},
			{
				id: "deepseek/deepseek-v4-pro",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:8080/v1",
			},
		],
	);

	assert.deepEqual(withoutRouting(models[0]), withoutRouting(catalogModel("anthropic", "claude-sonnet-4-6")));
	assert.deepEqual(withoutRouting(models[1]), withoutRouting(catalogModel("openai-codex", "gpt-5.5")));
	assert.deepEqual(withoutRouting(models[2]), withoutRouting(catalogModel("deepseek", "deepseek-v4-pro")));
	assert.deepEqual(mapDiscoveredModels(["openai/gpt-4.1-fast"], "http://127.0.0.1:8080", quiet), []);
	assert.equal(models[1].id, "openai/gpt-5.5");
	const codex = mapDiscoveredModels(["codex/gpt-5.5"], "http://127.0.0.1:8080", quiet)[0];
	assert.equal(codex.id, "codex/gpt-5.5");
	assert.deepEqual(withoutRouting(codex), withoutRouting(catalogModel("openai-codex", "gpt-5.5")));
	assert.equal(warnings.length, 1);
	assert.ok(!warnings[0].includes("secret"));
});

test("Anthropic fallback metadata remains local to the TinyLLM provider", () => {
	const mapped = mapDiscoveredModels(["anthropic/claude-fable-5"], "http://gateway.test", quiet)[0];
	const source = catalogModel("anthropic", "claude-fable-5") as Model<"anthropic-messages">;
	assert.ok(mapped);
	assert.deepEqual(
		(mapped as Model<"anthropic-messages">).compat?.allowedFallbackModels,
		source.compat?.allowedFallbackModels?.map((fallback) => ({ ...fallback, provider: "tinyllm" })),
	);
});

test("discovery sends the exact URL, bearer credential, and abort signal", async () => {
	const controller = new AbortController();
	let request: { input: string; init?: RequestInit } | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		request = { input: String(input), init };
		return Response.json({ data: [{ id: "anthropic/claude-sonnet-4-6" }] });
	}) as typeof fetch;

	const models = await discoverModels(
		"http://gateway.test/anthropic/",
		"fixture-key",
		controller.signal,
		fetchImpl,
		quiet,
	);
	assert.equal(models.length, 1);
	assert.equal(request?.input, "http://gateway.test/v1/models");
	assert.deepEqual(request?.init?.headers, { Authorization: "Bearer fixture-key" });
	assert.equal(request?.init?.signal, controller.signal);

	await assert.rejects(
		discoverModels("http://gateway.test", "fixture-key", controller.signal, async () => new Response("no", { status: 500 }), quiet),
		/HTTP 500/,
	);
	await assert.rejects(
		discoverModels("http://gateway.test", "fixture-key", controller.signal, async () => new Response("{"), quiet),
		/invalid JSON/,
	);
	const bodyController = new AbortController();
	await assert.rejects(
		discoverModels(
			"http://gateway.test",
			"fixture-key",
			bodyController.signal,
			async () => ({
				ok: true,
				status: 200,
				async json() {
					bodyController.abort();
					throw new SyntaxError("aborted body");
				},
			}) as Response,
			quiet,
		),
		(error: unknown) => error instanceof DOMException && error.name === "AbortError",
	);
	await assert.rejects(
		discoverModels(
			"http://gateway.test",
			"fixture-key",
			controller.signal,
			async () => Response.json({ models: [] }),
			quiet,
		),
		/invalid payload/,
	);
});

test("native auth prefers stored credentials, supports login, and stays unavailable without a key", async () => {
	const provider = createTinyllmProvider({ baseUrl: "http://default.test", warn: quiet });
	const auth = provider.auth.apiKey;
	assert.ok(auth?.resolve && auth.login);
	const signal = new AbortController().signal;
	const ctx = {
		async env(name: string) {
			return name === "TINYLLM_API_KEY" ? "environment-key" : "http://environment.test/anthropic";
		},
		async fileExists() {
			return false;
		},
	};

	const stored = await auth.resolve({ ctx, credential: { type: "api_key", key: "stored-key" }, signal });
	assert.deepEqual(stored, {
		auth: { apiKey: "stored-key", baseUrl: "http://environment.test" },
		env: { TINYLLM_BASE_URL: "http://environment.test" },
		source: "Stored API key",
	});
	const ambient = await auth.resolve({ ctx, signal });
	assert.equal(ambient?.auth.apiKey, "environment-key");
	assert.equal(
		await auth.resolve({ ctx: { ...ctx, env: async () => undefined }, signal }),
		undefined,
	);

	const prompts: string[] = [];
	const loggedIn = await auth.login({
		signal,
		prompt: async ({ type }) => {
			prompts.push(type);
			return type === "text" ? "http://login.test/v1/" : "login-key";
		},
		notify() {},
	});
	assert.deepEqual(prompts, ["text", "secret"]);
	assert.deepEqual(loggedIn, {
		type: "api_key",
		key: "login-key",
		env: { TINYLLM_BASE_URL: "http://login.test" },
	});
	const cancelled = new Error("cancelled");
	await assert.rejects(
		auth.login({ signal, prompt: async () => Promise.reject(cancelled), notify() {} }),
		(error) => error === cancelled,
	);
	const authController = new AbortController();
	await assert.rejects(
		auth.resolve({
			signal: authController.signal,
			ctx: {
				...ctx,
				async env() {
					authController.abort();
					return undefined;
				},
			},
		}),
		(error: unknown) => error instanceof DOMException && error.name === "AbortError",
	);
});

test("discovery diagnostics sanitize and bound server-controlled IDs", () => {
	const warnings: string[] = [];
	mapDiscoveredModels(
		[`unknown/${"x".repeat(200)}\nsecond line`],
		"http://gateway.test",
		(message) => warnings.push(message),
	);
	assert.equal(warnings.length, 1);
	assert.ok(!warnings[0].includes("\n"));
	assert.ok(warnings[0].length < 250);
});

test("successful catalogs persist; failed, malformed, and offline refreshes retain last-known-good", async () => {
	const store = new InMemoryModelsStore();
	let response: Response = Response.json({ data: [{ id: "anthropic/claude-sonnet-4-6" }] });
	const fetchImpl = (async () => response.clone()) as typeof fetch;
	const authContext = {
		async env(name: string) {
			return name === "TINYLLM_API_KEY" ? "fixture-key" : "http://gateway.test";
		},
		async fileExists() {
			return false;
		},
	};
	const models = createModels({ modelsStore: store, authContext });
	models.setProvider(createTinyllmProvider({ fetch: fetchImpl, warn: quiet }));

	let result = await models.refresh({ force: true });
	assert.equal(result.errors.size, 0);
	assert.deepEqual(models.getModels("tinyllm").map((model) => model.id), ["anthropic/claude-sonnet-4-6"]);
	assert.deepEqual((await store.read("tinyllm"))?.models.map((model) => model.id), ["anthropic/claude-sonnet-4-6"]);

	response = new Response("unavailable", { status: 500 });
	result = await models.refresh({ force: true });
	assert.equal(result.errors.size, 1);
	assert.deepEqual(models.getModels("tinyllm").map((model) => model.id), ["anthropic/claude-sonnet-4-6"]);

	response = Response.json({ wrong: [] });
	result = await models.refresh({ force: true });
	assert.equal(result.errors.size, 1);
	assert.deepEqual((await store.read("tinyllm"))?.models.map((model) => model.id), ["anthropic/claude-sonnet-4-6"]);

	const cold = createModels({ modelsStore: store, authContext });
	cold.setProvider(createTinyllmProvider({ fetch: async () => Promise.reject(new Error("offline")), warn: quiet }));
	result = await cold.refresh({ allowNetwork: false });
	assert.equal(result.errors.size, 0);
	assert.deepEqual(cold.getModels("tinyllm").map((model) => model.id), ["anthropic/claude-sonnet-4-6"]);
});

test("streaming routes each catalog API through TinyLLM without changing the public model ID", async (t) => {
	const requests: Array<{ path: string; authorization?: string; model?: string }> = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		let model: string | undefined;
		try {
			model = JSON.parse(body).model;
		} catch {}
		requests.push({
			path: request.url ?? "",
			authorization: request.headers.authorization,
			model,
		});
		response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "fixture stop" } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const provider = createTinyllmProvider({ baseUrl, warn: quiet });
	const models = mapDiscoveredModels(
		["anthropic/claude-sonnet-4-6", "openai/gpt-4.1", "deepseek/deepseek-v4-pro"],
		baseUrl,
		quiet,
	);
	const context = normalizeContext({
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	});

	for (const model of models) {
		const stream = provider.streamSimple(model, context, { apiKey: "fixture-key", maxRetries: 0 });
		for await (const _event of stream) {
			// Consume the terminal error emitted for the fixture's intentional 500.
		}
	}

	assert.deepEqual(
		requests.map(({ path, authorization, model }) => ({ path, authorization, model })),
		[
			{
				path: "/anthropic/v1/messages?beta=true",
				authorization: "Bearer fixture-key",
				model: "anthropic/claude-sonnet-4-6",
			},
			{ path: "/v1/responses", authorization: "Bearer fixture-key", model: "openai/gpt-4.1" },
			{
				path: "/v1/chat/completions",
				authorization: "Bearer fixture-key",
				model: "deepseek/deepseek-v4-pro",
			},
		],
	);
});

test("/fast toggles GPT payload routing, gates other models, survives model switches, and restores session state", async () => {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
			assert.equal(name, "fast");
			command = options.handler;
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	registerFastMode(pi);
	assert.ok(command);

	const notices: Array<[string, string]> = [];
	const gptModels = mapDiscoveredModels(["openai/gpt-4.1-fast", "openai/gpt-4.1"], "http://gateway.test", quiet);
	assert.equal(gptModels.length, 1);
	const gpt = gptModels[0];
	const anthropic = mapDiscoveredModels(["anthropic/claude-sonnet-4-6"], "http://gateway.test", quiet)[0];
	const context = (model: Model<Api>, branch: unknown[] = []) => ({
		model,
		ui: { notify: (message: string, level: string) => notices.push([message, level]) },
		sessionManager: { getBranch: () => branch },
	});
	const beforeRequest = handlers.get("before_provider_request")?.[0];
	const sessionStart = handlers.get("session_start")?.[0];
	assert.ok(beforeRequest && sessionStart);

	await command("", context(gpt));
	assert.deepEqual(entries.at(-1), { customType: "tinyllm-fast-mode", data: { enabled: true } });
	assert.deepEqual(
		await beforeRequest({ payload: { model: "openai/gpt-4.1", input: "hello" } }, context(gpt)),
		{ model: "openai/gpt-4.1-fast", input: "hello" },
	);
	const otherPayload = { model: anthropic.id };
	assert.equal(await beforeRequest({ payload: otherPayload }, context(anthropic)), otherPayload);
	assert.deepEqual(
		await beforeRequest({ payload: { model: "openai/gpt-4.1" } }, context(gpt)),
		{ model: "openai/gpt-4.1-fast" },
	);
	assert.deepEqual(rewriteFastPayload({ model: "openai/gpt-4.1-fast" }, true, gpt), {
		model: "openai/gpt-4.1-fast",
	});

	await command("", context(gpt));
	assert.deepEqual(
		await beforeRequest({ payload: { model: "openai/gpt-4.1" } }, context(gpt)),
		{ model: "openai/gpt-4.1" },
	);
	const entryCount = entries.length;
	await command("", context(anthropic));
	assert.equal(entries.length, entryCount);
	assert.match(notices.at(-1)?.[0] ?? "", /only available/);
	assert.equal(notices.at(-1)?.[1], "warning");

	await sessionStart(
		{},
		context(gpt, [{ type: "custom", customType: "tinyllm-fast-mode", data: { enabled: true } }]),
	);
	assert.deepEqual(
		await beforeRequest({ payload: { model: "openai/gpt-4.1" } }, context(gpt)),
		{ model: "openai/gpt-4.1-fast" },
	);
});

test("bounded bootstrap uses the provider refresh path without an extension cache", async () => {
	const provider = createTinyllmProvider({
		baseUrl: "http://gateway.test",
		fetch: async () => Response.json({ data: [{ id: "anthropic/claude-sonnet-4-6" }] }),
		warn: quiet,
	});
	await bootstrapProvider(provider, "fixture-key", "http://gateway.test");
	assert.deepEqual(provider.getModels().map((model) => model.id), ["anthropic/claude-sonnet-4-6"]);
});

test("base URL normalization accepts gateway, Anthropic, and OpenAI forms", () => {
	assert.equal(normalizeBaseUrl("http://localhost:8080/"), "http://localhost:8080");
	assert.equal(normalizeBaseUrl("http://localhost:8080/anthropic"), "http://localhost:8080");
	assert.equal(normalizeBaseUrl("http://localhost:8080/v1/"), "http://localhost:8080");
});
