// SafePC — Edge Function `pair-device` (STUB Sprint 1, chưa deploy, chưa kiểm chứng).
//
// Đổi pairing code 6 số (do phụ huynh tạo trên Dashboard) thành device token.
// Luồng: Agent gửi { code, hostname, os_version, agent_version } ->
// hàm hash code bằng SHA-256, đối chiếu với pairing_codes.code_hash, kiểm tra
// hết hạn 10 phút / chưa dùng / attempts < 5, rồi tạo device + token ngẫu
// nhiên 256-bit, chỉ lưu SHA-256 hash của token vào device_tokens, và trả
// token thô đúng 1 lần trong response.
//
// Trạng thái: project Supabase SafePC đã tạo (16/11/2026) nhưng migration
// chưa áp dụng và function chưa deploy — code này CHƯA chạy thử lần nào.
// Xem README.md cùng thư mục trước khi deploy.
//
// Bảo mật (docs/03-SECURITY.md mục 2-3):
// - KHÔNG log code thô hay token thô, không log request body.
// - Chỉ lưu hash: code_hash và token_hash đều là SHA-256 hex (chữ thường).
// - Dùng service_role key (bypass RLS) vì pairing chưa có phiên đăng nhập;
//   key chỉ đọc từ biến môi trường, không hardcode.
// - Thông báo lỗi cố ý chung chung để không lộ code nào tồn tại/hết hạn.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_ATTEMPTS = 5;

interface PairingCodeRow {
  id: string;
  family_id: string;
  child_id: string | null;
  attempts: number;
  expires_at: string;
  used_at: string | null;
}

interface PairRequest {
  code: string;
  hostname: string;
  os_version?: string;
  agent_version?: string;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomTokenHex(): string {
  const bytes = new Uint8Array(32); // 256-bit
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parsePairRequest(body: unknown): PairRequest | string {
  if (typeof body !== "object" || body === null) {
    return "Dữ liệu không hợp lệ.";
  }
  const { code, hostname, os_version, agent_version } = body as Record<
    string,
    unknown
  >;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return "Mã pairing phải gồm 6 chữ số.";
  }
  if (
    typeof hostname !== "string" ||
    hostname.trim().length === 0 ||
    hostname.length > 255
  ) {
    return "Thiếu tên máy (hostname) hoặc tên máy quá dài.";
  }
  if (
    os_version !== undefined &&
    (typeof os_version !== "string" || os_version.length > 255)
  ) {
    return "os_version không hợp lệ.";
  }
  if (
    agent_version !== undefined &&
    (typeof agent_version !== "string" || agent_version.length > 255)
  ) {
    return "agent_version không hợp lệ.";
  }
  return {
    code,
    hostname: hostname.trim(),
    os_version,
    agent_version,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Chỉ hỗ trợ POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("pair-device: thiếu cấu hình biến môi trường.");
    return jsonResponse(500, { error: "Lỗi máy chủ." });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Dữ liệu không hợp lệ." });
  }

  const parsed = parsePairRequest(body);
  if (typeof parsed === "string") {
    return jsonResponse(400, { error: parsed });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Hợp đồng hash: Dashboard phải lưu code_hash = SHA-256 hex (chữ thường)
  // của đúng chuỗi 6 chữ số, không khoảng trắng, không salt (schema hiện tại
  // không có cột salt). Xem README.md cùng thư mục.
  const codeHash = await sha256Hex(parsed.code);

  const { data: codes, error: lookupError } = await supabase
    .from("pairing_codes")
    .select("id, family_id, child_id, attempts, expires_at, used_at")
    .eq("code_hash", codeHash)
    .order("created_at", { ascending: false })
    .limit(1);

  if (lookupError) {
    console.error("pair-device: lỗi tra cứu pairing code.");
    return jsonResponse(500, { error: "Lỗi máy chủ." });
  }

  const genericError = {
    error: "Mã pairing không hợp lệ hoặc đã hết hạn. Hãy tạo mã mới.",
  };

  const row = (codes?.[0] ?? null) as PairingCodeRow | null;
  if (!row) {
    // Không có dòng nào khớp: không có gì để tăng attempts. Chống đoán mò
    // mã sai hàng loạt cần rate limiting ở tầng Edge Function (TODO Sprint 2).
    return jsonResponse(400, genericError);
  }

  const now = new Date();
  const nowIso = now.toISOString();

  if (row.attempts >= MAX_ATTEMPTS) {
    // Đã chạm trần: từ chối, KHÔNG tăng nữa (CHECK attempts <= 5 trong DB
    // sẽ lỗi nếu tăng thêm).
    return jsonResponse(429, {
      error: "Mã đã bị khóa do nhập sai quá nhiều lần. Hãy tạo mã mới.",
    });
  }

  if (row.used_at !== null || new Date(row.expires_at) <= now) {
    // Mã đã dùng hoặc đã hết hạn: ghi nhận 1 lần thử thất bại rồi từ chối.
    // Chỉ tăng khi attempts < 5 để không vi phạm CHECK constraint.
    const { error: bumpError } = await supabase
      .from("pairing_codes")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    if (bumpError) {
      console.error("pair-device: lỗi cập nhật attempts.");
    }
    return jsonResponse(400, genericError);
  }

  // Đánh dấu đã dùng bằng UPDATE có điều kiện để 2 request đồng thời không
  // cùng đổi được 1 mã: chỉ request nào cập nhật được dòng còn "sống" mới đi
  // tiếp. Nếu 0 dòng bị ảnh hưởng thì mã vừa bị dùng/hết hạn ở request khác.
  const { data: claimed, error: claimError } = await supabase
    .from("pairing_codes")
    .update({ used_at: nowIso })
    .eq("id", row.id)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .lt("attempts", MAX_ATTEMPTS)
    .select("id");

  if (claimError) {
    console.error("pair-device: lỗi đánh dấu pairing code đã dùng.");
    return jsonResponse(500, { error: "Lỗi máy chủ." });
  }
  if (!claimed || claimed.length === 0) {
    return jsonResponse(400, genericError);
  }

  // Tạo device. TODO (Sprint 2): gom "đánh dấu used + tạo device + tạo
  // token" vào 1 Postgres function/RPC chạy trong transaction, để không còn
  // trường hợp mã đã dùng nhưng tạo device/token thất bại.
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .insert({
      family_id: row.family_id,
      child_id: row.child_id,
      hostname: parsed.hostname,
      os_version: parsed.os_version ?? null,
      agent_version: parsed.agent_version ?? null,
      status: "online",
      last_seen_at: nowIso,
    })
    .select("id")
    .single();

  if (deviceError || !device) {
    console.error("pair-device: lỗi tạo device.");
    return jsonResponse(500, { error: "Lỗi máy chủ." });
  }

  // Token thô chỉ tồn tại trong bộ nhớ của request này và trong response.
  // DB chỉ lưu SHA-256 hash; Agent phải lưu token bằng DPAPI trên máy con.
  const token = randomTokenHex();
  const tokenHash = await sha256Hex(token);
  const { error: tokenError } = await supabase
    .from("device_tokens")
    .insert({ device_id: device.id, token_hash: tokenHash });

  if (tokenError) {
    console.error("pair-device: lỗi lưu device token.");
    return jsonResponse(500, { error: "Lỗi máy chủ." });
  }

  return jsonResponse(200, { device_id: device.id, token });
});
