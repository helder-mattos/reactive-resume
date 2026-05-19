import type { LaminarObservabilityConfig } from "@reactive-resume/ai/observability";
import type { AIProvider } from "@reactive-resume/ai/types";
import type { AIObservabilityTelemetry } from "../types";
import { Laminar, observe } from "@lmnr-ai/lmnr";

let laminarConfigFingerprint: string | null = null;

function parseLaminarPort(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;

	const parsed = Number.parseInt(trimmed, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function resolveLaminarConfig(config: LaminarObservabilityConfig) {
	const projectApiKey = config.projectApiKey.trim();
	const httpPort = parseLaminarPort(config.httpPort);
	const grpcPort = parseLaminarPort(config.grpcPort);

	if (projectApiKey.length === 0) {
		return null;
	}

	return {
		projectApiKey,
		...(httpPort ? { httpPort } : {}),
		...(grpcPort ? { grpcPort } : {}),
		...(config.baseUrl.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
	};
}

async function ensureLaminarInitialized(
	config: NonNullable<ReturnType<typeof resolveLaminarConfig>>,
): Promise<boolean> {
	const fingerprint = JSON.stringify(config);

	if (Laminar.initialized() && laminarConfigFingerprint === fingerprint) return true;

	if (Laminar.initialized() && laminarConfigFingerprint !== fingerprint) {
		return false;
	}

	try {
		Laminar.initialize(config);
		laminarConfigFingerprint = fingerprint;
		return true;
	} catch {
		laminarConfigFingerprint = null;
		return false;
	}
}

type WithLaminarObservabilityInput = {
	config: LaminarObservabilityConfig;
	modelProvider: AIProvider;
	operationName: string;
	metadata: Record<string, unknown>;
};

export async function withLaminarObservability<T>(
	input: WithLaminarObservabilityInput,
	execute: (telemetry: AIObservabilityTelemetry | undefined) => Promise<T>,
): Promise<T> {
	const config = resolveLaminarConfig(input.config);
	if (!config) return execute(undefined);

	const initialized = await ensureLaminarInitialized(config);
	if (!initialized) return execute(undefined);

	// AI SDK v7 dropped the per-call `tracer` option in favour of registered telemetry
	// integrations. Laminar.initialize() installs the global OpenTelemetry provider, and
	// the observe() wrapper below still records the operation span.
	const telemetry: AIObservabilityTelemetry = { isEnabled: true };

	return observe(
		{
			name: input.operationName,
			tags: ["ai", "laminar", input.modelProvider, "request"],
			metadata: { ...input.metadata, observabilityProvider: "laminar" },
		},
		async () => execute(telemetry),
	);
}
