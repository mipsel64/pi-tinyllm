import {
	createProvider,
	type Api,
	type Model,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const MAX_DIAGNOSTIC_IDS = 5;
const MAX_DIAGNOSTIC_ID_LENGTH = 120;
const SUPPORTED_APIS = new Map<Api, Api>([
	["anthropic-messages", "anthropic-messages"],
	["openai-completions", "openai-completions"],
	["openai-responses", "openai-responses"],
	["openai-codex-responses", "openai-responses"],
	["azure-openai-responses", "openai-responses"],
]);

type Warn = (message: string) => void;
type BuiltinProvider = ReturnType<typeof getBuiltinProviders>[number];
type CatalogMap = ReadonlyMap<string, BuiltinProvider>;

export interface TinyllmProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	warn?: Warn;
}

export function normalizeBaseUrl(value: string): string {
	const baseUrl = value.trim().replace(/\/+$/, "");
	return baseUrl.replace(/\/(?:anthropic|v1)$/, "");
}

export function apiBaseUrl(baseUrl: string, api: Api): string {
	const root = normalizeBaseUrl(baseUrl);
	return api === "anthropic-messages" ? `${root}/anthropic` : `${root}/v1`;
}

function isBuiltinProvider(value: string): value is BuiltinProvider {
	return getBuiltinProviders().includes(value as BuiltinProvider);
}

function catalogCandidates(prefix: string, catalog?: BuiltinProvider): BuiltinProvider[] {
	if (catalog) return [catalog];
	if (prefix === "openai") return ["openai-codex", "openai"];
	if (prefix === "codex") return ["openai-codex"];
	return isBuiltinProvider(prefix) ? [prefix] : [];
}

function diagnostic(value: string): string {
	const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
	return sanitized.length > MAX_DIAGNOSTIC_ID_LENGTH
		? `${sanitized.slice(0, MAX_DIAGNOSTIC_ID_LENGTH - 3)}...`
		: sanitized;
}

function warnOmitted(label: string, omitted: string[], count: number, warn: Warn): void {
	if (omitted.length === 0) return;
	const suffix = count > omitted.length ? ` (+${count - omitted.length} more)` : "";
	warn(`TinyLLM omitted ${label}: ${omitted.join(", ")}${suffix}`);
}

function providerCatalogs(
	value: unknown,
	warn: Warn,
): { catalogs: Map<string, BuiltinProvider>; ids: string[] } {
	const catalogs = new Map<string, BuiltinProvider>();
	const ids: string[] = [];
	if (value === undefined) return { catalogs, ids };
	const entries = Array.isArray(value) ? value : [undefined];
	const omitted: string[] = [];
	let omittedCount = 0;
	const omit = (description: string) => {
		omittedCount++;
		if (omitted.length < MAX_DIAGNOSTIC_IDS) omitted.push(diagnostic(description));
	};

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") {
			omit("<invalid provider>");
			continue;
		}
		const { id, type, auth } = entry as { id?: unknown; type?: unknown; auth?: unknown };
		if (
			typeof id !== "string"
			|| !/^[A-Za-z0-9_.-]{1,64}$/.test(id)
			|| typeof type !== "string"
			|| (type === "openai" && auth !== "api_key" && auth !== "subscription")
		) {
			omit(typeof id === "string" && typeof type === "string" ? `${id}:${type}` : "<invalid provider>");
			continue;
		}
		const catalogName = type === "openai" && auth === "subscription" ? "openai-codex" : type;
		if (!isBuiltinProvider(catalogName)) {
			omit(`${id}:${type}`);
			continue;
		}
		if (catalogs.has(id)) continue;
		catalogs.set(id, catalogName);
		for (const model of getBuiltinModels(catalogName)) ids.push(`${id}/${model.id}`);
	}

	warnOmitted("invalid or unsupported providers", omitted, omittedCount, warn);
	return { catalogs, ids };
}

function parsePublicId(publicId: string): { prefix: string; nativeId: string } | undefined {
	if (publicId !== publicId.trim() || publicId.includes("//")) return undefined;
	const slash = publicId.indexOf("/");
	if (slash <= 0 || slash === publicId.length - 1) return undefined;
	return { prefix: publicId.slice(0, slash), nativeId: publicId.slice(slash + 1) };
}

function lookupCatalogModel(
	prefix: string,
	nativeId: string,
	catalogs: CatalogMap,
): Model<Api> | undefined {
	for (const provider of catalogCandidates(prefix, catalogs.get(prefix))) {
		const model = getBuiltinModels(provider).find((candidate) => candidate.id === nativeId);
		if (model) return model as Model<Api>;
	}
	return undefined;
}

function routedCompat(source: Model<Api>, api: Api): Model<Api>["compat"] {
	if (api !== "anthropic-messages") return source.compat;
	const compat = source.compat as Model<"anthropic-messages">["compat"];
	if (!compat?.allowedFallbackModels) return compat;
	return {
		...compat,
		allowedFallbackModels: compat.allowedFallbackModels.map((fallback) => ({
			...fallback,
			provider: "tinyllm",
		})),
	};
}

