/**
 * Cursor model discovery via GetUsableModels gRPC endpoint.
 * Uses curl for HTTP/2 transport.
 * Falls back to a hardcoded list if the endpoint is unreachable.
 * Adapted from opencode-cursor for Node.js runtime.
 */
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "./proto/agent_pb.js";

const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

export interface CursorModel {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

const FALLBACK_MODELS: CursorModel[] = [
	{ id: "composer-2", name: "Composer 2", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-4-sonnet", name: "Claude 4 Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 },
	{ id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "cursor-small", name: "Cursor Small", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
];

function buildRequestHeaders(apiKey: string): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}

async function fetchViaHttp2(
	baseUrl: string,
	body: Uint8Array,
	apiKey: string,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const reqPath = join(tmpdir(), `cursor-req-${Date.now()}.bin`);
	const respPath = join(tmpdir(), `cursor-resp-${Date.now()}.bin`);
	try {
		writeFileSync(reqPath, body);
		const headers = buildRequestHeaders(apiKey);
		const headerArgs = Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]);
		const timeoutSecs = Math.ceil(timeoutMs / 1000);
		const url = `${baseUrl}${GET_USABLE_MODELS_PATH}`;
		const args = [
			"curl",
			"-s",
			"--http2",
			"--max-time",
			String(timeoutSecs),
			"-X",
			"POST",
			...headerArgs,
			"--data-binary",
			`@${reqPath}`,
			"-o",
			respPath,
			"-w",
			"%{http_code}",
			url,
		];
		const status = execSync(args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "), {
			timeout: timeoutMs + 2000,
			stdio: ["pipe", "pipe", "pipe"],
		})
			.toString()
			.trim();
		if (!status.startsWith("2")) return null;
		if (!existsSync(respPath)) return null;
		return new Uint8Array(readFileSync(respPath));
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(reqPath);
		} catch {}
		try {
			unlinkSync(respPath);
		} catch {}
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) return null;

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset]!;
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) return null;

		if ((flags & 0b0000_0001) !== 0) return null;
		if (!((flags & 0b0000_0010) !== 0)) {
			return payload.subarray(offset + 5, frameEnd);
		}
		offset = frameEnd;
	}
	return null;
}

function decodeGetUsableModelsResponse(payload: Uint8Array): any {
	if (payload.length === 0) return null;

	const framedBody = decodeConnectUnaryBody(payload);
	if (framedBody) {
		try {
			return fromBinary(GetUsableModelsResponseSchema, framedBody);
		} catch {
			return null;
		}
	}

	try {
		return fromBinary(GetUsableModelsResponseSchema, payload);
	} catch {
		return null;
	}
}

function pickDisplayName(model: any, fallbackId: string): string {
	const candidates = [model.displayName, model.displayNameShort, model.displayModelId, ...(model.aliases ?? []), fallbackId];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) return trimmed;
	}
	return fallbackId;
}

function normalizeSingleModel(model: unknown): CursorModel | null {
	if (!model || typeof model !== "object") return null;
	const m = model as any;
	const id = (m.modelId ?? "").trim();
	if (!id) return null;

	return {
		id,
		name: pickDisplayName(m, id),
		reasoning: Boolean(m.thinkingDetails),
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

function normalizeCursorModels(models: readonly unknown[] | undefined): CursorModel[] {
	if (!models || models.length === 0) return [];

	const byId = new Map<string, CursorModel>();
	for (const model of models) {
		const normalized = normalizeSingleModel(model);
		if (normalized) byId.set(normalized.id, normalized);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchCursorUsableModels(apiKey: string): Promise<CursorModel[] | null> {
	const timeoutMs = 5_000;
	try {
		const requestPayload = create(GetUsableModelsRequestSchema, {});
		const body = toBinary(GetUsableModelsRequestSchema, requestPayload);

		const responseBuffer = await fetchViaHttp2(CURSOR_BASE_URL, body, apiKey, timeoutMs);
		if (!responseBuffer) return null;

		const decoded = decodeGetUsableModelsResponse(responseBuffer);
		if (!decoded?.models) return null;

		return normalizeCursorModels(decoded.models);
	} catch {
		return null;
	}
}

export async function getCursorModels(apiKey: string): Promise<CursorModel[]> {
	const discovered = await fetchCursorUsableModels(apiKey);
	return discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;
}
