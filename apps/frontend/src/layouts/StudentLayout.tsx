import { Suspense, useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Grid } from 'antd';
import {
  AppstoreOutlined,
  CloudUploadOutlined,
  ProfileOutlined,
  LineChartOutlined,
  LogoutOutlined,
  FileProtectOutlined,
} from '@ant-design/icons';
import { useAuth } from '../store/auth';
import ChangePasswordModal from '../components/ChangePasswordModal';
import RouteFallback from '../components/RouteFallback';
import PageErrorBoundary from '../components/PageErrorBoundary';

/** 学生端：窄屏底部 TabBar，宽屏顶部导航（一套代码双端适配） */
const TABS = [
  { key: '/student/home', label: '首页', icon: <AppstoreOutlined /> },
  { key: '/student/apply', label: '提材料', icon: <CloudUploadOutlined /> },
  { key: '/student/applications', label: '我的', icon: <ProfileOutlined /> },
  { key: '/student/score', label: '查分', icon: <LineChartOutlined /> },
];

export default function StudentLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const { user, logout } = useAuth();
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.md;

  const doLogout = () => logout().finally(() => nav('/login', { replace: true }));

  const activeIdx = useMemo(() => Math.max(0, TABS.findIndex((t) => loc.pathname.startsWith(t.key))), [loc.pathname]);
  const activeKey = TABS[activeIdx].key;
  // 滑动指示条：只改 transform（合成层），不随宽度/位置触发布局
  const indStyle = { '--i': activeIdx } as React.CSSProperties;

  const header = (
    <div className="zc-stu-header">
      <div className="zc-stu-brand">
        <div className="zc-stu-logo">
          <img src="/favicon-32x32.png" alt="大连外国语大学校徽" />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="zc-stu-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>软件学院综测平台</div>
          <div className="zc-stu-sub">{user ? [user.name, user.className].filter(Boolean).join(' · ') : ''}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        {isDesktop && (
          <nav className="zc-stu-nav" aria-label="学生端导航">
            <span className="zc-stu-nav-ind" style={indStyle} aria-hidden="true" />
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`zc-stu-nav-item ${activeKey === t.key ? 'active' : ''}`}
                onClick={() => nav(t.key)}
                aria-current={activeKey === t.key ? 'page' : undefined}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
        )}
        {user?.role === 'CLASS_LEADER' && (
          <button className="zc-stu-logout" onClick={() => nav('/admin/review-first')} aria-label="班级初审工作台" title="班级初审工作台">
            <FileProtectOutlined />
            <span style={{ marginLeft: 4 }}>{isDesktop ? '班级初审' : '初审'}</span>
          </button>
        )}
        <button className="zc-stu-logout" onClick={doLogout} aria-label="退出登录" title="退出登录">
          <LogoutOutlined />
          {isDesktop && <span style={{ marginLeft: 4 }}>退出</span>}
        </button>
      </div>
    </div>
  );

  return (
    <div className="zc-stu-shell">
      {header}
      <main className="zc-mobile-canvas">
        {/* key=路由：切页时触发一次轻量入场（opacity + 4px 位移） */}
        <div key={loc.pathname} className="zc-route">
          <PageErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
            </PageErrorBoundary>
        </div>
      </main>
      {!isDesktop && (
        <nav className="zc-tabbar" aria-label="底部导航">
          <span className="zc-tabbar-ind" style={indStyle} aria-hidden="true" />
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`zc-tabbar-item ${activeKey === t.key ? 'active' : ''}`}
              onClick={() => nav(t.key)}
              aria-current={activeKey === t.key ? 'page' : undefined}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      )}
      {/* 密码登录学生的首登强制改密（CAS 学生无本地密码，不会触发） */}
      <ChangePasswordModal open={!!user?.mustChangePwd} onClose={() => undefined} />
    </div>
  );
}
