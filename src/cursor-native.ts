import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	AssistantMessageSchema,
	BackgroundShellSpawnResultSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DiagnosticsResultSchema,
	ExecClientMessageSchema,
	FetchErrorSchema,
	FetchResultSchema,
	GetBlobResultSchema,
	GrepErrorSchema,
	GrepResultSchema,
	KvClientMessageSchema,
	LsRejectedSchema,
	LsResultSchema,
	McpErrorSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolDefinitionSchema,
	McpToolResultContentItemSchema,
	ModelDetailsSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	SetBlobResultSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	type AgentServerMessage,
	type ExecServerMessage,
	type KvServerMessage,
	type McpToolDefinition,
} from "./proto/agent_pb.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CURSOR_API_URL = "https://api2.cursor.sh";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const BRIDGE_PATH = pathResolve(__dirname, "cursor-h2-bridge.mjs");
const TOOL_BATCH_SETTLE_MS = 30;
const HEARTBEAT_INTERVAL_MS = 5_000;

export interface CursorNativeToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface CursorNativeMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
}

export interface CursorNativeToolDef {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface CursorNativeTurnOptions {
	sessionKey: string;
	accessToken: string;
	modelId: string;
	messages: CursorNativeMessage[];
	tools?: CursorNativeToolDef[];
	signal?: AbortSignal;
	onText(text: string): void;
	onThinking(text: string): void;
	onToolCalls(calls: CursorNativeToolCall[]): void;
}

export interface CursorNativeTurnResult {
	stopReason: "stop" | "toolUse";
	conversationId: string;
}

interface CursorRequestPayload {
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	mcpTools: McpToolDefinition[];
}

interface ToolResultInfo {
	toolCallId: string;
	content: string;
}

interface ParsedMessages {
	systemPrompt: string;
	userText: string;
	turns: Array<{ userText: string; assistantText: string }>;
	toolResults: ToolResultInfo[];
}

interface PendingExec {
	execId: string;
	execMsgId: number;
	toolCallId: string;
	toolName: string;
	decodedArgs: string;
}

interface ActiveBridge {
	bridge: ReturnType<typeof spawnBridge>;
	heartbeatTimer: NodeJS.Timeout;
	blobStore: Map<string, Uint8Array>;
	mcpTools: McpToolDefinition[];
	pendingExecs: PendingExec[];
	onClose: (() => void) | null;
}

interface CursorSessionState {
	conversationId: string;
	modelId: string;
}

const ACTIVE_BRIDGES = new Map<string, ActiveBridge>();
const SESSION_STATE = new Map<string, CursorSessionState>();

function lpEncode(data: Uint8Array): Buffer {
	const buf = Buffer.alloc(4 + data.length);
	buf.writeUInt32BE(data.length, 0);
	buf.set(data, 4);
	return buf;
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function makeHeartbeatBytes(): Uint8Array {
	const heartbeat = create(AgentClientMessageSchema, {
		message: {
			case: "clientHeartbeat",
			value: create(ClientHeartbeatSchema, {}),
		},
	});
	return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

function spawnBridge(accessToken: string): {
	proc: ChildProcess;
	write: (data: Uint8Array) => void;
	end: () => void;
	onData: (cb: (chunk: Buffer) => void) => void;
	onClose: (cb: (code: number) => void) => void;
} {
	const proc = spawn("node", [BRIDGE_PATH], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	let closed = false;

	const config = JSON.stringify({
		accessToken,
		url: CURSOR_API_URL,
		path: "/agent.v1.AgentService/Run",
	});
	proc.stdin!.on("error", () => {
		closed = true;
	});
	proc.stdin!.write(lpEncode(new TextEncoder().encode(config)));

	const callbacks = {
		data: null as ((chunk: Buffer) => void) | null,
		close: null as ((code: number) => void) | null,
	};

	let pending = Buffer.alloc(0);
	proc.stdout!.on("data", (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const len = pending.readUInt32BE(0);
			if (pending.length < 4 + len) break;
			const payload = pending.subarray(4, 4 + len);
			pending = pending.subarray(4 + len);
			callbacks.data?.(Buffer.from(payload));
		}
	});

	proc.on("close", (code) => {
		closed = true;
		callbacks.close?.(code ?? 1);
	});

	return {
		proc,
		write(data) {
			if (closed || !proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded) return;
			try {
				proc.stdin!.write(lpEncode(data));
			} catch {}
		},
		end() {
			if (closed || !proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded) return;
			try {
				proc.stdin!.write(lpEncode(new Uint8Array(0)));
				proc.stdin!.end();
			} catch {}
		},
		onData(cb) {
			callbacks.data = cb;
		},
		onClose(cb) {
			callbacks.close = cb;
		},
	};
}

function buildMcpToolDefinitions(tools: CursorNativeToolDef[]): McpToolDefinition[] {
	return tools.map((tool) => {
		const jsonSchema: JsonValue =
			tool.function.parameters && typeof tool.function.parameters === "object"
				? (tool.function.parameters as JsonValue)
				: { type: "object", properties: {}, required: [] };
		const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
		return create(McpToolDefinitionSchema, {
			name: tool.function.name,
			description: tool.function.description || "",
			providerIdentifier: "pi",
			toolName: tool.function.name,
			inputSchema,
		});
	});
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		const parsed = fromBinary(ValueSchema, value);
		return toJson(ValueSchema, parsed);
	} catch {
		return new TextDecoder().decode(value);
	}
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		decoded[key] = decodeMcpArgValue(value);
	}
	return decoded;
}

function parseMessages(messages: CursorNativeMessage[]): ParsedMessages {
	let systemPrompt = "You are a helpful assistant.";
	const pairs: Array<{ userText: string; assistantText: string }> = [];
	const toolResults: ToolResultInfo[] = [];

	const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content ?? "");
	if (systemParts.length > 0) {
		systemPrompt = systemParts.join("\n");
	}

