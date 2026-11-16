import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Đọc cấu hình từ biến môi trường Vite. Khi chưa cấu hình (chưa có project
// Supabase), `supabase` là null và app hiển thị trạng thái "Chưa cấu hình
// Supabase" thay vì crash hay gọi API giả. Xem thêm trong README.md.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

function isMissingOrPlaceholder(
  value: string | undefined,
  placeholder: string,
): boolean {
  if (!value) return true
  const trimmed = value.trim()
  return trimmed === '' || trimmed === placeholder
}

export const isSupabaseConfigured =
  !isMissingOrPlaceholder(url, 'https://your-project-ref.supabase.co') &&
  !isMissingOrPlaceholder(anonKey, 'your-anon-key-here')

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null
