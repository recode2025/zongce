import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Result, Spin, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { get, setAccessToken, setRefreshToken } from '../api/client';
import { markViaCas, studentLanding } from '../api';
import { useAuth } from '../store/auth';

/**
 * 跳转式 CAS 登录回调页。
 * 后端 /auth/cas/callback 校验 ticket 后 302 到本页，token 放在 URL fragment（不进服务端日志）：
 *   /cas/callback#token=...&rt=...&name=...   成功
 *   /cas/callback#error=...                   失败
 */
export default function CasCallback() {
  const nav = useNavigate();
  const { setUser } = useAuth();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode 双跑保护
    started.current = true;

    const frag = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, '', '/cas/callback'); // 立即清掉地址栏中的 token

    const token = frag.get('token');
    const rt = frag.get('rt');
    const err = frag.get('error');

    if (err) {
      setError(err);
      return;
    }
    if (!token) {
      setError('未收到登录凭证，请重新登录');
      return;
    }

    setAccessToken(token);
    setRefreshToken(rt ?? '');
    markViaCas(true); // 标记本次会话经 CAS 建立：退出时联动销毁学校 SSO 会话
    get('/auth/me')
      .then(async (user: any) => {
        setUser(user);
        const dest = user.role === 'STUDENT' ? await studentLanding() : '/admin';
        nav(dest, { replace: true });
      })
      .catch(() => setError('会话恢复失败，请重新登录'));
  }, [nav, setUser]);

  if (error) {
    return (
      <div className="zc-auth-shell">
        <main className="zc-auth-panel">
          <Card className="zc-auth-card">
            <Result
              status="warning"
              title="数字大外登录未完成"
              subTitle={error}
              extra={
                <Button type="primary" size="large" onClick={() => nav('/login', { replace: true })}>
                  返回登录
                </Button>
              }
            />
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="zc-auth-shell">
      <main className="zc-auth-panel">
        <Card className="zc-auth-card">
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <Spin size="large" />
            <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
              正在完成数字大外统一认证…
            </Typography.Paragraph>
          </div>
        </Card>
      </main>
    </div>
  );
}
