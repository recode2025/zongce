import { useState } from 'react';
import { App, Form, Input, Modal, Progress, Typography } from 'antd';
import { errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { ZC } from '../theme';

const strength = (pwd: string) => {
  let s = 0;
  if (pwd.length >= 8) s += 34;
  if (/[a-zA-Z]/.test(pwd) && /\d/.test(pwd)) s += 33;
  if (/[^a-zA-Z0-9]/.test(pwd)) s += 33;
  return s;
};

/** 修改密码弹框（后台顶栏入口；mustChangePwd 首登强制态不可关闭，改完才放行） */
export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, changePassword } = useAuth();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [pwd, setPwd] = useState('');
  const forced = !!user?.mustChangePwd;

  const onOk = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setLoading(true);
    try {
      await changePassword(v.oldPassword, v.newPassword);
      message.success('密码修改成功');
      form.resetFields();
      setPwd('');
      onClose(); // 强制态下 store 已更新 mustChangePwd=false，弹框随之关闭
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      title={forced ? '首次登录，请修改初始密码' : '修改密码'}
      onOk={onOk}
      onCancel={forced ? undefined : onClose}
      cancelButtonProps={forced ? { style: { display: 'none' } } : undefined}
      closable={!forced}
      keyboard={!forced}
      maskClosable={!forced}
      confirmLoading={loading}
      okText="确认修改"
      width={420}
      destroyOnHidden
    >
      {forced && (
        <Typography.Paragraph type="warning" style={{ marginBottom: 16 }}>
          为保障账号安全，修改密码前无法使用其他功能
        </Typography.Paragraph>
      )}
      <Form form={form} layout="vertical">
        <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password placeholder="初始密码 / 当前密码" autoComplete="current-password" />
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
          <Input.Password placeholder="至少 8 位，含字母和数字" autoComplete="new-password" onChange={(e) => setPwd(e.target.value)} />
        </Form.Item>
        {pwd && (
          <Progress
            percent={strength(pwd)}
            showInfo={false}
            strokeColor={{ 0: ZC.danger, 34: ZC.warning, 67: ZC.success } as any}
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
          <Input.Password placeholder="再次输入新密码" autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
