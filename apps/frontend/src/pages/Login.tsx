import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Segmented, Typography } from 'antd';
import { LockOutlined, ReloadOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { errMsg } from '../api/client';
import { fetchActiveBatch, fetchCaptcha } from '../api';
import { useAuth } from '../store/auth';

type LoginMode = 'CAS' | 'LOCAL';

/** 公示期学生登录直跳查分页；其余回首页 */
async function studentLanding(): Promise<string> {
  try {
    const b = await fetchActiveBatch();
    if (b?.status === 'PUBLICITY') return '/student/score';
  } catch {
    /* 拿不到批次信息时按默认回首页 */
  }
  return '/student/home';
}

export default function Login() {
  const { login, casLogin } = useAuth();
  const { message } = App.useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<LoginMode>('CAS');
  const [captcha, setCaptcha] = useState<{ captchaId: string; svg: string } | null>(null);
  const [captchaInput, setCaptchaInput] = useState('');

  const refreshCaptcha = useCallback(() => {
    fetchCaptcha()
      .then((c) => {
        setCaptcha(c);
        setCaptchaInput('');
      })
      .catch(() => setCaptcha(null));
  }, []);
  useEffect(refreshCaptcha, [refreshCaptcha]);

  const onFinish = async (v: { username: string; password: string }) => {
    if (!captcha) {
      message.warning('验证码加载失败，请点击刷新');
      refreshCaptcha();
      return;
    }
    const captchaPayload = { captchaId: captcha.captchaId, captchaCode: captchaInput.trim() };
    if (!captchaPayload.captchaCode) {
      message.warning('请输入验证码');
      return;
    }
    setLoading(true);
    try {
      const user =
        mode === 'CAS' ? await casLogin(v.username.trim(), v.password, captchaPayload) : await login(v.username.trim(), v.password, captchaPayload);
      message.success(`欢迎，${user.name}`);
      const from = (loc.state as { from?: string } | null)?.from;
      // 首登强制改密仅管理员；学生公示期直跳查分
      const dest = user.mustChangePwd
        ? '/change-password'
        : from && from !== '/login'
          ? from
          : user.role === 'STUDENT'
            ? await studentLanding()
            : '/admin';
      nav(dest, { replace: true });
    } catch (e) {
      message.error(errMsg(e));
      refreshCaptcha(); // 验证码一次性：失败后必须刷新
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="zc-login-bg">
      <Card className="zc-login-card">
        <div className="zc-login-logo">软</div>
        <Typography.Title level={4} style={{ textAlign: 'center', marginTop: 12 }}>
          软件学院综合素质测评平台
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          大连外国语大学 · 软件学院
        </Typography.Paragraph>
        <Segmented
          block
          value={mode}
          onChange={(v) => setMode(v as LoginMode)}
          options={[
            { value: 'CAS', label: '统一身份认证' },
            { value: 'LOCAL', label: '本地账号' },
          ]}
          style={{ marginBottom: 20 }}
        />
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="username" rules={[{ required: true, message: mode === 'CAS' ? '请输入学号' : '请输入学号/账号' }]}>
            <Input size="large" prefix={<UserOutlined />} placeholder="学号" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              size="large"
              prefix={<LockOutlined />}
              placeholder={mode === 'CAS' ? '数字大外密码' : '密码'}
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item required>
            <div className="zc-captcha-row">
              <Input
                size="large"
                prefix={<SafetyOutlined />}
                placeholder="验证码"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value.toUpperCase())}
                maxLength={4}
                onPressEnter={() => document.querySelector<HTMLButtonElement>('.zc-login-card button[type=submit]')?.click()}
              />
              {captcha ? (
                <button type="button" className="zc-captcha-img" title="点击刷新验证码" onClick={refreshCaptcha} dangerouslySetInnerHTML={{ __html: captcha.svg }} />
              ) : (
                <button type="button" className="zc-captcha-img" title="点击重新获取" onClick={refreshCaptcha}>
                  <ReloadOutlined /> 刷新
                </button>
              )}
            </div>
          </Form.Item>
          <Button type="primary" size="large" htmlType="submit" block loading={loading}>
            登 录
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginTop: 16, marginBottom: 0, fontSize: 12 }}>
          {mode === 'CAS'
            ? '统一身份认证使用数字大外（智慧大外）的学号与密码'
            : '本地账号供管理员使用；学生首次登录初始密码为学号后 6 位'}
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
