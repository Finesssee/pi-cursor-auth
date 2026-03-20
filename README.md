# pi-cursor-auth

Cursor API integration — OAuth authentication, model discovery, and an OpenAI-compatible proxy for Cursor's gRPC protocol.

Ported from [opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) and adapted for Node.js.

## What it does

Runs a local HTTP proxy that accepts standard OpenAI `/v1/chat/completions` requests and translates them to Cursor's internal gRPC/Connect protocol via an HTTP/2 bridge. This lets you use Cursor's models (Composer 2, Claude Sonnet, GPT-4o, etc.) through any OpenAI-compatible client.

## Setup

```bash
npm install
npm run build
```

## Authentication

```bash
# Start OAuth login flow — opens a URL you paste into your browser
npm run login

# Verify your token works
npm run login:test

# List available models
npm run login:models
```

Credentials are saved to `~/.pi/agent/cursor-credentials.json`.

## Usage

```typescript
import { startProxy, stopProxy, getProxyPort } from "pi-cursor-auth";
import { getCursorModels } from "pi-cursor-auth";

// Start the local proxy
const port = await startProxy(async () => {
  // Return your access token here
  const creds = JSON.parse(fs.readFileSync("~/.pi/agent/cursor-credentials.json", "utf-8"));
  return creds.accessToken;
});

console.log(`Proxy running at http://127.0.0.1:${port}`);

// Discover available models
const models = await getCursorModels(accessToken);
console.log(models);

// Now use any OpenAI client pointed at http://127.0.0.1:${port}
```

## Architecture

```
Your App → OpenAI API format → cursor-proxy (HTTP) → cursor-h2-bridge (HTTP/2) → Cursor gRPC API
```

- **cursor-auth.ts** — PKCE OAuth login, token polling, refresh
- **cursor-models.ts** — gRPC model discovery with fallback list
- **cursor-proxy.ts** — OpenAI-compatible HTTP proxy server
- **cursor-h2-bridge.mjs** — Node.js HTTP/2 child process for gRPC transport
- **proto/agent_pb.ts** — Auto-generated protobuf definitions

## Credits

This project is based on [opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) by [Ephraim Duncan](https://github.com/ephraimduncan). The original project implements a Cursor API plugin for [OpenCode](https://github.com/nicepkg/opencode) using Bun. This repo ports the core functionality to Node.js as a standalone package.

Key components adapted from opencode-cursor:
- OAuth PKCE authentication flow
- gRPC/Connect protocol translation (OpenAI ↔ Cursor)
- HTTP/2 bridge for Cursor's streaming API
- Protobuf definitions for Cursor's agent service
- MCP tool call handling and native tool rejection

## License

MIT
