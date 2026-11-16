import { get, post, refreshAccessToken, setAccessToken, setRefreshToken } from './client';

export interface JwtUser {
  id: string;
  username: string;
  name: string;
  role: 'SUPER_ADMIN' | 'GRADE_ADMIN' | 'CLASS_LEADER' | 'STUDENT';
  mustChangePwd: boolean;
  classId?: string | null;
  className?: string | null;
  grade?: number | null;
}

export interface Captcha {
  captchaId: string;
  svg: string;
}

/** 图形验证码：5 分钟有效、一次性 */
export function fetchCaptcha() {
  return get<Captcha>('/auth/captcha');
}

/** 登录密语口令验证：通过后返回 10 分钟有效的 gateToken（管理员本地登录须携带） */
export function verifyPassphrase(passphrase: string) {
  return post<{ gateToken: string }>('/auth/gate', { passphrase: passphrase.trim() });
}

/** 跳转式 CAS 登录入口（学生，无需密语；后端 302 → 学校统一认证页 → 回跳 /cas/callback） */
export function casAuthorizeUrl(): string {
  const ru = `${window.location.origin}/cas/callback`;
  return `/api/v1/auth/cas/authorize?ru=${encodeURIComponent(ru)}`;
}

/** 公示期学生登录直跳查分页；其余回首页 */
export async function studentLanding(): Promise<string> {
  try {
    const b = await get<any>('/batches/active');
    if (b?.status === 'PUBLICITY') return '/student/score';
  } catch {
    /* 拿不到批次信息时按默认回首页 */
  }
  return '/student/home';
}

/** 本地登录（管理员入口）：gateToken 为密语口令验证令牌，后端强制校验 */
export async function login(username: string, password: string, gateToken: string, captcha?: { captchaId: string; captchaCode: string }) {
  const r = await post<{ accessToken: string; user: JwtUser }>('/auth/login', {
    username: username.trim(),
    password,
    gateToken,
    captchaId: captcha?.captchaId,
    captchaCode: captcha?.captchaCode,
  });
  setAccessToken(r.accessToken);
  setRefreshToken('');
  markViaCas(false); // 本地登录覆盖旧标记，避免误联动 CAS 登出
  return r.user;
}

/** 数字大外统一身份认证（CAS）：学号 + 学校密码 */
export async function casLogin(username: string, password: string, captcha?: { captchaId: string; captchaCode: string }) {
  const r = await post<{ accessToken: string; user: JwtUser }>('/auth/cas-login', {
    username: username.trim(),
    password,
    captchaId: captcha?.captchaId,
    captchaCode: captcha?.captchaCode,
  });
  setAccessToken(r.accessToken);
  setRefreshToken('');
  return r.user;
}

/** 本次会话是否经跳转式 CAS 建立（CasCallback 消费 token 时标记；退出时据此联动销毁学校 SSO 会话） */
const VIA_CAS_KEY = 'zc:via-cas';
export const markViaCas = (on: boolean) => {
  try {
    on ? sessionStorage.setItem(VIA_CAS_KEY, '1') : sessionStorage.removeItem(VIA_CAS_KEY);
  } catch {
    /* 隐私模式等场景忽略 */
  }
};

export async function logout() {
  await post('/auth/logout').catch(() => undefined);
  setAccessToken('');
  setRefreshToken('');
  // CAS 会话：先标记已清，再跳后端 → 学校 CAS /logout 销毁 CASTGC，否则再点登录免密直接进入
  if (sessionStorage.getItem(VIA_CAS_KEY) === '1') {
    markViaCas(false);
    const ru = `${window.location.origin}/login`;
    window.location.replace(`/api/v1/auth/cas/logout?ru=${encodeURIComponent(ru)}`);
  }
}

export async function changePassword(oldPassword: string, newPassword: string) {
  const r = await post<{ accessToken: string; refreshToken: string; user: JwtUser }>('/auth/change-password', { oldPassword, newPassword });
  setAccessToken(r.accessToken);
  setRefreshToken(r.refreshToken);
  return r.user;
}

/** 静默恢复会话（页面刷新后靠 refresh cookie 换新 access）。
    整体单飞：StrictMode 双挂载等并发恢复只发一次 refresh + 一次 /auth/me，
    否则同 cookie 并发轮换会触发后端重用检测、连坐吊销整个令牌家族 */
let restoring: Promise<JwtUser | null> | null = null;
export function restore(): Promise<JwtUser | null> {
  restoring ??= (async () => {
    const token = await refreshAccessToken();
    if (!token) return null;
    return (await get<JwtUser>('/auth/me').catch(() => null)) as JwtUser | null;
  })().finally(() => (restoring = null));
  return restoring;
}
