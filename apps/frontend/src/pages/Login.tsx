import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Typography } from 'antd';
import {
  ArrowLeftOutlined,
  LockOutlined,
  ReloadOutlined,
  RightOutlined,
  SafetyOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { errMsg } from '../api/client';
import { casAuthorizeUrl, fetchCaptcha, login, studentLanding, verifyPassphrase } from '../api';
import { useAuth } from '../store/auth';

/** 密语口令通过记录（sessionStorage，9 分钟；管理员表单刷新/返回重进免重输） */
const GATE_KEY = 'zc:gate';

type Stage = 'main' | 'admin';

function loadGate(): string | null {
  try {
    const g = JSON.parse(sessionStorage.getItem(GATE_KEY) ?? 'null');
    if (g?.token && g.exp > Date.now()) return g.token as string;
  } catch {
    /* 解析失败按未验证处理 */
  }
  sessionStorage.removeItem(GATE_KEY);
  return null;
}

function saveGate(token: string) {
  sessionStorage.setItem(GATE_KEY, JSON.stringify({ token, exp: Date.now() + 9 * 60 * 1000 }));
}

/**
 * 登录页（瑞士网格：12 栏非对称；左标题 + 按比例分栏的满分构成，右身份选择面板）：
 * 学生 = 「学生数字大外登录」直接跳转 CAS（无需密语）；
 * 管理员 = 点击后弹窗验证密语口令 → 通过进入本地账号表单（后端 /auth/login 强制校验 gateToken）。
 */
export default function Login() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const { setUser } = useAuth();

  const [stage, setStage] = useState<Stage>('main');
  const [gateToken, setGateToken] = useState<string | null>(() => loadGate());
  const [gateOpen, setGateOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [gateChecking, setGateChecking] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
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

  // 进入管理员表单时才需要验证码
  useEffect(() => {
    if (stage === 'admin' && !captcha) refreshCaptcha();
  }, [stage, captcha, refreshCaptcha]);

  // ---- 数字大外：直接跳转学校统一认证（学生无需密语） ----
  const goCas = () => {
    window.location.href = casAuthorizeUrl();
  };

  // ---- 管理员：已验证直进表单；否则先弹密语口令 ----
  const goAdmin = () => {
    if (gateToken) {
      setStage('admin');
      return;
    }
    setPassphrase('');
    setGateOpen(true);
  };

  const closeGate = () => {
    if (!gateChecking) setGateOpen(false);
  };

  const confirmGate = async () => {
    if (!passphrase.trim()) {
      message.warning('请输入密语口令');
      return;
    }
    setGateChecking(true);
    try {
      const r = await verifyPassphrase(passphrase);
      saveGate(r.gateToken);
      setGateToken(r.gateToken);
      setGateOpen(false);
      setPassphrase('');
      setStage('admin');
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setGateChecking(false);
    }
  };

  // ---- 管理员本地登录 ----
  const onFinish = async (v: { username: string; password: string }) => {
    if (!captcha) {
      message.warning('验证码加载失败，请点击刷新');
      refreshCaptcha();
      return;
    }
    if (!gateToken) {
      setGateOpen(true);
      return;
    }
    const captchaPayload = { captchaId: captcha.captchaId, captchaCode: captchaInput.trim() };
    if (!captchaPayload.captchaCode) {
      message.warning('请输入验证码');
      return;
    }
    setLoginLoading(true);
    try {
      const user = await login(v.username.trim(), v.password, gateToken, captchaPayload);
      setUser(user);
      message.success(`欢迎，${user.name}`);
      const from = (loc.state as { from?: string } | null)?.from;
      // 首登强制改密由布局内弹框承担；学生公示期直跳查分
      const dest = from && from !== '/login' ? from : user.role === 'STUDENT' ? await studentLanding() : '/admin';
      nav(dest, { replace: true });
    } catch (e) {
      const m = errMsg(e);
      message.error(m);
      refreshCaptcha(); // 验证码一次性：失败后必须刷新
      if (m.includes('密语')) {
        // 门过期：清掉本地令牌重新弹窗验证
        sessionStorage.removeItem(GATE_KEY);
        setGateToken(null);
        setGateOpen(true);
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const d = (ms: number) => ({ '--d': `${ms}ms` }) as React.CSSProperties;

  return (
    <div className="zc-login">
      <header className="zc-login-top zc-in" style={d(0)}>
        <img className="zc-login-logo" src="/dlufl-logo.png" alt="大连外国语大学" />
        <span className="zc-login-org">软件学院</span>
      </header>

      <div className="zc-login-main">
        {/* 左（第 1–7 栏）：标题 + 满分构成。构成按 15 / 75 / 10 的真实比例分栏，数字本身就是主视觉 */}
        <section className="zc-login-intro">
          <h1 className="zc-login-title zc-in" style={d(40)}>
            综合素质测评平台
          </h1>
          <p className="zc-login-lead zc-in" style={d(100)}>
            提交加分材料，跟进审核，核对成绩与排名。每一分都有来源可查。
          </p>
          <div className="zc-comp zc-in" style={d(160)}>
            <p className="zc-comp-cap">满分 100 分，按三项计</p>
            <dl className="zc-comp-cols">
              {[
                { k: 'moral', name: '品德', w: 15 },
                { k: 'academic', name: '学业', w: 75 },
                { k: 'sports', name: '文体', w: 10 },
              ].map((c, i) => (
                <div key={c.k} className={`zc-comp-col ${c.k}`} style={{ '--w': c.w, ...d(240 + i * 80) } as React.CSSProperties}>
                  <dt>{c.name}</dt>
                  <dd className="zc-num">{c.w}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* 右：登录面板 */}
        <section className="zc-login-panel zc-in" style={d(140)} aria-label="登录">
          {/* key=阶段：选身份 ↔ 管理员表单切换时内容淡入，标明状态已变化 */}
          <div key={stage} className="zc-swap">
            {stage === 'main' && (
              <>
                <h2 className="zc-login-h2">登录</h2>
                <p className="zc-login-sub">请选择你的身份</p>
                <div className="zc-login-entries">
                  <button type="button" className="zc-login-entry primary" onClick={goCas}>
                    <span className="zc-login-entry-ico">
                      <TeamOutlined />
                    </span>
                    <span className="zc-login-entry-text">
                      <b>我是学生</b>
                      <small>使用数字大外统一身份认证</small>
                    </span>
                    <RightOutlined className="zc-login-entry-go" />
                  </button>
                  <button type="button" className="zc-login-entry" onClick={goAdmin}>
                    <span className="zc-login-entry-ico">
                      <UserOutlined />
                    </span>
                    <span className="zc-login-entry-text">
                      <b>我是教师 / 管理员</b>
                      <small>使用平台账号和密码</small>
                    </span>
                    <RightOutlined className="zc-login-entry-go" />
                  </button>
                </div>
              </>
            )}

            {stage === 'admin' && (
              <>
                <button type="button" className="zc-login-back" onClick={() => setStage('main')}>
                  <ArrowLeftOutlined /> 重新选择身份
                </button>
                <h2 className="zc-login-h2">管理员登录</h2>
                <p className="zc-login-sub">忘记密码请联系学院管理员重置</p>
                <Form layout="vertical" onFinish={onFinish} requiredMark={false} className="zc-login-form">
                  <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
                    <Input size="large" prefix={<UserOutlined />} placeholder="工号 / 账号" autoComplete="username" autoFocus />
                  </Form.Item>
                  <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
                    <Input.Password size="large" prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
                  </Form.Item>
                  <Form.Item required label="验证码">
                    <div className="zc-captcha-row">
                      <Input
                        size="large"
                        prefix={<SafetyOutlined />}
                        placeholder="验证码"
                        value={captchaInput}
                        onChange={(e) => setCaptchaInput(e.target.value.toUpperCase())}
                        maxLength={4}
                        onPressEnter={() => document.querySelector<HTMLButtonElement>('.zc-login-form button[type=submit]')?.click()}
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
                  <Button type="primary" size="large" htmlType="submit" block loading={loginLoading}>
                    登录
                  </Button>
                </Form>
              </>
            )}
          </div>
        </section>
      </div>

      <footer className="zc-login-foot">
        <span>大连外国语大学 软件学院</span>
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
          辽ICP备2026000633号-1
        </a>
      </footer>

      {/* 密语口令弹窗（管理员入口第一道门，Input.Password 遮蔽输入） */}
      <Modal
        title="管理员验证"
        open={gateOpen}
        onOk={confirmGate}
        onCancel={closeGate}
        okText="验证"
        cancelText="取消"
        okButtonProps={{ loading: gateChecking }}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" className="zc-gate-modal-hint">
          请输入学院统一发布的密语口令。口令不清楚的，请联系学院管理员。
        </Typography.Paragraph>
        <Input.Password
          size="large"
          prefix={<LockOutlined />}
          placeholder="密语口令"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onPressEnter={confirmGate}
          maxLength={64}
          autoFocus
        />
      </Modal>
    </div>
  );
}
