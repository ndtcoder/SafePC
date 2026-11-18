// Ghi nhật ký đổi quy tắc (PRD §2.8, follow-up của đợt nhật ký hoạt
// động): Dashboard tự ghi một hàng audit_logs mỗi khi phụ huynh đổi quy
// tắc/mẫu, để tab Nhật ký có nguồn lịch sử "ai đổi quy tắc nào".
//
// Ghi qua RPC safepc_log_rule_change (migration 16): bảng audit_logs
// chỉ có policy SELECT nên Dashboard không INSERT trực tiếp được. RPC
// tự kiểm tra vai trò phụ huynh, ép actor = auth.uid(), chỉ nhận 10
// action dưới đây và cắt details tối đa 2KB — xem migration 16.
//
// Hình dạng details (đọc bởi auditLogToEvent trong activityLog.ts):
// - Nhóm rule: { rule_name, rule_type, summary?: string[] } và thêm
//   previous_summary?: string[] + previous_name?: string (khi đổi tên)
//   + previous_child_id?: string (khi chuyển con) khi sửa.
// - Nhóm mẫu: { template_name, rule_count } và thêm previous_name?: string
//   khi đổi tên mẫu.
// - Áp mẫu/mẫu sẵn: { template_name, rule_count } — MỘT hàng cho cả lần
//   áp dụng (không ghi từng quy tắc) để nhật ký không bị ngập khi mẫu
//   có nhiều quy tắc.

import { describeRuleConfig } from './format'
import { supabase } from './supabase'
import type { Rule, RuleType } from './types'

/** 10 action đổi quy tắc/mẫu mà RPC safepc_log_rule_change chấp nhận. */
export type RuleChangeAction =
  | 'rule_created'
  | 'rule_updated'
  | 'rule_deleted'
  | 'rule_enabled'
  | 'rule_disabled'
  | 'template_created'
  | 'template_updated'
  | 'template_deleted'
  | 'template_applied'
  | 'preset_applied'

export const RULE_CHANGE_ACTIONS: readonly RuleChangeAction[] = [
  'rule_created',
  'rule_updated',
  'rule_deleted',
  'rule_enabled',
  'rule_disabled',
  'template_created',
  'template_updated',
  'template_deleted',
  'template_applied',
  'preset_applied',
]

export interface LogRuleChangeInput {
  familyId: string
  /** Con gắn với quy tắc; null cho sự kiện ở cấp mẫu. */
  childId: string | null
  action: RuleChangeAction
  /** Id quy tắc/mẫu dạng text; id mẫu sẵn ('school', 'edge_only'...); null khi không có. */
  target: string | null
  details: Record<string, unknown>
}

// RPC chưa tồn tại (migration 16 chưa áp) thì tắt ghi nhật ký cho hết
// phiên: không gọi lỗi lặp lại sau mỗi lần đổi rule. Đặt lại khi tải
// lại trang — nếu lúc đó migration đã áp thì ghi bình thường.
let rpcUnavailable = false

/**
 * Ghi một lần đổi quy tắc/mẫu vào nhật ký. Best-effort: KHÔNG BAO GIỜ
 * ném lỗi — ghi lỗi thì chỉ ghi console.warn và trả về false, thao tác
 * đổi rule của phụ huynh vẫn thành công như thường. Trả về true khi
 * ghi thành công.
 */
export async function logRuleChange(input: LogRuleChangeInput): Promise<boolean> {
  if (!supabase || rpcUnavailable) return false
  try {
    const { error } = await supabase.rpc('safepc_log_rule_change', {
      p_family_id: input.familyId,
      p_child_id: input.childId,
      p_action: input.action,
      p_target: input.target,
      p_details: input.details,
    })
    if (error) throw error
    return true
  } catch (err) {
    // PGRST202 = không tìm thấy function: migration 16 chưa áp dụng.
    // Nhận diện bằng cả mã lỗi lẫn tên hàm trong thông báo (rộng hơn
    // mẫu TimeBankTab, vốn chỉ kiểm tra tên hàm trong thông báo).
    const code = (err as { code?: unknown } | null)?.code
    const message = err instanceof Error ? err.message : String(err)
    if (code === 'PGRST202' || message.includes('safepc_log_rule_change')) {
      rpcUnavailable = true
    }
    console.warn('Không ghi được nhật ký đổi quy tắc (thao tác vẫn thành công):', err)
    return false
  }
}

const MAX_SUMMARY_LINES = 3
const MAX_LINE_LENGTH = 160

/**
 * Tóm tắt dễ đọc của một cấu hình quy tắc để ghi vào chi tiết nhật ký:
 * tối đa 3 dòng đầu của describeRuleConfig, mỗi dòng cắt ngắn. Không
 * bao giờ ném lỗi: lỗi mô tả hiếm gặp thì trả dòng dự phòng.
 */
export function buildRuleSummary(type: RuleType, config: Record<string, unknown>): string[] {
  // describeRuleConfig chỉ đọc type + config nên đối tượng tạm này đủ.
  let lines: string[]
  try {
    lines = describeRuleConfig({ type, config } as Rule)
  } catch {
    return ['Chưa có cấu hình chi tiết.']
  }
  return lines.slice(0, MAX_SUMMARY_LINES).map((line) =>
    line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
  )
}
