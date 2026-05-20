import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import "./global.css";

// ── Types ────────────────────────────────────────────────────────────────────

interface Profile {
  id: string;
  firstName: string;
  lastName: string;
  headline: string;
  profilePicture?: string;
  email?: string;
}

type PostStage = "draft" | "published";

interface PostData {
  stage: PostStage;
  text: string;
  visibility: string;
  postId?: string;
}

interface AppState {
  tool: string | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  authUrl: string | null;
  profile: Profile | null;
  post: PostData | null;
}

// ── Result parser ─────────────────────────────────────────────────────────────

function parseResult(result: CallToolResult): Partial<AppState> {
  if (result.isError) {
    return { error: (result.content?.[0] as { text?: string })?.text ?? "Unknown error" };
  }
  const s = result.structuredContent as Record<string, unknown> | undefined;
  if (!s) return {};

  if (s.status === "connected" && s.profile)
    return { connected: true, profile: s.profile as Profile, authUrl: null };
  if (s.status === "pending" && s.authUrl)
    return { connected: false, authUrl: s.authUrl as string };
  if (s.email !== undefined)
    return { connected: true, profile: s as unknown as Profile };
  if (s.stage === "draft" || s.stage === "published")
    return { post: s as unknown as PostData };

  return {};
}

// ── ConnectView ───────────────────────────────────────────────────────────────

