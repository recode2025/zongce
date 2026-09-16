import { useState } from 'react';
import { App, Button, Card, Form, Input, Progress, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { errMsg } from '../api/client';
import { useAuth } from '../store/auth';

const strength = (pwd: string) => {
  let s = 0;
  if (pwd.length >= 8) s += 34;
  if (/[a-zA-Z]/.test(pwd) && /\d/.test(pwd)) s += 33;
  if (/[^a-zA-Z0-9]/.test(pwd)) s += 33;
  return s;
};

export default function ChangePassword() {
  const { user, changePassword } = useAuth();
  const { message } = App.useApp();
  const nav = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [pwd, setPwd] = useState('');

  const onFinish = async (v: { oldPassword: string; newPassword: string }) => {
    setLoading(true);
    try {
      const u = await changePassword(v.oldPassword, v.newPassword);
      message.success('密码修改成功');
      nav(u.role === 'STUDENT' ? '/student/home' : '/admin', { replace: true });
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="zc-login-bg">
      <Card className="zc-login-card" style={{ maxWidth: 440 }}>
        <Typography.Title level={4} style={{ textAlign: 'center' }}>
          {user?.mustChangePwd ? '首次登录，请修改初始密码' : '修改密码'}
        </Typography.Title>
        {user?.mustChangePwd && (
          <Typography.Paragraph type="warning" style={{ textAlign: 'center' }}>
            为保障账号安全，修改密码前无法使用其他功能
          </Typography.Paragraph>
        )}
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password size="large" placeholder="初始密码 / 当前密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, message: '至少 8 位' },
              { pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/, message: '须包含字母和数字' },
            ]}
          >
            <Input.Password size="large" placeholder="至少 8 位，含字母和数字" autoComplete="new-password" onChange={(e) => setPwd(e.target.value)} />
          </Form.Item>
          {pwd && (
            <Progress
              percent={strength(pwd)}
              showInfo={false}
              strokeColor={{ 0: '#ff4d4f', 34: '#faad14', 67: '#52c41a' } as any}
              size="small"
              style={{ marginBottom: 16 }}
            />
          )}
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator: (_, v) => (v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))),
              }),
            ]}
          >
            <Input.Password size="large" placeholder="再次输入新密码" autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" size="large" htmlType="submit" block loading={loading}>
            确认修改
          </Button>
        </Form>
      </Card>
    </div>
  );
}
