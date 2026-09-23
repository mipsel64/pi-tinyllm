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

function catalogCandidates(prefix: string): string[] {
	if (prefix === "openai") return ["openai-codex", "openai"];
	if (prefix === "codex") return ["openai-codex"];
	return getBuiltinProviders().includes(prefix as ReturnType<typeof getBuiltinProviders>[number]) ? [prefix] : [];
}

function parsePublicId(publicId: string): { prefix: string; nativeId: string } | undefined {
	if (publicId !== publicId.trim() || publicId.includes("//")) return undefined;
	const slash = publicId.indexOf("/");
	if (slash <= 0 || slash === publicId.length - 1) return undefined;
	return { prefix: publicId.slice(0, slash), nativeId: publicId.slice(slash + 1) };
}

function lookupCatalogModel(prefix: string, nativeId: string): Model<Api> | undefined {
	for (const provider of catalogCandidates(prefix)) {
		const model = getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]).find(
			(candidate) => candidate.id === nativeId,
		);
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
): Model<Api>[] {
	const models: Model<Api>[] = [];
	const seen = new Set<string>();
	const omitted: string[] = [];
	let omittedCount = 0;
	const omit = (id: string) => {
		omittedCount++;
		const sanitized = id.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
		const display = sanitized.length > MAX_DIAGNOSTIC_ID_LENGTH
			? `${sanitized.slice(0, MAX_DIAGNOSTIC_ID_LENGTH - 3)}...`
			: sanitized;
		if (omitted.length < MAX_DIAGNOSTIC_IDS) omitted.push(display);
	};

	for (const value of ids) {
		if (typeof value !== "string") {
			omit("<invalid id>");
			continue;
		}
		const discovered = parsePublicId(value);
		if (
			discovered?.prefix === "openai"
			&& discovered.nativeId.startsWith("gpt-")
			&& discovered.nativeId.endsWith("-fast")
		) {
			continue;
		}
		const publicId = value;
		if (seen.has(publicId)) continue;
		seen.add(publicId);
		const parsed = parsePublicId(publicId);
		const source = parsed ? lookupCatalogModel(parsed.prefix, parsed.nativeId) : undefined;
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

	if (omitted.length > 0) {
		const suffix = omittedCount > omitted.length ? ` (+${omittedCount - omitted.length} more)` : "";
		warn(`TinyLLM omitted unknown, malformed, or unsupported models: ${omitted.join(", ")}${suffix}`);
	}
	return models;
}

export async function discoverModels(
	baseUrl: string,
	apiKey: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	warn: Warn = console.warn,
): Promise<Model<Api>[]> {
	const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/v1/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!response.ok) throw new Error(`TinyLLM model discovery failed with HTTP ${response.status}`);

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		signal.throwIfAborted();
		throw new Error("TinyLLM model discovery returned invalid JSON", { cause: error });
	}
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		throw new Error("TinyLLM model discovery returned an invalid payload");
	}
	return mapDiscoveredModels(
		payload.data.map((entry) =>
			entry && typeof entry === "object" && "id" in entry ? (entry as { id?: unknown }).id : undefined,
		),
		baseUrl,
		warn,
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
	return model?.provider === "tinyllm" && /^openai\/gpt-.+/.test(model.id) && !model.id.endsWith("-fast");
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

const FAST_STATE = "tinyllm-fast-mode";

export function registerFastMode(pi: ExtensionAPI): void {
	let enabled = false;
	const restore = (ctx: ExtensionContext) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === FAST_STATE) {
				enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
			}
		}
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_provider_request", (event, ctx) => rewriteFastPayload(event.payload, enabled, ctx.model));
	pi.registerCommand("fast", {
		description: "Toggle TinyLLM fast routing for the selected OpenAI GPT model",
		handler: async (_args, ctx) => {
			if (!isFastCapable(ctx.model)) {
				ctx.ui.notify("/fast is only available for TinyLLM openai/gpt-* models", "warning");
				return;
			}
			enabled = !enabled;
			pi.appendEntry(FAST_STATE, { enabled });
			ctx.ui.notify(`TinyLLM fast routing ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}

export default async function tinyllmExtension(pi: ExtensionAPI): Promise<void> {
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