	const nonSystem = messages.filter((m) => m.role !== "system");
	let pendingUser = "";

	for (const message of nonSystem) {
		if (message.role === "tool") {
			toolResults.push({
				toolCallId: message.tool_call_id ?? "",
				content: message.content ?? "",
			});
			continue;
		}
		if (message.role === "user") {
			if (pendingUser) {
				pairs.push({ userText: pendingUser, assistantText: "" });
			}
			pendingUser = message.content ?? "";
			continue;
		}
		if (message.role === "assistant") {
			const text = message.content ?? "";
			if (pendingUser) {
				pairs.push({ userText: pendingUser, assistantText: text });
				pendingUser = "";
			}
		}
	}

	let lastUserText = "";
	if (pendingUser) {
		lastUserText = pendingUser;
	} else if (pairs.length > 0 && toolResults.length === 0) {
		const last = pairs.pop()!;
		lastUserText = last.userText;
	}

	return { systemPrompt, userText: lastUserText, turns: pairs, toolResults };
}

function buildCursorRequest(
	modelId: string,
	systemPrompt: string,
	userText: string,
	turns: Array<{ userText: string; assistantText: string }>,
	conversationId: string,
): CursorRequestPayload {
	const blobStore = new Map<string, Uint8Array>();
	const turnBytes: Uint8Array[] = [];

	for (const turn of turns) {
		const userMessage = create(UserMessageSchema, {
			text: turn.userText,
			messageId: randomUUID(),
		});
		const userMessageBytes = toBinary(UserMessageSchema, userMessage);

		const stepBytes: Uint8Array[] = [];
		if (turn.assistantText) {
			const step = create(ConversationStepSchema, {
				message: {
					case: "assistantMessage",
					value: create(AssistantMessageSchema, { text: turn.assistantText }),
				},
			});
			stepBytes.push(toBinary(ConversationStepSchema, step));
		}

		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBytes,
			steps: stepBytes,
		});
		const turnStructure = create(ConversationTurnStructureSchema, {
			turn: { case: "agentConversationTurn", value: agentTurn },
		});
		turnBytes.push(toBinary(ConversationTurnStructureSchema, turnStructure));
	}

	const systemJson = JSON.stringify({ role: "system", content: systemPrompt });
	const systemBytes = new TextEncoder().encode(systemJson);
	const systemBlobId = new Uint8Array(createHash("sha256").update(systemBytes).digest());
	blobStore.set(Buffer.from(systemBlobId).toString("hex"), systemBytes);

	const conversationState = create(ConversationStateStructureSchema, {
		rootPromptMessagesJson: [systemBlobId],
		turns: turnBytes,
		todos: [],
		pendingToolCalls: [],
		previousWorkspaceUris: [],
		fileStates: {},
		fileStatesV2: {},
		summaryArchives: [],
		turnTimings: [],
		subagentStates: {},
		selfSummaryCount: 0,
		readPaths: [],
	});

	const userMessage = create(UserMessageSchema, {
		text: userText,
		messageId: randomUUID(),
	});
	const action = create(ConversationActionSchema, {
		action: {
			case: "userMessageAction",
			value: create(UserMessageActionSchema, { userMessage }),
		},
	});

	const modelDetails = create(ModelDetailsSchema, {
		modelId,
		displayModelId: modelId,
		displayName: modelId,
	});

	const runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		conversationId,
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});

	return {
		requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
		blobStore,
		mcpTools: [],
	};
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		const error = payload?.error;
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : "Unknown error";
			return new Error(`Connect error ${code}: ${message}`);
		}
		return null;
	} catch {
		return new Error("Failed to parse Connect end stream");
	}
}