export function mapDiscoveredModels(
	ids: readonly unknown[],
	baseUrl: string,
	warn: Warn = console.warn,
	catalogs: CatalogMap = new Map(),
): Model<Api>[] {
	const models: Model<Api>[] = [];
	const seen = new Set<string>();
	const omitted: string[] = [];
	let omittedCount = 0;
	const omit = (id: string) => {
		omittedCount++;
		if (omitted.length < MAX_DIAGNOSTIC_IDS) omitted.push(diagnostic(id));
	};

	for (const value of ids) {
		if (typeof value !== "string") {
			omit("<invalid id>");
			continue;
		}
		const discovered = parsePublicId(value);
		const discoveredCatalog = discovered ? catalogs.get(discovered.prefix) : undefined;
		if (
			discovered
			&& (discovered.prefix === "openai"
				|| discovered.prefix === "codex"
				|| discoveredCatalog === "openai"
				|| discoveredCatalog === "openai-codex")
			&& discovered.nativeId.startsWith("gpt-")
			&& discovered.nativeId.endsWith("-fast")
		) {
			continue;
		}
		const publicId = value;
		if (seen.has(publicId)) continue;
		seen.add(publicId);
		const parsed = parsePublicId(publicId);
		const source = parsed ? lookupCatalogModel(parsed.prefix, parsed.nativeId, catalogs) : undefined;
		const api = source ? SUPPORTED_APIS.get(source.api) : undefined;
		if (!parsed || !source || !api) {
			omit(value);
			continue;
		}
		models.push({
			...source,
			id: publicId,
			provider: "tinyllm",
			api,
			baseUrl: apiBaseUrl(baseUrl, api),
			compat: routedCompat(source, api),
		});
	}

	warnOmitted("unknown, malformed, or unsupported models", omitted, omittedCount, warn);
	return models;
}

export async function discoverModels(
	baseUrl: string,
	apiKey: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	warn: Warn = console.warn,
): Promise<Model<Api>[]> {
	const root = normalizeBaseUrl(baseUrl);
	const request = {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	};
	let modelKey: "configured_models" | "data" = "configured_models";
	let response = await fetchImpl(`${root}/api/v1/models`, request);
	if (response.status === 404) {
		modelKey = "data";
		response = await fetchImpl(`${root}/v1/models`, request);
	}
	if (!response.ok) throw new Error(`TinyLLM model discovery failed with HTTP ${response.status}`);

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		signal.throwIfAborted();
		throw new Error("TinyLLM model discovery returned invalid JSON", { cause: error });
	}
	if (!payload || typeof payload !== "object") {
		throw new Error("TinyLLM model discovery returned an invalid payload");
	}
	const body = payload as Record<string, unknown>;
	const configuredModels = body[modelKey];
	if (!Array.isArray(configuredModels)) {
		throw new Error("TinyLLM model discovery returned an invalid payload");
	}
	const discovery = providerCatalogs(body.providers, warn);
	return mapDiscoveredModels(
		[
			...configuredModels.map((entry) =>
				entry && typeof entry === "object" && "id" in entry ? (entry as { id?: unknown }).id : undefined,
			),
			...discovery.ids,
		],
		baseUrl,
		warn,
		discovery.catalogs,
	);
}

