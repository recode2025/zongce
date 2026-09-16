import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { errMsg } from '../api/client';
import { useAuth } from '../store/auth';

export default function Login() {
  const { login } = useAuth();
  const { message } = App.useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [loading, setLoading] = useState(false);

  const onFinish = async (v: { username: string; password: string }) => {
    setLoading(true);
    try {
      const user = await login(v.username.trim(), v.password);
      message.success(`欢迎，${user.name}`);
      const from = (loc.state as { from?: string } | null)?.from;
      const dest = user.mustChangePwd
        ? '/change-password'
        : from && from !== '/login'
          ? from
          : user.role === 'STUDENT'
            ? '/student/home'
            : '/admin';
      nav(dest, { replace: true });
    } catch (e) {
      message.error(errMsg(e));
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
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入学号/账号' }]}>
            <Input size="large" prefix={<UserOutlined />} placeholder="学号 / 账号" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" size="large" htmlType="submit" block loading={loading}>
            登 录
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginTop: 16, marginBottom: 0, fontSize: 12 }}>
          首次登录请使用初始密码（默认为学号后 6 位），登录后需立即修改
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
