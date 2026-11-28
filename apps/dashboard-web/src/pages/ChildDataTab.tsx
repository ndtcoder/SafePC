import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isMissingColumnError, toVietnameseError } from '../lib/format'
import {
  AlertBox,
  Card,
  ErrorState,
  Field,
  LoadingState,
  dangerButtonClassName,
  dangerOutlineButtonClassName,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../components/ui'
import {
  CHILD_DATA_SECTIONS,
  buildChildDataExport,
  buildChildDataExportFilename,
  buildChildOrDeviceFilter,
  deleteCountLabel,
  isChildDataDeleteResult,
  matchesChildNameForDelete,
  type ChildDataDeleteResult,
  type ChildDataSectionKey,
} from '../lib/childData'
import type {
  AppRequest,
  AppUsage,
  AuditLog,
  Child,
  ChildScreenSettings,
  Command,
  Device,
  Message,
  NotificationSend,
  PairingCode,
  Rule,
  RuleObservation,
  ScreenshotMetadata,
  TimeBankGrant,
  WebVisit,
} from '../lib/types'

/**
 * Tab Dữ liệu trong hồ sơ con (PRD §2.8): xuất dữ liệu của con ra file
 * JSON và xóa toàn bộ dữ liệu của con.
 *
 * - Xuất: đọc qua RLS (chỉ dữ liệu của đúng gia đình), đóng gói bằng
 *   buildChildDataExport, tải file JSON về máy. Mỗi mục đọc tối đa
 *   20 trang x 1000 hàng (cùng trần với trang Báo cáo tuần); mục nào
 *   vượt trần hoặc không đọc được (bảng của migration chưa áp dụng)
 *   thì ghi rõ trạng thái trong file, không im lặng.
 * - Xóa: gọi RPC safepc_delete_child_data (migration 15) sau khi phụ
 *   huynh xem trước số lượng từng mục và gõ đúng tên của con. Xóa là
 *   không thể hoàn tác; sau khi xóa, hồ sơ con không còn nữa.
 */

const PAGE_SIZE = 1000
const MAX_PAGES = 20

type LoadState = 'loading' | 'ready' | 'error'

type CountMap = Record<ChildDataSectionKey, number | null>

function emptyCounts(): CountMap {
  return {
    devices: null,
    rules: null,
    requests: null,
    commands: null,
    app_usage: null,
    web_visits: null,
    rule_observations: null,
    messages: null,
    audit_logs: null,
    time_bank_grants: null,
    notification_sends: null,
    pairing_codes: null,
    screen_settings: null,
    screenshots: null,
  }
}

/** Đọc hết các trang của một mục; đủ MAX_PAGES trang đầy thì báo truncated (có thể còn hàng chưa đọc). */
async function fetchAllRows<T>(fetchPage: (from: number, to: number) => Promise<T[]>): Promise<{
  rows: T[]
  truncated: boolean
}> {
  const rows: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageRows = await fetchPage(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    rows.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

function downloadJsonFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export default function ChildDataTab({ childId, childName }: { childId: string; childName: string }) {
  const { configured, user } = useAuth()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [counts, setCounts] = useState<CountMap>(emptyCounts)
  const [countsUnavailable, setCountsUnavailable] = useState<ChildDataSectionKey[]>([])

  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [typedName, setTypedName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteResult, setDeleteResult] = useState<ChildDataDeleteResult | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [missingMigration, setMissingMigration] = useState(false)

  const loadSeqRef = useRef(0)

  // Đếm số hàng từng mục để phụ huynh thấy trước khi xóa. Đếm từng mục
  // độc lập: bảng của migration chưa áp dụng (time_bank_grants,
  // notification_sends) thì đếm thất bại và hiện "—", không làm hỏng
  // cả tab.
  const loadCounts = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!supabase || !user) {
      setState('ready')
      return
    }
    setState('loading')
    setError('')
    try {
      // Alias sau guard để các closure bên dưới thấy client không null
      // (thu hẹp kiểu của biến import không lan vào closure).
      const client = supabase
      const deviceIdsResult = await client.from('devices').select('id').eq('child_id', childId)
      if (seq !== loadSeqRef.current) return
      if (deviceIdsResult.error) throw deviceIdsResult.error
      const deviceIds = ((deviceIdsResult.data ?? []) as Array<{ id: string }>).map((d) => d.id)

      const countByChild = async (table: string): Promise<number> => {
        const { count, error: countError } = await client
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq('child_id', childId)
        if (countError) throw countError
        return count ?? 0
      }
      // audit_logs/notification_sends vừa gắn con vừa gắn máy: đếm theo
      // đúng phạm vi xóa của RPC (kể cả hàng không gắn con nào nhưng
      // gắn với máy của con) để bảng đếm trước không đếm thiếu.
      const countByChildOrDevice = async (table: string): Promise<number> => {
        const { count, error: countError } = await client
          .from(table)
          .select('*', { count: 'exact', head: true })
          .or(buildChildOrDeviceFilter(childId, deviceIds))
        if (countError) throw countError
        return count ?? 0
      }
      const countCommands = async (): Promise<number> => {
        if (deviceIds.length === 0) return 0
        const { count, error: countError } = await client
          .from('commands')
          .select('*', { count: 'exact', head: true })
          .in('device_id', deviceIds)
        if (countError) throw countError
        return count ?? 0
      }

      const jobs: Array<{ key: ChildDataSectionKey; run: () => Promise<number> }> = [
        { key: 'devices', run: async () => deviceIds.length },
        { key: 'rules', run: () => countByChild('rules') },
        { key: 'requests', run: () => countByChild('requests') },
        { key: 'commands', run: countCommands },
        { key: 'app_usage', run: () => countByChild('app_usage') },
        { key: 'web_visits', run: () => countByChild('web_visits') },
        { key: 'rule_observations', run: () => countByChild('rule_observations') },
        { key: 'messages', run: () => countByChild('messages') },
        { key: 'audit_logs', run: () => countByChildOrDevice('audit_logs') },
        { key: 'time_bank_grants', run: () => countByChild('time_bank_grants') },
        { key: 'notification_sends', run: () => countByChildOrDevice('notification_sends') },
        { key: 'pairing_codes', run: () => countByChild('pairing_codes') },
        // Bảng cài đặt chụp màn hình có tên khác khóa mục (migration 32).
        { key: 'screen_settings', run: () => countByChild('child_screen_settings') },
        { key: 'screenshots', run: () => countByChild('screenshot_metadata') },
      ]
      const settled = await Promise.allSettled(jobs.map((j) => j.run()))
      if (seq !== loadSeqRef.current) return
      const next = emptyCounts()
      const unavailable: ChildDataSectionKey[] = []
      settled.forEach((result, index) => {
        const key = jobs[index].key
        if (result.status === 'fulfilled') {
          next[key] = result.value
        } else {
          unavailable.push(key)
        }
      })
      setCounts(next)
      setCountsUnavailable(unavailable)
      setState('ready')
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setError(toVietnameseError(err))
      setState('error')
    }
  }, [user, childId])

  useEffect(() => {
    void loadCounts()
  }, [loadCounts])

  const handleExport = async () => {
    if (!supabase || !user) return
    setExporting(true)
    setExportMessage(null)
    setExportError(null)
    try {
      // Alias sau guard để các closure bên dưới thấy client không null.
      const client = supabase
      const { data: childRow, error: childError } = await client
        .from('children')
        .select('id, family_id, display_name, birth_year, avatar_url, created_at')
        .eq('id', childId)
        .maybeSingle()
      if (childError) throw childError
      if (!childRow) throw new Error('Không tìm thấy hồ sơ của con.')
      const child = childRow as Child

      // Đọc từng mục độc lập: mục nào lỗi (vd bảng của migration chưa
      // áp dụng) thì ghi 'unavailable' kèm lý do, các mục còn lại vẫn
      // xuất bình thường — file xuất không bao giờ im lặng thiếu mục.
      const truncatedSections: ChildDataSectionKey[] = []
      const unavailableSections: Array<{ section: ChildDataSectionKey; reason: string }> = []
      const readSection = async <T,>(
        key: ChildDataSectionKey,
        fetchPage: (from: number, to: number) => Promise<T[]>,
      ): Promise<T[]> => {
        try {
          const { rows, truncated } = await fetchAllRows(fetchPage)
          if (truncated) truncatedSections.push(key)
          return rows
        } catch (err) {
          unavailableSections.push({ section: key, reason: toVietnameseError(err) })
          return []
        }
      }
      const throwOnError = <T,>(data: T[] | null, queryError: { message: string } | null): T[] => {
        if (queryError) throw new Error(queryError.message)
        return (data ?? []) as T[]
      }

      const devices = await readSection<Device>('devices', async (from, to) => {
        // Không SELECT exit_pin_hash: hash mã PIN không xuất (xem
        // sanitizeDeviceForExport — lớp phòng thủ thứ hai).
        const { data, error: queryError } = await client
          .from('devices')
          .select(
            'id, family_id, child_id, hostname, os_version, agent_version, last_seen_at, last_extension_seen_at, enforcement_json, enforcement_updated_at, status, created_at',
          )
          .eq('child_id', childId)
          .order('id')
          .range(from, to)
        return throwOnError<Device>(data as Device[] | null, queryError)
      })
      const deviceIds = devices.map((d) => d.id)
      // Ba mục commands/audit_logs/notification_sends phụ thuộc vào danh
      // sách thiết bị để xác định đúng phạm vi: nếu mục devices đọc lỗi
      // thì ba mục này phải ghi 'unavailable' thay vì im lặng trả rỗng
      // (đọc bằng danh sách thiết bị rỗng sẽ báo 'ok' với 0 hàng sai sự
      // thật). Khi đọc devices thành công mà con chưa có máy nào thì
      // deviceIds rỗng là đúng và ba mục vẫn đọc bình thường.
      const devicesUnavailable = unavailableSections.some((u) => u.section === 'devices')
      const deviceListUnknown = new Error(
        'Không đọc được danh sách thiết bị nên không xác định được đầy đủ dữ liệu của con.',
      )
      const rules = await readSection<Rule>('rules', async (from, to) => {
        const { data, error: queryError } = await client
          .from('rules')
          .select('id, family_id, child_id, type, config, name, enabled, created_at')
          .eq('child_id', childId)
          .order('id')
          .range(from, to)
        return throwOnError<Rule>(data as Rule[] | null, queryError)
      })
      const requests = await readSection<AppRequest>('requests', async (from, to) => {
        const { data, error: queryError } = await client
          .from('requests')
          .select(
            'id, family_id, child_id, type, status, reason, decided_by, decided_at, created_at, minutes, device_id',
          )
          .eq('child_id', childId)
          .order('id')
          .range(from, to)
        return throwOnError<AppRequest>(data as AppRequest[] | null, queryError)
      })
      const commands = await readSection<Command>('commands', async (from, to) => {
        if (devicesUnavailable) throw deviceListUnknown
        if (deviceIds.length === 0) return []
        const { data, error: queryError } = await client
          .from('commands')
          .select('id, family_id, device_id, type, payload, status, created_at')
          .in('device_id', deviceIds)
          .order('id')
          .range(from, to)
        return throwOnError<Command>(data as Command[] | null, queryError)
      })
      const appUsage = await readSection<AppUsage>('app_usage', async (from, to) => {
        const { data, error: queryError } = await client
          .from('app_usage')
          .select(
            'id, family_id, device_id, child_id, app_name, exe_path_hash, started_at, duration_sec, created_at',
          )
          .eq('child_id', childId)
          .order('id')
          .range(from, to)
        return throwOnError<AppUsage>(data as AppUsage[] | null, queryError)
      })
      // Cột path chỉ có sau migration 19: thử đọc kèm path, nếu lỗi
      // thiếu cột thì đọc lại không có path cho trang đó và các trang
      // sau — xuất vẫn đủ dữ liệu cũ thay vì đánh dấu cả mục không đọc
      // được (khác với bảng của migration chưa áp dụng).
      let webVisitsPathSupported: boolean | null = null
      const webVisits = await readSection<WebVisit>('web_visits', async (from, to) => {
        const columnsWithPath =
          'id, family_id, device_id, child_id, domain, path, visited_at, blocked, duration_sec, created_at'
        const columnsLegacy =
          'id, family_id, device_id, child_id, domain, visited_at, blocked, duration_sec, created_at'
        const runQuery = async (columns: string) =>
          client
            .from('web_visits')
            .select(columns)
            .eq('child_id', childId)
            .order('id')
            .range(from, to)
        let result = await runQuery(webVisitsPathSupported === false ? columnsLegacy : columnsWithPath)
        if (
          result.error &&
          webVisitsPathSupported !== false &&
          isMissingColumnError(result.error, 'path')
        ) {
          webVisitsPathSupported = false
          result = await runQuery(columnsLegacy)
        }
        return throwOnError<WebVisit>(result.data as WebVisit[] | null, result.error)
      })
      const ruleObservations = await readSection<RuleObservation>(
        'rule_observations',
        async (from, to) => {
          const { data, error: queryError } = await client
            .from('rule_observations')
            .select(
              'id, family_id, child_id, device_id, rule_id, rule_name, rule_mode, target, context, occurrence_count, total_seconds, first_seen_at, last_seen_at, day, created_at',
            )
            .eq('child_id', childId)
            .order('day')
            .order('id')
            .range(from, to)
          return throwOnError<RuleObservation>(data as RuleObservation[] | null, queryError)
        },
      )
      const messages = await readSection<Message>('messages', async (from, to) => {
        const { data, error: queryError } = await client
          .from('messages')
          .select(
            'id, family_id, child_id, device_id, sender_role, sender_user_id, body, parent_read_at, child_read_at, created_at',
          )
          .eq('child_id', childId)
          .order('created_at')
          .order('id')
          .range(from, to)
        return throwOnError<Message>(data as Message[] | null, queryError)
      })
      const auditLogs = await readSection<AuditLog>('audit_logs', async (from, to) => {
        if (devicesUnavailable) throw deviceListUnknown
        const { data, error: queryError } = await client
          .from('audit_logs')
          .select('id, family_id, actor, action, target, ip_hash, created_at, child_id, device_id, details')
          .or(buildChildOrDeviceFilter(childId, deviceIds))
          .order('id')
          .range(from, to)
        return throwOnError<AuditLog>(data as AuditLog[] | null, queryError)
      })
      const timeBankGrants = await readSection<TimeBankGrant>('time_bank_grants', async (from, to) => {
        const { data, error: queryError } = await client
          .from('time_bank_grants')
          .select('id, family_id, child_id, minutes, reason, granted_by, status, expires_at, created_at')
          .eq('child_id', childId)
          .order('id')
          .range(from, to)
        return throwOnError<TimeBankGrant>(data as TimeBankGrant[] | null, queryError)
      })
      const notificationSends = await readSection<NotificationSend>(
        'notification_sends',
        async (from, to) => {
          if (devicesUnavailable) throw deviceListUnknown
          const { data, error: queryError } = await client
            .from('notification_sends')
            .select(
              'id, family_id, kind, event_key, status, device_id, action, child_id, claimed_at, sent_at, resend_id, recipients, created_at',
            )
            .or(buildChildOrDeviceFilter(childId, deviceIds))
            .order('id')
            .range(from, to)
          return throwOnError<NotificationSend>(data as NotificationSend[] | null, queryError)
        },
      )
      const pairingCodes = await readSection<PairingCode>('pairing_codes', async (from, to) => {
        // Không SELECT code_hash: hash mã ghép nối không xuất.
        const { data, error: queryError } = await client
          .from('pairing_codes')
          .select('id, family_id, child_id, attempts, expires_at, used_at, created_at')
          .eq('child_id', childId)
          .order('id')
          .range(from, to)
        return throwOnError<PairingCode>(data as PairingCode[] | null, queryError)
      })
      const screenSettings = await readSection<ChildScreenSettings>(
        'screen_settings',
        async (from, to) => {
          const { data, error: queryError } = await client
            .from('child_screen_settings')
            .select('child_id, family_id, enabled, interval_minutes, retention_days, updated_by, updated_at')
            .eq('child_id', childId)
            .order('child_id')
            .range(from, to)
          return throwOnError<ChildScreenSettings>(data as ChildScreenSettings[] | null, queryError)
        },
      )
      const screenshots = await readSection<ScreenshotMetadata>('screenshots', async (from, to) => {
        // Chỉ DANH MỤC (thời điểm + id file Drive + kích thước): ảnh
        // thật nằm trên Drive của phụ huynh, không qua file xuất này.
        const { data, error: queryError } = await client
          .from('screenshot_metadata')
          .select('id, family_id, child_id, device_id, captured_at, day, drive_file_id, size_bytes, width, height, created_at')
          .eq('child_id', childId)
          .order('captured_at')
          .order('id')
          .range(from, to)
        return throwOnError<ScreenshotMetadata>(data as ScreenshotMetadata[] | null, queryError)
      })

      const now = new Date()
      const exportObject = buildChildDataExport({
        exportedAt: now.toISOString(),
        child,
        devices,
        rules,
        requests,
        commands,
        appUsage,
        webVisits,
        ruleObservations,
        messages,
        auditLogs,
        timeBankGrants,
        notificationSends,
        pairingCodes,
        screenSettings,
        screenshots,
        truncatedSections,
        unavailableSections,
      })
      downloadJsonFile(
        buildChildDataExportFilename(child.display_name, now),
        JSON.stringify(exportObject, null, 2),
      )
      const totalRows =
        devices.length +
        rules.length +
        requests.length +
        commands.length +
        appUsage.length +
        webVisits.length +
        ruleObservations.length +
        messages.length +
        auditLogs.length +
        timeBankGrants.length +
        notificationSends.length +
        pairingCodes.length +
        screenSettings.length +
        screenshots.length
      setExportMessage(
        `Đã tải file xuất dữ liệu của ${child.display_name} (${totalRows} hàng).` +
          (truncatedSections.length > 0
            ? ` Lưu ý: ${truncatedSections.length} mục đã chạm trần 20.000 hàng và có thể còn thiếu — file ghi rõ mục nào bị cắt.`
            : '') +
          (unavailableSections.length > 0
            ? ` ${unavailableSections.length} mục không đọc được và đã ghi rõ lý do trong file.`
            : ''),
      )
    } catch (err) {
      setExportError(toVietnameseError(err))
    } finally {
      setExporting(false)
    }
  }

  const handleDelete = async () => {
    if (!supabase || !user) return
    if (!matchesChildNameForDelete(typedName, childName)) return
    setDeleting(true)
    setDeleteError(null)
    setMissingMigration(false)
    try {
      const { data, error: rpcError } = await supabase.rpc('safepc_delete_child_data', {
        p_child_id: childId,
      })
      if (rpcError) throw rpcError
      if (!isChildDataDeleteResult(data)) {
        throw new Error('Máy chủ trả về kết quả xóa không đúng định dạng. Vui lòng kiểm tra lại hồ sơ.')
      }
      setDeleteResult(data)
      setConfirmingDelete(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Hàm chưa tồn tại (migration 15 chưa áp dụng): PostgREST báo lỗi
      // mang tên hàm — hiện hướng dẫn áp migration thay vì lỗi chung.
      if (message.includes('safepc_delete_child_data')) {
        setMissingMigration(true)
        return
      }
      setDeleteError(toVietnameseError(err))
    } finally {
      setDeleting(false)
    }
  }

  if (!configured) {
    return null
  }

  if (state === 'loading') return <LoadingState />
  if (state === 'error') {
    return <ErrorState message={error} onRetry={() => void loadCounts()} />
  }

  const nameMatches = matchesChildNameForDelete(typedName, childName)

  return (
    <div className="space-y-5">
      <Card title={`Xuất dữ liệu của ${childName}`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Tải toàn bộ dữ liệu còn lưu của {childName} thành một file JSON: hồ sơ, thiết bị, quy tắc,
            yêu cầu, lệnh, lịch sử dùng app, lịch sử web, tin nhắn với phụ huynh, nhật ký kiểm tra, lịch sử thưởng giờ, thông
            báo đã gửi, mã ghép nối, cài đặt chụp màn hình và danh mục ảnh chụp màn hình. Lịch sử dùng app và lịch sử web chỉ giữ 90 ngày gần nhất. File
            chỉ chứa dữ liệu của đúng con này trong gia đình của bạn.
          </p>
          <p className="text-sm text-slate-600">
            Riêng ảnh chụp màn hình: file xuất chỉ gồm <strong>danh mục</strong> (thời điểm chụp, id file,
            kích thước) — ảnh thật nằm trên <strong>Google Drive của chính bạn</strong>, hãy tải hoặc xóa
            chúng trực tiếp trong Drive. SafePC không tải hộ ảnh qua máy chủ.
          </p>
          <p className="text-sm text-slate-600">
            File không chứa hash token của máy, hash mã PIN hay hash mã ghép nối — đó là thông tin xác thực,
            không phải dữ liệu xuất. Dữ liệu cấp gia đình (mẫu quy tắc, lời mời, lịch sử gửi email báo cáo
            tuần) cũng không có trong file này.
          </p>
          {exportMessage && (
            <AlertBox tone="success">
              {exportMessage}
            </AlertBox>
          )}
          {exportError && (
            <AlertBox tone="error">
              {exportError}
            </AlertBox>
          )}
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || deleteResult !== null}
            className={primaryButtonClassName}
          >
            {exporting ? 'Đang xuất…' : 'Xuất dữ liệu (file JSON)'}
          </button>
        </div>
      </Card>

      <Card title="Xóa toàn bộ dữ liệu" className="border-red-200">
        <div className="space-y-4">
          {deleteResult ? (
            <>
              <AlertBox tone="success">
                Đã xóa toàn bộ dữ liệu của {childName}. Hồ sơ này không còn nữa; Agent trên các máy của con
                sẽ ngừng đồng bộ — hãy gỡ Agent khỏi máy hoặc ghép nối lại máy dưới hồ sơ con khác.
              </AlertBox>
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <tbody>
                    {(
                      Object.entries(deleteResult.deleted) as Array<
                        [keyof ChildDataDeleteResult['deleted'], number]
                      >
                    ).map(([key, value]) => (
                      <tr key={key} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-2 text-slate-700">{deleteCountLabel(key)}</td>
                        <td className="px-3 py-2 text-right font-medium text-slate-900">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {deleteResult.skipped_missing_tables.length > 0 && (
                <p className="text-sm text-slate-600">
                  Bỏ qua bảng chưa tồn tại trên server: {deleteResult.skipped_missing_tables.join(', ')}.
                </p>
              )}
              <Link
                to="/ho-so"
                className={primaryButtonClassName}
              >
                Quay lại danh sách hồ sơ
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-700">
                Xóa vĩnh viễn hồ sơ của {childName} cùng toàn bộ dữ liệu bên dưới. <strong>Không thể hoàn
                tác.</strong> Dữ liệu cấp gia đình (mẫu quy tắc, lời mời, lịch sử gửi email) không bị xóa.
                Trước khi xóa, hãy xuất dữ liệu ở trên nếu bạn muốn giữ một bản sao.
              </p>
              <p className="text-sm text-slate-600">
                Lưu ý về ảnh chụp màn hình: ảnh thật nằm trên <strong>Google Drive của bạn</strong> — xóa dữ
                liệu của con ở đây chỉ xóa <strong>cài đặt chụp và danh mục ảnh</strong> trên máy chủ SafePC,
                không xóa file trên Drive. File trên Drive do bạn tự quản lý và xóa trong Google Drive;
                khi tính năng còn bật và máy của con còn online, Agent tự dọn ảnh quá hạn giữ trên Drive.
              </p>
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <tbody>
                    {CHILD_DATA_SECTIONS.map((section) => (
                      <tr key={section.key} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-2">
                          <span className="text-slate-700">{section.label}</span>
                          <span className="block text-xs text-slate-500">{section.description}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-slate-900">
                          {countsUnavailable.includes(section.key)
                            ? '—'
                            : counts[section.key] === null
                              ? '…'
                              : counts[section.key]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {countsUnavailable.length > 0 && (
                <p className="text-sm text-slate-600">
                  Một số mục hiện “—” vì bảng của migration chưa áp dụng không đếm được; lệnh xóa vẫn xử lý
                  đúng các bảng đã có.
                </p>
              )}
              {missingMigration && (
                <AlertBox tone="warning">
                  <p className="font-medium">Tính năng xóa cần migration 15 (hàm xóa dữ liệu của con).</p>
                  <p className="mt-1">
                    Hãy áp dụng file{' '}
                    <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">
                      backend/supabase/migrations/20261118200000_delete_child_data.sql
                    </code>{' '}
                    qua Supabase SQL Editor, rồi tải lại trang.
                  </p>
                </AlertBox>
              )}
              {deleteError && (
                <AlertBox tone="error">
                  {deleteError}
                </AlertBox>
              )}
              {confirmingDelete ? (
                <>
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    <p className="font-medium">Bạn sắp xóa toàn bộ dữ liệu của {childName}.</p>
                    <p className="mt-1">
                      Hồ sơ, thiết bị, quy tắc, yêu cầu, lệnh, lịch sử dùng app/web, tin nhắn, nhật ký, lịch sử thưởng
                      giờ, mã ghép nối, cài đặt chụp màn hình và danh mục ảnh của con sẽ bị xóa vĩnh viễn khỏi máy chủ. Agent trên máy của con sẽ
                      ngừng đồng bộ. File ảnh thật trên Google Drive của bạn không bị xóa bởi thao tác này —
                      hãy tự xóa thư mục SafePC của con trong Drive nếu muốn.
                    </p>
                  </div>
                  <Field
                    label={`Gõ tên của con (“${childName}”) để xác nhận`}
                    htmlFor="delete-child-name"
                    hint="Gõ đúng tên hiển thị, kể cả dấu tiếng Việt. Nút xóa chỉ bật khi tên khớp."
                  >
                    <input
                      id="delete-child-name"
                      type="text"
                      value={typedName}
                      onChange={(e) => setTypedName(e.target.value)}
                      autoComplete="off"
                      placeholder={childName}
                      className={inputClassName}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={!nameMatches || deleting}
                      className={dangerButtonClassName}
                    >
                      {deleting ? 'Đang xóa…' : 'Xóa vĩnh viễn toàn bộ dữ liệu'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingDelete(false)
                        setTypedName('')
                        setDeleteError(null)
                      }}
                      disabled={deleting}
                      className={secondaryButtonClassName}
                    >
                      Huỷ
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className={dangerOutlineButtonClassName}
                >
                  Xóa toàn bộ dữ liệu…
                </button>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
