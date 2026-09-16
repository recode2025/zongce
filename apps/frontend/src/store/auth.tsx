import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { JwtUser, login as apiLogin, logout as apiLogout, changePassword as apiChangePwd, restore } from '../api/auth';

export type { JwtUser } from '../api/auth';

interface AuthCtx {
  user: JwtUser | null;
  ready: boolean; // 首次会话恢复完成（避免闪登录页）
  login: (u: string, p: string) => Promise<JwtUser>;
  logout: () => Promise<void>;
  changePassword: (o: string, n: string) => Promise<JwtUser>;
  setUser: (u: JwtUser | null) => void;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<JwtUser | null>(null);
  const [ready, setReady] = useState(false);

  // 刷新后静默恢复；服务端踢下线（refresh 失效）时清空本地
  useEffect(() => {
    restore().then(setUser).finally(() => setReady(true));
    const onKick = () => setUser(null);
    window.addEventListener('zc:logout', onKick);
    return () => window.removeEventListener('zc:logout', onKick);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      ready,
      setUser,
      login: (u, p) => apiLogin(u, p).then((x) => (setUser(x), x)),
      logout: async () => {
        await apiLogout();
        setUser(null);
      },
      changePassword: async (o, n) => {
        const x = await apiChangePwd(o, n);
        setUser(x);
        return x;
      },
    }),
    [user, ready],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const ROLE_TEXT: Record<JwtUser['role'], string> = {
  SUPER_ADMIN: '超级管理员',
  GRADE_ADMIN: '辅导员/管理员',
  CLASS_LEADER: '班级负责人',
  STUDENT: '学生',
};
