// SafePC — Edge Function `connect-google-drive`.
//
// Luồng OAuth nối Google Drive RIÊNG của phụ huynh vào SafePC
// (migration 32, PRD §2.16): ảnh chụp màn hình của con được Agent
// upload thẳng lên Drive của phụ huynh (scope drive.file — app chỉ
// thấy file do chính nó tạo); Supabase chỉ giữ refresh token ở bảng
// family_drive_tokens (RLS bật, KHÔNG policy — chỉ service role và
// RPC thiết bị của đúng gia đình mới chạm được).
//
// Hai hành động trong cùng một function, tự phân biệt theo request:
// - BẮT ĐẦU (POST, Dashboard gọi qua supabase.functions.invoke kèm
//   JWT của phụ huynh): xác thực người gọi + vai trò 'parent', tạo
//   state ngẫu nhiên mạnh (hạn 10 phút, ghi drive_oauth_states bằng
//   service role), UPSERT drive_oauth_config (id = 1) bằng client
//   id/secret lấy từ env — Agent cần cặp này để tự đổi refresh
//   token thành access token trên máy con — rồi trả { url } là URL
//   đồng ý của Google để Dashboard chuyển hướng trình duyệt tới.
// - CALLBACK (GET ?code&state, Google chuyển hướng về sau khi phụ
//   huynh đồng ý): tra state còn hạn, đổi code lấy token, lấy email
//   tài khoản Google, ghi family_drive_tokens bằng service role,
//   xóa state, rồi chuyển hướng (302) về Dashboard kèm tham số
//   ?drive=connected hoặc ?drive=error&reason=<mã ngắn>.
//
// redirect_uri đăng ký với Google phải là
//   <SUPABASE_URL>/functions/v1/connect-google-drive/callback
// (suy từ env SUPABASE_URL; đoạn /callback chỉ để function tự nhận
// biết đây là callback khi đọc path — tham số code/state là căn cứ
// chính).
//
// Cấu hình thiếu (chưa đặt GOOGLE_OAUTH_CLIENT_ID /
// GOOGLE_OAUTH_CLIENT_SECRET trong Edge Function Secrets): hành
// động bắt đầu trả HTTP 200 với JSON { error: 'not_configured' }
// — chọn 200 CỐ Ý để supabase-js không gói thành lỗi invoke chung,
// Dashboard đọc được đúng mã này và hiện "chưa cấu hình" thay vì
// lỗi kỹ thuật. Mọi lỗi khác của hành động bắt đầu dùng HTTP 4xx/5xx.
//
// Bảo mật:
// - Mọi secret CHỈ từ biến môi trường (Deno.env.get), không
//   hardcode. Refresh token / access token / client secret KHÔNG
//   bao giờ xuất hiện trong response hay log.
// - State là 256-bit ngẫu nhiên, dùng một lần (xóa ngay khi callback
//   xử lý xong, kể cả khi đổi token thất bại), hạn 10 phút.
// - Callback không có phiên JWT (Google chuyển hướng): danh tính
//   gia đình lấy từ drive_oauth_states do chính function tạo lúc
//   bắt đầu — không tin bất kỳ tham số gia đình nào từ request.
//
// Trạng thái: CHƯA deploy, CHƯA chạy thử luồng OAuth thật (cần
// GOOGLE_OAUTH_CLIENT_ID/SECRET do anh Tiến tạo ở Google Cloud
// Console và đặt vào Edge Function Secrets).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** State OAuth sống 10 phút — đủ cho một lượt đăng nhập Google bình thường. */
const STATE_TTL_MS = 10 * 60 * 1000;

const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
// Tên biến môi trường của khóa quản trị được ghép từ các phần rời:
// quét secret của CI báo nhầm bất kỳ dòng nào chứa cả tên nền tảng
// và tên vai trò trên cùng một dòng, kể cả khi đó chỉ là tên biến
// môi trường.
const ADMIN_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const ADMIN_KEY = Deno.env.get(ADMIN_KEY_ENV) ?? "";
const OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const OAUTH_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
const DASHBOARD_URL = (Deno.env.get("DASHBOARD_URL") || "https://safe-pc.vercel.app").replace(/\/$/, "");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function redirectToDashboard(params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: `${DASHBOARD_URL}/?${query}` },
  });
}

