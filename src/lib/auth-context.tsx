"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@/i18n/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { deriveUser, type SessionUser } from "@/lib/derive-user";

export type { AuthMethod, SessionUser } from "@/lib/derive-user";

export interface AuthUser extends SessionUser {
  id: string;
  avatarUrl: string | null;
  bio: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAdmin: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Google 登录跳回来那一刻，浏览器端 cookie 刚写好，偶尔第一次 getUser() 会因为网络抖动
// 拿不到 session，之前这里没有 catch/重试，失败一次就永远卡在"未登录"，得手动刷新才会好。
// 加个重试兜底，覆盖这种瞬时失败。
const INITIAL_LOAD_RETRY_DELAYS_MS = [500, 1500];

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(() => isSupabaseConfigured());
  const rawUserRef = useRef<User | null>(null);
  const sessionVersionRef = useRef(0);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    let cancelled = false;
    const supabase = createClient();

    async function syncSession(rawUser: User | null) {
      const version = ++sessionVersionRef.current;
      rawUserRef.current = rawUser;
      const base = deriveUser(rawUser);
      if (!rawUser || !base) {
        if (!cancelled) {
          setUser(null);
          setIsAdmin(false);
          setLoading(false);
        }
        return;
      }
      if (!cancelled) setLoading(true);
      // profiles 是公开可读的（RLS: select using (true)），客户端直接查就行。
      const { data: profile } = await Promise.resolve(
        supabase
          .from("profiles")
          .select("role, username, display_name, avatar_url, bio")
          .eq("id", rawUser.id)
          .maybeSingle()
      ).catch(() => ({ data: null }));
      // 较早的账号请求不能覆盖退出/切换账号后已开始的会话。
      if (cancelled || version !== sessionVersionRef.current) return;
      setIsAdmin(profile?.role === "admin");
      setUser({
        ...base,
        id: rawUser.id,
        name: profile?.display_name || profile?.username || base.name,
        avatarUrl: profile?.avatar_url ?? null,
        bio: profile?.bio ?? null,
      });
      setLoading(false);
    }

    async function loadInitialSession() {
      const initialVersion = sessionVersionRef.current;
      for (let attempt = 0; attempt <= INITIAL_LOAD_RETRY_DELAYS_MS.length; attempt++) {
        try {
          const version = sessionVersionRef.current;
          const { data, error } = await supabase.auth.getUser();
          if (version !== sessionVersionRef.current) return;
          if (error) throw error;
          if (cancelled || initialVersion !== sessionVersionRef.current) return;
          await syncSession(data.user);
          return;
        } catch {
          if (attempt < INITIAL_LOAD_RETRY_DELAYS_MS.length) {
            await new Promise((resolve) => setTimeout(resolve, INITIAL_LOAD_RETRY_DELAYS_MS[attempt]));
          }
        }
      }
    }

    loadInitialSession().finally(() => {
      if (!cancelled && sessionVersionRef.current === 0) setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      syncSession(session?.user ?? null)
        .catch(() => {
          // 仅当前账号的失败可以结束加载；晚到的旧请求不能清掉新会话。
          if (!cancelled && rawUserRef.current?.id === session?.user?.id) {
            setUser(null);
            setIsAdmin(false);
            setLoading(false);
          }
        });
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function refreshProfile() {
    if (!isSupabaseConfigured() || !rawUserRef.current) return;
    const supabase = createClient();
    const rawUser = rawUserRef.current;
    const version = sessionVersionRef.current;
    const base = deriveUser(rawUser);
    if (!base) return;
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, username, display_name, avatar_url, bio")
      .eq("id", rawUser.id)
      .maybeSingle();
    if (version !== sessionVersionRef.current || rawUserRef.current?.id !== rawUser.id) return;
    setIsAdmin(profile?.role === "admin");
    setUser({
      ...base,
      id: rawUser.id,
      name: profile?.display_name || profile?.username || base.name,
      avatarUrl: profile?.avatar_url ?? null,
      bio: profile?.bio ?? null,
    });
  }

  async function signOut() {
    sessionVersionRef.current++;
    rawUserRef.current = null;
    setUser(null);
    setIsAdmin(false);
    if (isSupabaseConfigured()) {
      const supabase = createClient();
      await supabase.auth.signOut();
    }
    router.push("/");
  }

  return (
    <AuthContext.Provider value={{ user, isAdmin, loading, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return ctx;
}
