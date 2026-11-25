import { createClient, type AuthError, type SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

let browserClient: SupabaseClient | null = null;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const isSupabaseConfigured = Boolean(url && publicKey);

export function getSupabaseBrowserClient() {
  if (!url || !publicKey) return null;
  if (!browserClient) {
    browserClient = createClient(url, publicKey);
  }
  return browserClient;
}

function passwordError(error: AuthError) {
  if (error.status === 429) return "요청이 많습니다. 잠시 후 다시 시도해 주세요.";
  switch (error.code) {
    case "invalid_credentials":
    case "current_password_mismatch":
      return "현재 비밀번호가 일치하지 않습니다.";
    case "same_password":
      return "현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.";
    case "weak_password":
      return "새 비밀번호가 계정의 보안 기준에 맞지 않습니다. 더 긴 비밀번호에 문자, 숫자, 기호를 조합해 주세요.";
    case "session_not_found":
    case "reauthentication_needed":
      return "다시 로그인한 뒤 비밀번호를 변경해 주세요.";
    default:
      return "비밀번호 변경을 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.";
  }
}

export async function changeAccountPassword(userId: string, current: string, next: string): Promise<string | null> {
  const client = getSupabaseBrowserClient();
  const loginRequired = "로그인한 계정을 확인한 뒤 다시 시도해 주세요.";
  if (!client || !url || !publicKey) return loginRequired;
  const { data: { session } } = await client.auth.getSession();
  if (!session?.user.email || session.user.id !== userId) return loginRequired;

  // Pin the update to the account whose current password was verified, even if another tab signs in.
  const verified = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: uuidv4() },
  }).auth;
  let discardSession = false;
  try {
    const { data, error } = await verified.signInWithPassword({ email: session.user.email, password: current });
    if (error) return passwordError(error);
    discardSession = true;
    const { data: active } = await client.auth.getSession();
    if (!data.session || data.user.id !== userId || active.session?.user.id !== userId) return loginRequired;

    // Keep this browser on the verified session when the password change expires other sessions.
    const { error: sessionError } = await client.auth.setSession(data.session);
    if (sessionError) return passwordError(sessionError);
    discardSession = false;
    const { error: updateError } = await verified.updateUser({ current_password: current, password: next });
    return updateError ? passwordError(updateError) : null;
  } finally {
    try {
      if (discardSession) await verified.signOut({ scope: "local" });
    } finally {
      await verified.dispose();
    }
  }
}