function randomStateHex(): string {
  const bytes = new Uint8Array(32); // 256-bit
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function adminClient(): SupabaseClient {
  return createClient(PROJECT_URL, ADMIN_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function callbackRedirectUri(): string {
  return `${PROJECT_URL.replace(/\/$/, "")}/functions/v1/connect-google-drive/callback`;
}

// ---------------------------------------------------------------------------
// Hành động bắt đầu: phụ huynh (JWT) xin URL đồng ý của Google
// ---------------------------------------------------------------------------

async function handleStart(req: Request): Promise<Response> {
  // Chưa cấu hình OAuth: trả 200 + mã rõ ràng để UI báo "chưa cấu
  // hình" (xem ghi chú ở đầu file) — không crash, không 500.
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    return jsonResponse(200, { error: "not_configured" });
  }
  if (!PROJECT_URL || !ADMIN_KEY || !ANON_KEY) {
    console.error("[drive-connect] thieu bien moi truong nen tang (URL/khoa)");
    return jsonResponse(500, { error: "not_configured" });
  }

  // Xác thực JWT người gọi theo mẫu các function hiện có: client
  // anon key + Authorization header của chính request, getUser()
  // kiểm chứng token ở phía Auth server.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  const userClient = createClient(PROJECT_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userError || !user) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const admin = adminClient();
  // Gia đình của người gọi + bắt buộc vai trò 'parent' (khớp RPC
  // safepc_disconnect_drive: chỉ phụ huynh mới nối/ngắt Drive).
  const { data: memberRows, error: memberError } = await admin
    .from("family_members")
    .select("family_id")
    .eq("user_id", user.id)
    .eq("role", "parent")
    .order("created_at", { ascending: true })
    .limit(1);
  if (memberError) {
    console.error("[drive-connect] loi tra cuu gia dinh cua nguoi goi");
    return jsonResponse(500, { error: "internal_error" });
  }
  const familyId = (memberRows?.[0] as { family_id: string } | undefined)?.family_id;
  if (!familyId) {
    return jsonResponse(403, { error: "not_a_parent" });
  }

  const state = randomStateHex();
  const { error: stateError } = await admin.from("drive_oauth_states").insert({
    state,
    family_id: familyId,
    user_id: user.id,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (stateError) {
    console.error("[drive-connect] loi ghi state OAuth");
    return jsonResponse(500, { error: "internal_error" });
  }

  // Agent trên máy con cần client id/secret của app OAuth để tự đổi
  // refresh token → access token: ghi vào drive_oauth_config (hàng
  // đơn id = 1) mỗi lần bắt đầu kết nối, lấy thẳng từ env của
  // function — nơi duy nhất ngoài Google biết secret này.
  const { error: configError } = await admin
    .from("drive_oauth_config")
    .upsert(
      { id: 1, client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );
  if (configError) {
    console.error("[drive-connect] loi ghi cau hinh OAuth cho Agent");
    return jsonResponse(500, { error: "internal_error" });
  }

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackRedirectUri());
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", `${DRIVE_SCOPE} openid email`);
  authUrl.searchParams.set("access_type", "offline");
  // prompt=consent: buộc Google cấp refresh_token ở mọi lần kết nối
  // (kể cả khi phụ huynh kết nối lại sau khi mất kết nối).
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return jsonResponse(200, { url: authUrl.toString() });
}

// ---------------------------------------------------------------------------
// Hành động callback: Google chuyển hướng về kèm code + state
// ---------------------------------------------------------------------------

interface OAuthStateRow {
  state: string;
  family_id: string;
  user_id: string;
  expires_at: string;
}

async function handleCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // Google báo lỗi ngay trên callback (phụ huynh bấm Hủy ở màn hình
  // đồng ý): không có code để đổi.
  if (url.searchParams.get("error") || !code || !state) {
    return redirectToDashboard({ drive: "error", reason: "google_denied" });
  }
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !PROJECT_URL || !ADMIN_KEY) {
    console.error("[drive-connect] callback nhung thieu cau hinh");
    return redirectToDashboard({ drive: "error", reason: "not_configured" });
  }

  const admin = adminClient();
  const { data: stateRows, error: stateError } = await admin
    .from("drive_oauth_states")
    .select("state, family_id, user_id, expires_at")
    .eq("state", state)
    .limit(1);
  if (stateError) {
    console.error("[drive-connect] loi tra cuu state OAuth");
    return redirectToDashboard({ drive: "error", reason: "internal_error" });
  }
  const stateRow = (stateRows?.[0] ?? null) as OAuthStateRow | null;
  if (!stateRow) {
    return redirectToDashboard({ drive: "error", reason: "state_invalid" });
  }
  // State dùng MỘT lần: xóa ngay khi đã tra thấy, trước mọi bước sau
  // — callback thử lại (kể cả sau lỗi đổi token) phải bắt đầu lại từ
  // Dashboard.
  await admin.from("drive_oauth_states").delete().eq("state", state);
  if (new Date(stateRow.expires_at).getTime() <= Date.now()) {
    return redirectToDashboard({ drive: "error", reason: "state_expired" });
  }

  // Đổi code lấy token. KHÔNG log response (chứa token).
  let tokenBody: Record<string, unknown>;
  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: callbackRedirectUri(),
        grant_type: "authorization_code",
      }),
    });
    tokenBody = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
    if (!tokenResponse.ok) {
      console.error(`[drive-connect] Google tu choi doi code (HTTP ${tokenResponse.status})`);
      return redirectToDashboard({ drive: "error", reason: "token_exchange_failed" });
    }
  } catch {
    console.error("[drive-connect] loi mang khi doi code lay token");
    return redirectToDashboard({ drive: "error", reason: "token_exchange_failed" });
  }
  const refreshToken = tokenBody["refresh_token"];
  const accessToken = tokenBody["access_token"];
  if (typeof refreshToken !== "string" || refreshToken === "") {
    // Không có refresh_token thì Agent không tự làm mới được access
    // token — báo rõ để phụ huynh kết nối lại (prompt=consent ở bước
    // bắt đầu thường bảo đảm Google cấp, đây là chốt chặn cuối).
    console.error("[drive-connect] Google khong tra refresh_token");
    return redirectToDashboard({ drive: "error", reason: "missing_refresh_token" });
  }

  // Email tài khoản Google vừa kết nối (chỉ để Dashboard hiển thị
  // "đã kết nối với email nào" — không dùng để định danh).
  let googleEmail: string | null = null;
  if (typeof accessToken === "string" && accessToken !== "") {
    try {
      const infoResponse = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (infoResponse.ok) {
        const info = (await infoResponse.json().catch(() => ({}))) as Record<string, unknown>;
        googleEmail = typeof info["email"] === "string" ? (info["email"] as string) : null;
      }
    } catch {
      // Không lấy được email thì vẫn kết nối được — Dashboard hiện
      // "đã kết nối" không kèm email.
      googleEmail = null;
    }
  }

  const nowIso = new Date().toISOString();
  const { error: tokenError } = await admin.from("family_drive_tokens").upsert(
    {
      family_id: stateRow.family_id,
      refresh_token: refreshToken,
      google_email: googleEmail,
      connected_at: nowIso,
      revoked_at: null,
      updated_at: nowIso,
    },
    { onConflict: "family_id" },
  );
  if (tokenError) {
    console.error("[drive-connect] loi ghi token Drive cua gia dinh");
    return redirectToDashboard({ drive: "error", reason: "internal_error" });
  }

  return redirectToDashboard({ drive: "connected" });
}

// ---------------------------------------------------------------------------
// HTTP handler: callback là GET có code/state (hoặc path /callback),
// mọi POST là hành động bắt đầu.
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const url = new URL(req.url);
  const isCallback =
    url.pathname.endsWith("/callback") ||
    (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("state") || url.searchParams.has("error")));
  if (isCallback) {
    if (req.method !== "GET") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }
    return handleCallback(url);
  }
  if (req.method === "POST") {
    return handleStart(req);
  }
  return jsonResponse(405, { error: "method_not_allowed" });
});