function ConnectView({
  app,
  state,
}: {
  app: App;
  state: AppState;
}) {
  const openLink = useCallback(
    (url: string) => app.openLink({ url }),
    [app]
  );

  if (state.connected && state.profile) {
    return (
      <div style={S.card}>
        <div style={S.successBadge}>Connected</div>
        <ProfileCard profile={state.profile} />
      </div>
    );
  }

  if (state.authUrl) {
    return (
      <div style={S.card}>
        <h2 style={S.heading}>Connect to LinkedIn</h2>
        <p style={S.muted}>
          Click the button to open LinkedIn in your browser and approve access. The server
          will automatically continue once the OAuth callback arrives.
        </p>
        <button style={S.primaryBtn} onClick={() => openLink(state.authUrl!)}>
          Open LinkedIn Login ↗
        </button>
        <details style={{ fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--li-blue)" }}>Copy URL manually</summary>
          <code style={S.urlCode}>{state.authUrl}</code>
        </details>
      </div>
    );
  }

  return (
    <div style={S.card}>
      <div style={S.liLogo}>in</div>
      <h2 style={S.heading}>LinkedIn MCP</h2>
      <p style={S.muted}>
        {state.loading ? "Starting OAuth flow…" : "Ask Claude to call linkedin_connect."}
      </p>
    </div>
  );
}

// ── ProfileView ───────────────────────────────────────────────────────────────

function ProfileView({ profile }: { profile: Profile }) {
  return (
    <div style={S.card}>
      <h2 style={S.heading}>Your Profile</h2>
      <ProfileCard profile={profile} />
    </div>
  );
}

// ── PostView ──────────────────────────────────────────────────────────────────

function PostView({ app, post, loading }: { app: App; post: PostData | null; loading: boolean }) {
  const [localText, setLocalText] = useState("");
  const [localVis, setLocalVis] = useState<"PUBLIC" | "CONNECTIONS">("PUBLIC");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [localPost, setLocalPost] = useState<PostData | null>(post);

  // ── Draft review screen (Claude's draft ready for approval) ───────────────
  if (localPost?.stage === "draft") {
    const { text, visibility } = localPost;

    const handlePublish = async () => {
      setBusy(true);
      setErr(null);
      try {
        const res = await app.callServerTool({
          name: "linkedin_create_post",
          arguments: { text, visibility, preview_only: false },
        });
        const patch = parseResult(res);
        if (patch.post) setLocalPost(patch.post);
        else if (patch.error) setErr(patch.error);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const handleRequestEdits = async () => {
      await app.sendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: `Please revise this LinkedIn draft before I publish it:\n\n---\n${text}\n---\n\nWhat changes would you suggest?`,
          },
        ],
      });
    };

    return (
      <div style={S.card}>
        <div style={S.draftBadge}>Draft – ready to review</div>

        <div style={S.draftBlock}>
          <div style={S.draftLabel}>
            {visibility === "PUBLIC" ? "🌐 Public post" : "🔒 Connections only"}
          </div>
          <p style={S.draftText}>{text}</p>
          <div style={S.charCount}>{text.length} / 3 000 characters</div>
        </div>

        {err && <p style={S.errText}>{err}</p>}

        <div style={S.buttonRow}>
          <button style={S.primaryBtn} onClick={handlePublish} disabled={busy}>
            {busy ? "Publishing…" : "Publish now"}
          </button>
          <button style={S.secondaryBtn} onClick={handleRequestEdits} disabled={busy}>
            Ask Claude to revise ✎
          </button>
          <button
            style={S.ghostBtn}
            onClick={() => setLocalPost(null)}
            disabled={busy}
          >
            Edit manually
          </button>
        </div>
      </div>
    );
  }

  // ── Published confirmation ─────────────────────────────────────────────────
  if (localPost?.stage === "published") {
    return (
      <div style={S.card}>
        <div style={S.successBadge}>Published!</div>
        <blockquote style={S.quote}>{localPost.text}</blockquote>
        <p style={S.muted}>
          Visibility: {localPost.visibility} · ID: <code>{localPost.postId}</code>
        </p>
        <button style={S.secondaryBtn} onClick={() => setLocalPost(null)}>
          Write another post
        </button>
      </div>
    );
  }

  // ── Manual composer (fallback / "edit manually") ──────────────────────────
  const remaining = 3000 - localText.length;

  return (
    <div style={S.card}>
      <h2 style={S.heading}>Create a Post</h2>
      <p style={S.muted}>
        Or ask Claude: <em>"Draft a LinkedIn post about [topic]"</em> — Claude will write
        it and show you a review screen before publishing.
      </p>
      <textarea
        style={S.textarea}
        placeholder="What do you want to share?"
        value={localText}
        onChange={(e) => setLocalText(e.target.value)}
        maxLength={3000}
      />
      <div style={S.metaRow}>
        <span style={{ color: remaining < 100 ? "var(--li-error)" : "var(--li-text-muted)" }}>
          {remaining} left
        </span>
        <select
          value={localVis}
          onChange={(e) => setLocalVis(e.target.value as "PUBLIC" | "CONNECTIONS")}
          style={S.select}
        >
          <option value="PUBLIC">🌐 Public</option>
          <option value="CONNECTIONS">🔒 Connections only</option>
        </select>
      </div>
      {err && <p style={S.errText}>{err}</p>}
      <button
        style={S.primaryBtn}
        onClick={async () => {
          if (!localText.trim()) return;
          setBusy(true);
          setErr(null);
          try {
            const res = await app.callServerTool({
              name: "linkedin_create_post",
              arguments: { text: localText, visibility: localVis, preview_only: false },
            });
            const patch = parseResult(res);
            if (patch.post) { setLocalPost(patch.post); setLocalText(""); }
            else if (patch.error) setErr(patch.error);
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        disabled={!localText.trim() || busy || loading}
      >
        {busy ? "Publishing…" : "Publish"}
      </button>
    </div>
  );
}

// ── ProfileCard ───────────────────────────────────────────────────────────────

function ProfileCard({ profile }: { profile: Profile }) {
  return (
    <div style={S.profileRow}>
      {profile.profilePicture ? (
        <img src={profile.profilePicture} alt="" style={S.avatar} />
      ) : (
        <div style={S.avatarFallback}>
          {profile.firstName[0]}
          {profile.lastName[0]}
        </div>
      )}
      <div>
        <div style={S.profileName}>
          {profile.firstName} {profile.lastName}
        </div>
        {profile.headline && <div style={S.muted}>{profile.headline}</div>}
        {profile.email && <div style={{ ...S.muted, fontSize: 12 }}>{profile.email}</div>}
      </div>
    </div>
  );
}

// ── DefaultView ───────────────────────────────────────────────────────────────

function DefaultView() {
  return (
    <div style={S.card}>
      <div style={S.liLogo}>in</div>
      <h2 style={S.heading}>LinkedIn MCP</h2>
      <p style={S.muted}>
        Available tools: <code>linkedin_connect</code> · <code>linkedin_profile</code> ·{" "}
        <code>linkedin_create_post</code> · <code>linkedin_disconnect</code>
      </p>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

function LinkedInApp() {
  const [state, setState] = useState<AppState>({
    tool: null, loading: false, error: null,
    connected: false, authUrl: null, profile: null, post: null,
  });

  const { app, error: connErr } = useApp({
    appInfo: { name: "LinkedIn MCP App", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = async (input) => {
        setState((s) => ({ ...s, tool: input.name, loading: true, error: null, post: null }));
      };
      app.ontoolresult = async (result) => {
        setState((s) => ({ ...s, loading: false, ...parseResult(result) }));
      };
      app.ontoolcancelled = () => setState((s) => ({ ...s, loading: false }));
      app.onerror = console.error;
      app.onteardown = async () => ({});
    },
  });

  if (connErr) return <div style={S.errBanner}>Connection error: {connErr.message}</div>;
  if (!app) return <div style={S.muted}>Connecting…</div>;

  const { tool, loading, error, post } = state;

  return (
    <div style={S.root}>
      {loading && <div style={S.loadingBar} />}
      {error && <div style={S.errBanner}>{error}</div>}

      {tool === "linkedin_connect" && <ConnectView app={app} state={state} />}
      {tool === "linkedin_profile" && state.profile && <ProfileView profile={state.profile} />}
      {tool === "linkedin_create_post" && <PostView app={app} post={post} loading={loading} />}
      {!tool && <DefaultView />}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", padding: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 },
  loadingBar: { position: "fixed", top: 0, left: 0, right: 0, height: 3, background: "var(--li-blue)" },
  card: { background: "var(--li-surface)", borderRadius: "var(--li-radius)", boxShadow: "var(--li-shadow)", padding: 24, width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 14 },
  liLogo: { width: 40, height: 40, borderRadius: 6, background: "var(--li-blue)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 20, fontFamily: "Georgia, serif" },
  heading: { fontSize: 18, fontWeight: 700 },
  muted: { fontSize: 13, color: "var(--li-text-muted)", lineHeight: 1.5 },
  primaryBtn: { background: "var(--li-blue)", color: "#fff", alignSelf: "flex-start", fontSize: 14, padding: "8px 20px", borderRadius: 999, fontWeight: 600, border: "none", cursor: "pointer" },
  secondaryBtn: { background: "transparent", color: "var(--li-blue)", border: "1.5px solid var(--li-blue)", alignSelf: "flex-start", fontSize: 14, padding: "8px 20px", borderRadius: 999, fontWeight: 600, cursor: "pointer" },
  ghostBtn: { background: "transparent", color: "var(--li-text-muted)", border: "1px solid var(--li-border)", alignSelf: "flex-start", fontSize: 13, padding: "7px 16px", borderRadius: 999, cursor: "pointer" },
  buttonRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  successBadge: { display: "inline-flex", background: "#DCFCE7", color: "var(--li-success)", padding: "4px 12px", borderRadius: 999, fontWeight: 600, fontSize: 12, alignSelf: "flex-start" },
  draftBadge: { display: "inline-flex", background: "#FFF7ED", color: "#C2410C", padding: "4px 12px", borderRadius: 999, fontWeight: 600, fontSize: 12, alignSelf: "flex-start" },
  draftBlock: { background: "#F9FAFB", border: "1px solid var(--li-border)", borderRadius: "var(--li-radius)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 },
  draftLabel: { fontSize: 12, fontWeight: 600, color: "var(--li-text-muted)" },
  draftText: { fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--li-text)" },
  charCount: { fontSize: 11, color: "var(--li-text-muted)", alignSelf: "flex-end" },
  quote: { borderLeft: "3px solid var(--li-blue)", paddingLeft: 12, fontSize: 14, color: "var(--li-text-muted)", fontStyle: "italic", whiteSpace: "pre-wrap" },
  textarea: { width: "100%", minHeight: 120, resize: "vertical", fontFamily: "inherit", fontSize: 14, border: "1px solid var(--li-border)", borderRadius: "var(--li-radius)", padding: "10px 12px", outline: "none" },
  metaRow: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 },
  select: { border: "1px solid var(--li-border)", borderRadius: 4, padding: "4px 8px", fontSize: 13, fontFamily: "inherit", background: "#fff", cursor: "pointer" },
  errBanner: { background: "#FEE2E2", color: "var(--li-error)", padding: "10px 16px", borderRadius: "var(--li-radius)", fontSize: 13, width: "100%", maxWidth: 480 },
  errText: { color: "var(--li-error)", fontSize: 13 },
  profileRow: { display: "flex", gap: 12, alignItems: "flex-start" },
  avatar: { width: 56, height: 56, borderRadius: "50%", objectFit: "cover", flexShrink: 0 },
  avatarFallback: { width: 56, height: 56, borderRadius: "50%", background: "var(--li-blue)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 18, flexShrink: 0 },
  profileName: { fontWeight: 700, fontSize: 16 },
  urlCode: { display: "block", marginTop: 8, wordBreak: "break-all", fontSize: 11, background: "#F3F2EF", padding: 8, borderRadius: 4 },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LinkedInApp />
  </StrictMode>
);
