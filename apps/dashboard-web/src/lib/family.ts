import type { SupabaseClient } from '@supabase/supabase-js'
import type { Family } from './types'

/**
 * Lấy gia đình của user hiện tại: ưu tiên gia đình do user làm chủ
 * (families.owner_id), nếu không thì gia đình mà user là thành viên
 * (family_members). Trả về null khi user chưa thuộc gia đình nào.
 */
export async function getMyFamily(
  client: SupabaseClient,
  userId: string,
): Promise<Family | null> {
  const { data, error } = await client
    .from('families')
    .select('id, owner_id, name, created_at')
    .eq('owner_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (data) return data as Family

  const { data: membership, error: memberError } = await client
    .from('family_members')
    .select('family_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()
  if (memberError) throw memberError
  if (!membership) return null

  const { data: family, error: familyError } = await client
    .from('families')
    .select('id, owner_id, name, created_at')
    .eq('id', membership.family_id)
    .maybeSingle()
  if (familyError) throw familyError
  return (family ?? null) as Family | null
}

/** Tạo gia đình mới và thêm user hiện tại làm phụ huynh (role 'parent'). */
export async function createFamily(
  client: SupabaseClient,
  userId: string,
  name = 'Gia đình',
): Promise<Family> {
  const { data, error } = await client
    .from('families')
    .insert({ owner_id: userId, name })
    .select('id, owner_id, name, created_at')
    .single()
  if (error) throw error

  const { error: memberError } = await client
    .from('family_members')
    .insert({ family_id: data.id, user_id: userId, role: 'parent' })
  if (memberError) throw memberError
  return data as Family
}
