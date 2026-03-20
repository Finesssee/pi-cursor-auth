#!/usr/bin/env node
/**
 * Cursor authentication CLI.
 * Run this to authenticate with your Cursor account.
 * 
 * Usage:
 *   node cursor-login.mjs          # Start OAuth login flow
 *   node cursor-login.mjs --test   # Test existing token
 *   node cursor-login.mjs --models # List available models
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const CRED_DIR = join(homedir(), ".pi", "agent");
const CRED_FILE = join(CRED_DIR, "cursor-credentials.json");

// --- PKCE ---
function generatePKCE() {
	const verifierBytes = randomBytes(96);
	const verifier = verifierBytes.toString("base64url");
	const hashBuffer = createHash("sha256").update(verifier).digest();
	const challenge = Buffer.from(hashBuffer).toString("base64url");
	return { verifier, challenge };
}

// --- Credentials ---
function loadCredentials() {
	if (!existsSync(CRED_FILE)) return null;
	try {
		return JSON.parse(readFileSync(CRED_FILE, "utf-8"));
	} catch {
		return null;
	}
}

function saveCredentials(creds) {
	mkdirSync(CRED_DIR, { recursive: true });
	writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
	console.log(`✓ Credentials saved to ${CRED_FILE}`);
}

// --- Token refresh ---
async function refreshToken(refreshToken) {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${refreshToken}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});
	if (!response.ok) throw new Error(`Refresh failed: ${await response.text()}`);
	const data = await response.json();
	return {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken || refreshToken,
	};
}

// --- Login flow ---
async function login() {
	const { verifier, challenge } = generatePKCE();
	const uuid = randomUUID();

	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});

	const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;

	console.log("\n╔══════════════════════════════════════════════╗");
	console.log("║         Cursor Authentication                ║");
	console.log("╚══════════════════════════════════════════════╝\n");
	console.log("Open this URL in your browser:\n");
	console.log(`  ${loginUrl}\n`);
	console.log("Waiting for you to complete login...\n");

	// Poll for token
	let delay = 1000;
	const maxAttempts = 150;

	for (let i = 0; i < maxAttempts; i++) {
		await new Promise((r) => setTimeout(r, delay));
		process.stdout.write(`  Polling... (attempt ${i + 1}/${maxAttempts})\r`);

		try {
			const resp = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);
			if (resp.status === 404) {
				delay = Math.min(delay * 1.2, 10000);
				continue;
			}
			if (resp.ok) {
				const data = await resp.json();
				console.log("\n\n✓ Authentication successful!\n");

				const creds = {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
					timestamp: new Date().toISOString(),
				};
				saveCredentials(creds);
				return creds;
			}
		} catch {
			// retry
		}
	}

	console.error("\n✗ Authentication timed out. Please try again.");
	process.exit(1);
}

// --- Test token ---
async function testToken() {
	const creds = loadCredentials();
	if (!creds) {
		console.log("No credentials found. Run without --test to login.");
		process.exit(1);
	}

	console.log("Testing Cursor credentials...");

	// Try to refresh to verify the token works
	try {
		const refreshed = await refreshToken(creds.refreshToken);
		creds.accessToken = refreshed.accessToken;
		creds.refreshToken = refreshed.refreshToken;
		creds.timestamp = new Date().toISOString();
		saveCredentials(creds);
		console.log("✓ Token is valid and refreshed.");
	} catch (err) {
		console.error(`✗ Token is invalid: ${err.message}`);
		console.log("Run without --test to re-login.");
		process.exit(1);
	}
}

// --- List models ---
async function listModels() {
	const creds = loadCredentials();
	if (!creds) {
		console.log("No credentials found. Run without --models to login first.");
		process.exit(1);
	}

	console.log("Fetching available Cursor models...\n");

	// Use the cursor-models module
	const { execSync } = await import("node:child_process");
	const { writeFileSync: wf, readFileSync: rf, unlinkSync, existsSync: ex } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join: j } = await import("node:path");

	const CURSOR_BASE_URL = "https://api2.cursor.sh";
	const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

	const headers = {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${creds.accessToken}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": "cli-2026.02.13-41ac335",
		"x-cursor-client-type": "cli",
	};

	// Send empty protobuf request via curl
	const reqPath = j(tmpdir(), `cursor-req-${Date.now()}.bin`);
	const respPath = j(tmpdir(), `cursor-resp-${Date.now()}.bin`);
	try {
		wf(reqPath, Buffer.alloc(0)); // empty GetUsableModelsRequest
		const headerArgs = Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]);
		const url = `${CURSOR_BASE_URL}${GET_USABLE_MODELS_PATH}`;
		const args = [
			"curl", "-s", "--http2", "--max-time", "10",
			"-X", "POST",
			...headerArgs,
			"--data-binary", `@${reqPath}`,
			"-o", respPath,
			"-w", "%{http_code}",
			url,
		];
		const status = execSync(args.map(a => a.includes(" ") ? `"${a}"` : a).join(" "), {
			timeout: 15000,
			stdio: ["pipe", "pipe", "pipe"],
		}).toString().trim();

		if (status.startsWith("2")) {
			console.log(`✓ Got response from Cursor API (HTTP ${status})`);
			console.log("  (Model list decoding requires @bufbuild/protobuf — use the pi-ai module for full parsing)");
		} else {
			console.log(`✗ Cursor API returned HTTP ${status}`);
			if (status === "401") {
				console.log("  Token may be expired. Try: node cursor-login.mjs --test");
			}
		}
	} finally {
		try { unlinkSync(reqPath); } catch {}
		try { unlinkSync(respPath); } catch {}
	}

	// Fallback: print hardcoded models
	console.log("\nKnown Cursor models:");
	const models = [
		"composer-2",
		"claude-4-sonnet",
		"claude-3.5-sonnet",
		"gpt-4o",
		"cursor-small",
		"gemini-2.5-pro",
	];
	for (const m of models) {
		console.log(`  • ${m}`);
	}
}

// --- Main ---
const args = process.argv.slice(2);
if (args.includes("--test")) {
	await testToken();
} else if (args.includes("--models")) {
	await listModels();
} else {
	await login();
}
