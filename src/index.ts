/**
 * Cursor provider for pi-ai.
 *
 * Exposes a local OpenAI-compatible proxy that translates requests to
 * Cursor's gRPC/Connect protocol. Models are registered under the
 * `openai-completions` API type for full compatibility with the existing
 * pi-ai streaming infrastructure.
 *
 * Usage:
 *   import { startCursorProvider, stopCursorProvider } from './providers/cursor/index.js';
 *   const port = await startCursorProvider(accessToken);
 *   // Models are now available at http://127.0.0.1:${port}/v1/chat/completions
 */
export { startProxy, stopProxy, getProxyPort } from "./cursor-proxy.js";
export {
	generateCursorAuthParams,
	pollCursorAuth,
	refreshCursorToken,
	getTokenExpiry,
	type CursorAuthParams,
	type CursorCredentials,
} from "./cursor-auth.js";
export { getCursorModels, fetchCursorUsableModels, type CursorModel } from "./cursor-models.js";