function handleKvMessage(
	kvMessage: KvServerMessage,
	blobStore: Map<string, Uint8Array>,
	sendFrame: (data: Uint8Array) => void,
): void {
	const kvCase = kvMessage.message.case;

	if (kvCase === "getBlobArgs") {
		const blobId = kvMessage.message.value.blobId;
		const blobKey = Buffer.from(blobId).toString("hex");
		const blobData = blobStore.get(blobKey);

		const response = create(KvClientMessageSchema, {
			id: kvMessage.id,
			message: {
				case: "getBlobResult",
				value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
			},
		});

		const clientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});
		sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
		return;
	}

	if (kvCase === "setBlobArgs") {
		const { blobId, blobData } = kvMessage.message.value;
		blobStore.set(Buffer.from(blobId).toString("hex"), blobData);

		const response = create(KvClientMessageSchema, {
			id: kvMessage.id,
			message: {
				case: "setBlobResult",
				value: create(SetBlobResultSchema, {}),
			},
		});
		const clientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});
		sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	}
}

function sendExecResult(
	execMessage: ExecServerMessage,
	messageCase: string,
	value: unknown,
	sendFrame: (data: Uint8Array) => void,
): void {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execMessage.id,
		execId: execMessage.execId,
		message: { case: messageCase as any, value: value as any },
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientMessage", value: execClientMessage },
	});
	sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

