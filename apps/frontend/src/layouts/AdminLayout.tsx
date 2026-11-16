import { Suspense, useMemo, useState } from 'react';
import { Avatar, Dropdown, Layout, Menu } from 'antd';
import type { MenuProps } from 'antd';
import {
  CalculatorOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  DownOutlined,
  ExportOutlined,
  FileProtectOutlined,
  FileAddOutlined,
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
import ChangePasswordModal from '../components/ChangePasswordModal';
import RouteFallback from '../components/RouteFallback';
import PageErrorBoundary from '../components/PageErrorBoundary';

const { Header, Sider, Content } = Layout;

interface NavItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  superOnly?: boolean;
}

/** 管理端菜单按学期工作流分组：数据准备 → 审核 → 计算发布 */
const ADMIN_NAV: { group: string; items: NavItem[] }[] = [
  { group: '概览', items: [{ key: '/admin/dashboard', icon: <DashboardOutlined />, label: '统计看板' }] },
  {
    group: '数据准备',
    items: [
      { key: '/admin/batches', icon: <PartitionOutlined />, label: '批次管理' },
      { key: '/admin/students', icon: <TeamOutlined />, label: '学生与班级' },
      { key: '/admin/grades', icon: <ProfileOutlined />, label: '成绩导入与异常' },
      { key: '/admin/historical-import', icon: <FileAddOutlined />, label: '历史数据导入', superOnly: true },
      { key: '/admin/rules', icon: <SafetyCertificateOutlined />, label: '规则字典' },
    ],
  },
  {
    group: '审核',
    items: [
      { key: '/admin/review-first', icon: <FileProtectOutlined />, label: '班级初审' },
      { key: '/admin/review', icon: <FileSearchOutlined />, label: '复审工作台' },
    ],
  },
  {
    group: '计算与发布',
    items: [
      { key: '/admin/calc', icon: <CalculatorOutlined />, label: '计算引擎' },
      { key: '/admin/publish', icon: <SoundOutlined />, label: '发布与公示' },
      { key: '/admin/scholarship', icon: <TrophyOutlined />, label: '奖学金记录' },
      { key: '/admin/export', icon: <ExportOutlined />, label: '导出中心' },
    ],
  },
  { group: '系统', items: [{ key: '/admin/system', icon: <SettingOutlined />, label: '系统管理' }] },
];

const LEADER_NAV = [
  { group: '班级', items: [{ key: '/admin/review-first', icon: <FileProtectOutlined />, label: '班级初审工作台' }] },
  { group: '个人', items: [{ key: '/student/home', icon: <AppstoreOutlined />, label: '我的申报与成绩' }] },
];

/** 管理端/班委端布局：侧栏按角色收敛 */
export default function AdminLayout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [pwdOpen, setPwdOpen] = useState(false);

  const groups = useMemo(() => {
    if (user?.role === 'CLASS_LEADER') return LEADER_NAV;
    return ADMIN_NAV.map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.superOnly || user?.role === 'SUPER_ADMIN'),
    }));
  }, [user?.role]);

  const menuItems = useMemo<MenuProps['items']>(
    () =>
      groups.map((g) => ({
        type: 'group' as const,
        key: g.group,
        label: g.group,
        children: g.items.map((it) => ({ key: it.key, icon: it.icon, label: it.label })),
      })),
    [groups],
  );

  const selected = loc.pathname.startsWith('/admin') ? loc.pathname : '/admin/dashboard';
  const current = useMemo(() => {
    for (const g of groups) {
      const hit = g.items.find((it) => selected.startsWith(it.key));
      if (hit) return { group: g.group, label: hit.label };
    }
    return { group: '', label: '管理控制台' };
  }, [groups, selected]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={232} theme="light" breakpoint="lg" collapsedWidth={0} className="zc-admin-sider">
        <div className="zc-admin-brand">
          <img src="/favicon-32x32.png" alt="大连外国语大学校徽" />
          <div className="zc-admin-brand-text">
            <b>综测平台</b>
            <span>大连外国语大学 · 软件学院</span>
          </div>
        </div>
        <Menu mode="inline" selectedKeys={[selected]} items={menuItems} onClick={({ key }) => nav(key)} />
      </Sider>
      <Layout>
        <Header className="zc-admin-header">
          <div className="zc-admin-crumb">
            {current.group && (
              <>
                <span className="zc-admin-crumb-group">
                  {user?.role === 'CLASS_LEADER' && user.className ? user.className : current.group}
                </span>
                <span className="zc-admin-crumb-sep">/</span>
              </>
            )}
            <h1>{current.label}</h1>
          </div>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'pwd', icon: <KeyOutlined />, label: '修改密码' },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'pwd') {
                  setPwdOpen(true);
                } else if (key === 'logout') {
                  logout().finally(() => nav('/login', { replace: true }));
                }
              },
            }}
          >
            <button type="button" className="zc-admin-user">
              <Avatar size={32} style={{ background: 'var(--zc-primary-soft)', color: 'var(--zc-primary)', fontSize: 14, fontWeight: 600 }}>
                {user?.name?.slice(0, 1) ?? '?'}
              </Avatar>
              <span className="zc-admin-user-name">
                <b>{user?.name}</b>
                <span>{user ? ROLE_TEXT[user.role] : ''}</span>
              </span>
              <DownOutlined style={{ fontSize: 10, color: 'var(--zc-text-3)' }} />
            </button>
          </Dropdown>
        </Header>
        <Content className="zc-admin-content">
          {/* key=路由：切页时触发一次轻量入场（opacity + 4px 位移） */}
          <div key={loc.pathname} className="zc-route">
            <PageErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <Outlet />
            </Suspense>
            </PageErrorBoundary>
          </div>
        </Content>
      </Layout>
      {/* 修改密码弹框（顶栏入口；mustChangePwd 首登强制态自动弹出且不可关闭） */}
      <ChangePasswordModal open={pwdOpen || !!user?.mustChangePwd} onClose={() => setPwdOpen(false)} />
    </Layout>
  );
}
