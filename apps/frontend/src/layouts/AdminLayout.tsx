import { useMemo } from 'react';
import { Avatar, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import {
  CalculatorOutlined,
  DashboardOutlined,
  ExportOutlined,
  FileProtectOutlined,
  FileSearchOutlined,
  KeyOutlined,
  LogoutOutlined,
  PartitionOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SoundOutlined,
  TeamOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ROLE_TEXT, useAuth } from '../store/auth';

const { Header, Sider, Content } = Layout;

/** 管理端/班委端布局：侧栏按角色收敛（CLASS_LEADER 仅初审工作台） */
export default function AdminLayout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();

  const menus = useMemo(() => {
    const admin = [
      { key: '/admin/dashboard', icon: <DashboardOutlined />, label: '统计看板' },
      { key: '/admin/batches', icon: <PartitionOutlined />, label: '批次管理' },
      { key: '/admin/students', icon: <TeamOutlined />, label: '学生与班级' },
      { key: '/admin/grades', icon: <ProfileOutlined />, label: '成绩导入与异常' },
      { key: '/admin/rules', icon: <SafetyCertificateOutlined />, label: '规则字典' },
      { key: '/admin/review-first', icon: <FileProtectOutlined />, label: '班级初审' },
      { key: '/admin/review', icon: <FileSearchOutlined />, label: '复审工作台' },
      { key: '/admin/calc', icon: <CalculatorOutlined />, label: '计算引擎' },
      { key: '/admin/publish', icon: <SoundOutlined />, label: '发布与公示' },
      { key: '/admin/export', icon: <ExportOutlined />, label: '导出中心' },
      { key: '/admin/system', icon: <SettingOutlined />, label: '系统管理' },
    ];
    if (!user) return admin;
    if (user.role === 'CLASS_LEADER') {
      return [{ key: '/admin/review-first', icon: <FileProtectOutlined />, label: '班级初审工作台' }];
    }
    return admin;
  }, [user]);

  const selected = loc.pathname.startsWith('/admin') ? loc.pathname : '/admin/dashboard';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={216} theme="dark" breakpoint="lg" collapsedWidth={0}>
        <div className="zc-admin-brand">
          <TrophyOutlined />
          <span>软件学院综测平台</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={menus}
          onClick={({ key }) => nav(key)}
        />
      </Sider>
      <Layout>
        <Header className="zc-admin-header">
          <Typography.Text type="secondary">{user?.role === 'CLASS_LEADER' ? `${user.className ?? ''} 初审工作台` : '管理控制台'}</Typography.Text>
          <Dropdown
            menu={{
              items: [
                { key: 'role', label: `${user?.name}（${user ? ROLE_TEXT[user.role] : ''}）`, disabled: true },
                { type: 'divider' },
                { key: 'pwd', icon: <KeyOutlined />, label: '修改密码' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'pwd') {
                  nav('/change-password');
                } else if (key === 'logout') {
                  logout().finally(() => nav('/login', { replace: true }));
                }
              },
            }}
          >
            <Space style={{ cursor: 'pointer' }}>
              <Avatar style={{ background: '#2f54eb' }}>{user?.name?.slice(0, 1) ?? '?'}</Avatar>
              <Typography.Text strong>{user?.name}</Typography.Text>
            </Space>
          </Dropdown>
        </Header>
        <Content className="zc-admin-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
