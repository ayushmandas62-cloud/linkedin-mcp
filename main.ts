import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { initializeToken, REDIRECT_URI, resolveOAuthCallback } from "./linkedin-api.js";
import { startCronJob } from "./cron.js";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
async function startHttpServer(factory: () => McpServer): Promise<void> {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  // Health check — used by Railway and other platforms
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      version: "1.0.0",
      env: {
        LINKEDIN_CLIENT_ID: !!process.env.LINKEDIN_CLIENT_ID,
        LINKEDIN_CLIENT_SECRET: !!process.env.LINKEDIN_CLIENT_SECRET,
        RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN ?? null,
      },
      redirect_uri: REDIRECT_URI,
    });
  });

  // OAuth callback — LinkedIn redirects here after user approves
  app.get("/auth/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      res.status(400).send(callbackPage("error", `LinkedIn denied access: ${error}`));
      return;
    }

    if (!code || !state) {
      res.status(400).send(callbackPage("error", "Missing code or state parameter."));
      return;
    }

    // Validate state and notify any waiting tool call
    const matched = resolveOAuthCallback(code, state);
    if (!matched) {
      res.status(400).send(callbackPage("error", "Invalid or expired OAuth state. Please start the LinkedIn connection again."));
      return;
    }

    res.send(callbackPage("success", "Authorization received. Return to your MCP host to finish connecting."));
  });

  // MCP endpoint — stateless per-request
  app.all("/mcp", async (req: Request, res: Response) => {
    const server = factory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(PORT, (err?: Error) => {
      if (err) return reject(err);
      const base = process.env.LINKEDIN_REDIRECT_URI?.replace("/auth/callback", "") ?? `http://localhost:${PORT}`;
      console.log(`LinkedIn MCP server running on port ${PORT}`);
      console.log(`MCP endpoint:      ${base}/mcp`);
      console.log(`OAuth callback:    ${base}/auth/callback`);
      resolve();
    });

    const shutdown = () => {
      httpServer.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function startStdioServer(factory: () => McpServer): Promise<void> {
  await factory().connect(new StdioServerTransport());
}

function callbackPage(status: "success" | "error", message: string): string {
  const color = status === "success" ? "#0A66C2" : "#CC1016";
  const icon = status === "success" ? "✓" : "✗";
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>LinkedIn MCP – ${status}</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; background: #F3F2EF; }
  .card { background: #fff; border-radius: 8px; padding: 48px; text-align: center;
          box-shadow: 0 0 0 1px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.1); max-width: 420px; }
  .icon { font-size: 48px; color: ${color}; }
  h1 { color: ${color}; margin: 16px 0 8px; }
  p { color: #666; line-height: 1.5; }
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${status === "success" ? "Connected!" : "Error"}</h1>
  <p>${safeMessage}</p>
</div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

async function main() {
  // Load any previously saved token on startup
  await initializeToken();

  // Start the daily auto-post cron job
  startCronJob();

  if (process.argv.includes("--stdio")) {
    await startStdioServer(createServer);
  } else {
    await startHttpServer(createServer);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