function handleExecMessage(
	execMessage: ExecServerMessage,
	mcpTools: McpToolDefinition[],
	sendFrame: (data: Uint8Array) => void,
	onMcpExec: (exec: PendingExec) => void,
): void {
	const execCase = execMessage.message.case;

	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, {
			rules: [],
			repositoryInfo: [],
			tools: mcpTools,
			gitRepos: [],
			projectLayouts: [],
			mcpInstructions: [],
			fileContents: {},
			customSubagents: [],
		});
		const result = create(RequestContextResultSchema, {
			result: {
				case: "success",
				value: create(RequestContextSuccessSchema, { requestContext }),
			},
		});
		sendExecResult(execMessage, "requestContextResult", result, sendFrame);
		return;
	}

	if (execCase === "mcpArgs") {
		const mcpArgs = execMessage.message.value;
		const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
		onMcpExec({
			execId: execMessage.execId,
			execMsgId: execMessage.id,
			toolCallId: mcpArgs.toolCallId || randomUUID(),
			toolName: mcpArgs.toolName || mcpArgs.name,
			decodedArgs: JSON.stringify(decoded),
		});
		return;
	}

	const rejectReason = "Tool not available in this environment. Use the provided MCP tools instead.";

	if (execCase === "readArgs") {
		const args = execMessage.message.value;
		sendExecResult(
			execMessage,
			"readResult",
			create(ReadResultSchema, {
				result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason: rejectReason }) },
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "lsArgs") {
		const args = execMessage.message.value;
		sendExecResult(
			execMessage,
			"lsResult",
			create(LsResultSchema, {
				result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason: rejectReason }) },
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "grepArgs") {
		sendExecResult(
			execMessage,
			"grepResult",
			create(GrepResultSchema, {
				result: { case: "error", value: create(GrepErrorSchema, { error: rejectReason }) },
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "writeArgs") {
		const args = execMessage.message.value;
		sendExecResult(
			execMessage,
			"writeResult",
			create(WriteResultSchema, {
				result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason: rejectReason }) },
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "deleteArgs") {
		const args = execMessage.message.value;
		sendExecResult(
			execMessage,
			"deleteResult",
			create(DeleteResultSchema, {
				result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason: rejectReason }) },
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
		const args = execMessage.message.value;
		sendExecResult(
			execMessage,
			"shellResult",
			create(ShellResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command ?? "",
						workingDirectory: args.workingDirectory ?? "",
						reason: rejectReason,
						isReadonly: false,
					}),
				},
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "backgroundShellSpawnArgs") {
		const args = execMessage.message.value;
		sendExecResult(
			execMessage,
			"backgroundShellSpawnResult",
			create(BackgroundShellSpawnResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command ?? "",
						workingDirectory: args.workingDirectory ?? "",
						reason: rejectReason,
						isReadonly: false,
					}),
				},
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "writeShellStdinArgs") {
		sendExecResult(
			execMessage,
			"writeShellStdinResult",
			create(WriteShellStdinResultSchema, {
				result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: rejectReason }) },
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "fetchArgs") {
		const args = execMessage.message.value;
		sendExecResult(
			execMessage,
			"fetchResult",
			create(FetchResultSchema, {
				result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: rejectReason }) },
			}),
			sendFrame,
		);
		return;
	}
	if (execCase === "diagnosticsArgs") {
		sendExecResult(execMessage, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame);
		return;
	}

	const miscCaseMap: Record<string, string> = {
		listMcpResourcesExecArgs: "listMcpResourcesExecResult",
		readMcpResourceExecArgs: "readMcpResourceExecResult",
		recordScreenArgs: "recordScreenResult",
		computerUseArgs: "computerUseResult",
	};
	const resultCase = miscCaseMap[execCase as string];
	if (resultCase) {
		sendExecResult(execMessage, resultCase, create(McpResultSchema, {}), sendFrame);
	}
}

function handleInteractionUpdate(
	update: any,
	onText: (text: string) => void,
	onThinking: (text: string) => void,
): void {
	const updateCase = update.message?.case;
	if (updateCase === "textDelta") {
		const delta = update.message.value.text || "";
		if (delta) onText(delta);
		return;
	}
	if (updateCase === "thinkingDelta") {
		const delta = update.message.value.text || "";
		if (delta) onThinking(delta);
	}
}

function processServerMessage(
	message: AgentServerMessage,
	blobStore: Map<string, Uint8Array>,
	mcpTools: McpToolDefinition[],
	sendFrame: (data: Uint8Array) => void,
	onText: (text: string) => void,
	onThinking: (text: string) => void,
	onMcpExec: (exec: PendingExec) => void,
): void {
	const messageCase = message.message.case;
	if (messageCase === "interactionUpdate") {
		handleInteractionUpdate(message.message.value, onText, onThinking);
		return;
	}
	if (messageCase === "kvServerMessage") {
		handleKvMessage(message.message.value as KvServerMessage, blobStore, sendFrame);
		return;
	}
	if (messageCase === "execServerMessage") {
		handleExecMessage(message.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec);
	}
}

