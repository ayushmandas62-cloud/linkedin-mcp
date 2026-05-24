# LinkedIn MCP Server

An MCP server that lets Claude interact with LinkedIn via OAuth 2.0, with a rich React UI rendered inside MCP-enabled hosts.

## Features

| Tool | Description |
|------|-------------|
| `linkedin_connect` | Authenticate with LinkedIn (opens OAuth flow, waits for callback) |
| `linkedin_profile` | Retrieve your profile: name, headline, email |
| `linkedin_create_post` | Publish a text post (up to 3 000 characters, public or connections-only) |
| `linkedin_post_image` | Preview and publish an image post from a public image URL |
| `linkedin_post_advisor` | Score a draft and suggest improvements before publishing |
| `linkedin_rewrite_post` | Generate professional, storytelling, and thought-leader rewrites |
| `linkedin_weekly_plan` | Generate a 7-day content plan for review |
| `linkedin_schedule_status` | Check daily draft-generation configuration |
| `linkedin_post_now` | Generate a post on demand and show it for review |
| `linkedin_analyze_profile` | Score basic profile completeness |
| `linkedin_delete_post` | Delete a post after explicit confirmation |
| `linkedin_disconnect` | Remove stored credentials |

## Setup

### 1. Create a LinkedIn App

1. Go to [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps)
2. Click **Create App** → fill in the required fields
3. Under **Auth** tab:
   - Add `http://localhost:3001/auth/callback` as an **Authorized redirect URL**
4. Under **Products** tab, request access to:
   - **Sign In with LinkedIn using OpenID Connect** (for profile + email)
   - **Share on LinkedIn** (for posting)
5. Copy your **Client ID** and **Client Secret**

### 2. Configure Environment

```bash
export LINKEDIN_CLIENT_ID=your_client_id
export LINKEDIN_CLIENT_SECRET=your_client_secret
```

Or copy `.env.example` to `.env` and load it with your process manager before running.

The default redirect URI is `http://localhost:3001/auth/callback`. For hosted deployments, set `LINKEDIN_REDIRECT_URI` explicitly or set `RAILWAY_PUBLIC_DOMAIN`.

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Run

```bash
npm run serve          # HTTP mode  (default: port 3001)
npm run serve:stdio    # stdio mode (for Claude Desktop)
```

## Claude Desktop Config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-mcp/dist/main.js", "--stdio"],
      "env": {
        "LINKEDIN_CLIENT_ID": "your_client_id",
        "LINKEDIN_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

## HTTP Mode (Claude Code / Web)

```json
{
  "mcpServers": {
    "linkedin": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

## Development

```bash
npm run dev   # watch mode: rebuilds UI + restarts server on changes
```

## Daily Draft Generation

Daily generation is disabled by default. To enable it:

```bash
export DAILY_POST_ENABLED=true
export DAILY_POST_TOPICS="AI trends,productivity,career growth"
export GEMINI_API_KEY=your_gemini_key
```

Generated daily posts are saved for review in `~/.linkedin-mcp-drafts` by default. Set `DAILY_POST_REQUIRE_REVIEW=false` only if you intentionally want generated posts to publish without manual review.

## OAuth Flow

1. Claude calls `linkedin_connect`
2. The tool generates an auth URL and waits up to 120 s
3. The MCP App UI shows an **Open LinkedIn Login** button
4. You click it → browser opens LinkedIn
5. You approve → LinkedIn redirects to `http://localhost:3001/auth/callback`
6. The server exchanges the code for a token (stored in `~/.linkedin-mcp-token.json`)
7. The tool returns your profile info

## Token Storage

Tokens are saved to `~/.linkedin-mcp-token.json`. LinkedIn access tokens expire after 60 days. Call `linkedin_connect` again when the token expires.