function routedStreams(delegate: ProviderStreams, api: Api): ProviderStreams {
	const route = <T extends Model<Api>>(model: T): T =>
		({ ...model, api, provider: "tinyllm", baseUrl: apiBaseUrl(model.baseUrl, api) }) as T;
	const routeOptions = <T extends { apiKey?: string; headers?: Record<string, string> } | undefined>(options: T): T => {
		if (api !== "anthropic-messages" || !options?.apiKey) return options;
		return {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${options.apiKey}` },
		} as T;
	};
	return {
		stream: (model, context, options) => delegate.stream(route(model), context, routeOptions(options)),
		streamSimple: (model, context, options) => delegate.streamSimple(route(model), context, routeOptions(options)),
	};
}

export function createTinyllmProvider(options: TinyllmProviderOptions = {}): Provider<Api> {
	const defaultBaseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.TINYLLM_BASE_URL ?? DEFAULT_BASE_URL);
	const warn = options.warn ?? console.warn;
	const fetchImpl = options.fetch ?? fetch;

	return createProvider<Api>({
		id: "tinyllm",
		name: "TinyLLM",
		baseUrl: defaultBaseUrl,
		auth: {
			apiKey: {
				name: "TinyLLM API key",
				async login({ prompt, signal }) {
					signal.throwIfAborted();
					const enteredBaseUrl = await prompt({
						type: "text",
						message: "TinyLLM URL",
						placeholder: defaultBaseUrl,
					});
					signal.throwIfAborted();
					const key = await prompt({ type: "secret", message: "TinyLLM API key" });
					signal.throwIfAborted();
					return {
						type: "api_key",
						key,
						env: { TINYLLM_BASE_URL: normalizeBaseUrl(enteredBaseUrl || defaultBaseUrl) },
					};
				},
				async resolve({ ctx, credential, signal }) {
					signal.throwIfAborted();
					const key = credential?.key ?? (await ctx.env("TINYLLM_API_KEY"));
					signal.throwIfAborted();
					if (!key) return undefined;
					const configuredBaseUrl = credential?.env?.TINYLLM_BASE_URL ?? (await ctx.env("TINYLLM_BASE_URL"));
					signal.throwIfAborted();
					const baseUrl = normalizeBaseUrl(configuredBaseUrl ?? defaultBaseUrl);
					return {
						auth: { apiKey: key, baseUrl },
						env: { TINYLLM_BASE_URL: baseUrl },
						source: credential?.key !== undefined ? "Stored API key" : "TINYLLM_API_KEY",
					};
				},
			},
		},
		models: [],
		fetchModels: async ({ credential, signal }) => {
			if (credential?.type !== "api_key" || !credential.key) {
				throw new Error("TinyLLM API key is not configured");
			}
			return discoverModels(
				credential.env?.TINYLLM_BASE_URL ?? defaultBaseUrl,
				credential.key,
				signal,
				fetchImpl,
				warn,
			);
		},
		api: {
			"anthropic-messages": routedStreams(anthropicMessagesApi(), "anthropic-messages"),
			"openai-responses": routedStreams(openAIResponsesApi(), "openai-responses"),
			"openai-completions": routedStreams(openAICompletionsApi(), "openai-completions"),
		},
	});
}

export async function bootstrapProvider(provider: Provider<Api>, apiKey: string, baseUrl: string): Promise<void> {
	if (!provider.refreshModels) return;
	const signal = AbortSignal.timeout(5_000);
	await provider.refreshModels({
		credential: { type: "api_key", key: apiKey, env: { TINYLLM_BASE_URL: normalizeBaseUrl(baseUrl) } },
		allowNetwork: true,
		signal,
		async publish({ update }) {
			update?.();
			return true;
		},
	});
}

export function isFastCapable(model: Pick<Model<Api>, "provider" | "id"> | undefined): boolean {
	return model?.provider === "tinyllm" && /^[^/]+\/gpt-.+/.test(model.id) && !model.id.endsWith("-fast");
}

export function rewriteFastPayload(
	payload: unknown,
	enabled: boolean,
	model: Pick<Model<Api>, "provider" | "id"> | undefined,
): unknown {
	if (!enabled || !isFastCapable(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	const request = payload as Record<string, unknown>;
	if (typeof request.model !== "string" || request.model !== model.id || request.model.endsWith("-fast")) return payload;
	return { ...request, model: `${request.model}-fast` };
}

const PROVIDER_STATUS = "model-provider";
const FAST_STATE = "tinyllm-fast-mode";

export function registerProviderStatus(pi: ExtensionAPI): void {
	const update = (ctx: ExtensionContext, provider = ctx.model?.provider) =>
		ctx.ui.setStatus(PROVIDER_STATUS, provider ? `[${provider}]` : undefined);
	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("session_tree", (_event, ctx) => update(ctx));
	pi.on("model_select", (event, ctx) => update(ctx, event.model.provider));
}

export function registerFastMode(pi: ExtensionAPI): void {
	let enabled = false;
	const updateStatus = (ctx: ExtensionContext) => ctx.ui.setStatus(FAST_STATE, enabled ? "fast" : undefined);
	const restore = (ctx: ExtensionContext) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === FAST_STATE) {
				enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
			}
		}
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_provider_request", (event, ctx) => rewriteFastPayload(event.payload, enabled, ctx.model));
	pi.registerCommand("fast", {
		description: "Toggle TinyLLM fast routing for the selected OpenAI GPT model",
		handler: async (_args, ctx) => {
			if (!isFastCapable(ctx.model)) {
				ctx.ui.notify("/fast is only available for TinyLLM OpenAI GPT models", "warning");
				return;
			}
			enabled = !enabled;
			pi.appendEntry(FAST_STATE, { enabled });
			updateStatus(ctx);
			ctx.ui.notify(`TinyLLM fast routing ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}

export default async function tinyllmExtension(pi: ExtensionAPI): Promise<void> {
	registerProviderStatus(pi);
	registerFastMode(pi);
	const baseUrl = process.env.TINYLLM_BASE_URL ?? DEFAULT_BASE_URL;
	const provider = createTinyllmProvider({ baseUrl });
	const apiKey = process.env.TINYLLM_API_KEY;
	if (apiKey) {
		try {
			await bootstrapProvider(provider, apiKey, baseUrl);
		} catch (error) {
			console.warn(`TinyLLM startup discovery unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	pi.registerProvider(provider);
}