function sendToolResults(
	active: ActiveBridge,
	toolResults: ToolResultInfo[],
): void {
	for (const exec of active.pendingExecs) {
		const result = toolResults.find((item) => item.toolCallId === exec.toolCallId);
		const mcpResult = result
			? create(McpResultSchema, {
					result: {
						case: "success",
						value: create(McpSuccessSchema, {
							content: [
								create(McpToolResultContentItemSchema, {
									content: {
										case: "text",
										value: create(McpTextContentSchema, { text: result.content }),
									},
								}),
							],
							isError: false,
						}),
					},
				})
			: create(McpResultSchema, {
					result: {
						case: "error",
						value: create(McpErrorSchema, { error: "Tool result not provided" }),
					},
				});

		const execClientMessage = create(ExecClientMessageSchema, {
			id: exec.execMsgId,
			execId: exec.execId,
			message: {
				case: "mcpResult" as any,
				value: mcpResult as any,
			},
		});
		const clientMessage = create(AgentClientMessageSchema, {
			message: { case: "execClientMessage", value: execClientMessage },
		});
		active.bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	}
}

function buildPendingToolCalls(pendingExecs: PendingExec[]): CursorNativeToolCall[] {
	return pendingExecs.map((exec) => ({
		id: exec.toolCallId,
		name: exec.toolName,
		arguments: exec.decodedArgs,
	}));
}

export function resetCursorSession(sessionKey: string): void {
	const active = ACTIVE_BRIDGES.get(sessionKey);
	if (active) {
		clearInterval(active.heartbeatTimer);
		active.bridge.end();
		ACTIVE_BRIDGES.delete(sessionKey);
	}
	SESSION_STATE.delete(sessionKey);
}

export async function streamCursorTurn(options: CursorNativeTurnOptions): Promise<CursorNativeTurnResult> {
	const { sessionKey, accessToken, modelId, messages, tools = [], signal, onText, onThinking, onToolCalls } = options;
	const prior = SESSION_STATE.get(sessionKey);
	const conversationId = prior && prior.modelId === modelId ? prior.conversationId : randomUUID();
	SESSION_STATE.set(sessionKey, { conversationId, modelId });

	const { systemPrompt, userText, turns, toolResults } = parseMessages(messages);
	if (!userText && toolResults.length === 0) {
		throw new Error("No user message found");
	}

	const stale = ACTIVE_BRIDGES.get(sessionKey);
	if (stale && toolResults.length === 0) {
		clearInterval(stale.heartbeatTimer);
		stale.bridge.end();
		ACTIVE_BRIDGES.delete(sessionKey);
	}

	const activeBridge = ACTIVE_BRIDGES.get(sessionKey);
	if (activeBridge && toolResults.length > 0) {
		ACTIVE_BRIDGES.delete(sessionKey);
		sendToolResults(activeBridge, toolResults);
		return streamWithBridge({
			sessionKey,
			conversationId,
			modelId,
			bridge: activeBridge.bridge,
			heartbeatTimer: activeBridge.heartbeatTimer,
			blobStore: activeBridge.blobStore,
			mcpTools: activeBridge.mcpTools,
			onText,
			onThinking,
			onToolCalls,
			signal,
		});
	}

	const payload = buildCursorRequest(modelId, systemPrompt, userText, turns, conversationId);
	payload.mcpTools = buildMcpToolDefinitions(tools);

	const bridge = spawnBridge(accessToken);
	bridge.write(frameConnectMessage(payload.requestBytes));

	const heartbeatTimer = setInterval(() => {
		bridge.write(makeHeartbeatBytes());
	}, HEARTBEAT_INTERVAL_MS);

	return streamWithBridge({
		sessionKey,
		conversationId,
		modelId,
		bridge,
		heartbeatTimer,
		blobStore: payload.blobStore,
		mcpTools: payload.mcpTools,
		onText,
		onThinking,
		onToolCalls,
		signal,
	});
}

