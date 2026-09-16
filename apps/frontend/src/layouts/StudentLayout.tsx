import { useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Grid } from 'antd';
import {
  AppstoreOutlined,
  CloudUploadOutlined,
  ProfileOutlined,
  LineChartOutlined,
} from '@ant-design/icons';
import { useAuth } from '../store/auth';

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
  const { user } = useAuth();
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.md;

  const activeKey = useMemo(() => {
    const hit = TABS.find((t) => loc.pathname.startsWith(t.key));
    return hit?.key ?? TABS[0].key;
  }, [loc.pathname]);

  const header = (
    <div className="zc-stu-header">
      <div className="zc-stu-brand">
        <div className="zc-stu-logo">软</div>
        <div>
          <div className="zc-stu-title">软件学院综测平台</div>
          <div className="zc-stu-sub">{user ? `${user.name} · ${user.className ?? ''}` : ''}</div>
        </div>
      </div>
      {isDesktop && (
        <nav className="zc-stu-nav">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`zc-stu-nav-item ${activeKey === t.key ? 'active' : ''}`}
              onClick={() => nav(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );

  return (
    <div className="zc-stu-shell">
      {header}
      <main className="zc-mobile-canvas">
        <Outlet />
      </main>
      {!isDesktop && (
        <div className="zc-tabbar">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`zc-tabbar-item ${activeKey === t.key ? 'active' : ''}`}
              onClick={() => nav(t.key)}
            >
              <Badge dot={false}>{t.icon}</Badge>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