interface StreamWithBridgeOptions {
	sessionKey: string;
	conversationId: string;
	modelId: string;
	bridge: ReturnType<typeof spawnBridge>;
	heartbeatTimer: NodeJS.Timeout;
	blobStore: Map<string, Uint8Array>;
	mcpTools: McpToolDefinition[];
	onText(text: string): void;
	onThinking(text: string): void;
	onToolCalls(calls: CursorNativeToolCall[]): void;
	signal?: AbortSignal;
}

function streamWithBridge(options: StreamWithBridgeOptions): Promise<CursorNativeTurnResult> {
	const { sessionKey, conversationId, modelId, bridge, heartbeatTimer, blobStore, mcpTools, onText, onThinking, onToolCalls, signal } =
		options;

	return new Promise<CursorNativeTurnResult>((resolve, reject) => {
		let settled = false;
		let pendingBuffer = Buffer.alloc(0);
		let pendingExecs: PendingExec[] = [];
		let toolBatchTimer: NodeJS.Timeout | null = null;

		const cleanup = () => {
			clearInterval(heartbeatTimer);
			if (toolBatchTimer) clearTimeout(toolBatchTimer);
			if (signal) signal.removeEventListener("abort", abortHandler);
		};

		const finish = (result: CursorNativeTurnResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			resetCursorSession(sessionKey);
			reject(error instanceof Error ? error : new Error(String(error)));
		};

		const armToolBatch = () => {
			if (toolBatchTimer) clearTimeout(toolBatchTimer);
			toolBatchTimer = setTimeout(() => {
				if (settled || pendingExecs.length === 0) return;
				ACTIVE_BRIDGES.set(sessionKey, {
					bridge,
					heartbeatTimer,
					blobStore,
					mcpTools,
					pendingExecs: [...pendingExecs],
					onClose: null,
				});
				onToolCalls(buildPendingToolCalls(pendingExecs));
				finish({ stopReason: "toolUse", conversationId });
			}, TOOL_BATCH_SETTLE_MS);
		};

		const abortHandler = () => {
			try {
				bridge.proc.kill("SIGTERM");
			} catch {}
			fail(new Error("Cursor request aborted."));
		};

		if (signal) {
			if (signal.aborted) {
				abortHandler();
				return;
			}
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		const processChunk = (incoming: Buffer) => {
			pendingBuffer = Buffer.concat([pendingBuffer, incoming]);

			while (pendingBuffer.length >= 5) {
				const flags = pendingBuffer[0]!;
				const messageLength = pendingBuffer.readUInt32BE(1);
				if (pendingBuffer.length < 5 + messageLength) break;

				const messageBytes = pendingBuffer.subarray(5, 5 + messageLength);
				pendingBuffer = pendingBuffer.subarray(5 + messageLength);

				if (flags & CONNECT_END_STREAM_FLAG) {
					const endError = parseConnectEndStream(messageBytes);
					if (endError) fail(endError);
					continue;
				}

				try {
					const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
					processServerMessage(
						serverMessage,
						blobStore,
						mcpTools,
						(data) => bridge.write(data),
						onText,
						onThinking,
						(exec) => {
							pendingExecs.push(exec);
							armToolBatch();
						},
					);
				} catch {
					// Ignore malformed messages.
				}
			}
		};

		bridge.onData(processChunk);

		bridge.onClose((code) => {
			if (toolBatchTimer) {
				clearTimeout(toolBatchTimer);
				toolBatchTimer = null;
			}
			if (settled) return;
			if (pendingExecs.length > 0) {
				ACTIVE_BRIDGES.set(sessionKey, {
					bridge,
					heartbeatTimer,
					blobStore,
					mcpTools,
					pendingExecs: [...pendingExecs],
					onClose: null,
				});
				onToolCalls(buildPendingToolCalls(pendingExecs));
				finish({ stopReason: "toolUse", conversationId });
				return;
			}
			if (code === 0) {
				finish({ stopReason: "stop", conversationId });
				return;
			}
			fail(new Error(`Cursor bridge exited with code ${code ?? "unknown"}`));
		});
	});
}
