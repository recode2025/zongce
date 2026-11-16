import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth, JwtUser } from './store/auth';
import Login from './pages/Login';
import CasCallback from './pages/CasCallback';
// 页面与布局按路由懒加载：学生端不再下载管理端代码（登录页/回调页保持同步加载，首屏即用）
const StudentLayout = lazy(() => import('./layouts/StudentLayout'));
const AdminLayout = lazy(() => import('./layouts/AdminLayout'));
const StudentHome = lazy(() => import('./pages/student/Home'));
const Apply = lazy(() => import('./pages/student/Apply'));
const MyApplications = lazy(() => import('./pages/student/Applications'));
const MyScore = lazy(() => import('./pages/student/Score'));
const FirstReview = lazy(() => import('./pages/leader/FirstReview'));
const Dashboard = lazy(() => import('./pages/admin/Dashboard'));
const Batches = lazy(() => import('./pages/admin/Batches'));
const Students = lazy(() => import('./pages/admin/Students'));
const Grades = lazy(() => import('./pages/admin/Grades'));
const Rules = lazy(() => import('./pages/admin/Rules'));
const SecondReview = lazy(() => import('./pages/admin/SecondReview'));
const Calc = lazy(() => import('./pages/admin/Calc'));
const Publish = lazy(() => import('./pages/admin/Publish'));
const ExportCenter = lazy(() => import('./pages/admin/Export'));
const System = lazy(() => import('./pages/admin/System'));
const Scholarship = lazy(() => import('./pages/admin/Scholarship'));

const FULL_SCREEN = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' };

function SessionLoading() {
  return (
    <div style={{ ...FULL_SCREEN, flexDirection: 'column', gap: 12 }} role="status" aria-live="polite">
      <Spin size="large" />
      <span>正在恢复会话…</span>
    </div>
  );
}

/** 未登录只放行 /login（首登强制改密由布局内的 ChangePasswordModal 承担） */
function Gate({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  // 仅在「会话未知且无用户」时等待；CAS 回调已 setUser 的瞬间直接放行，避免再闪一屏 Spin
  if (!ready && !user) return <SessionLoading />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}

/** 角色门禁 */
function RoleGate({ roles, children }: { roles: JwtUser['role'][]; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  const pass = user.role === 'SUPER_ADMIN' || roles.includes(user.role);
  if (!pass) return <Navigate to={user.role === 'STUDENT' ? '/student/home' : user.role === 'CLASS_LEADER' ? '/admin/review-first' : '/admin/dashboard'} replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, ready } = useAuth();
  if (!user) {
    // 未登录或启动中：/cas/callback 始终挂载 CasCallback（自行消费 URL fragment 里的 token；
    // 若启动阶段就重定向会丢掉 token、只能靠 cookie 兜底恢复，中间闪一屏「正在恢复会话」）。
    // 其余路径在会话恢复完成前先显示等待，恢复完仍无用户则回登录页。
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/cas/callback" element={<CasCallback />} />
        <Route
          path="*"
          element={
            ready ? (
              <Navigate to="/login" replace />
            ) : (
              <SessionLoading />
            )
          }
        />
      </Routes>
    );
  }
  return (
    // 布局懒加载期间的占位：延迟 200ms 才显示，快速网络下不闪
    <Suspense fallback={<div style={FULL_SCREEN}><Spin size="large" delay={200} /></div>}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/cas/callback" element={<Navigate to={user?.role === 'STUDENT' ? '/student/home' : '/admin'} replace />} />

      {/* —— 学生端（移动优先） —— */}
      <Route path="/student" element={<Gate><RoleGate roles={['STUDENT', 'CLASS_LEADER']}><StudentLayout /></RoleGate></Gate>}>
        <Route index element={<Navigate to="home" replace />} />
        <Route path="home" element={<StudentHome />} />
        <Route path="apply" element={<Apply />} />
        <Route path="applications" element={<MyApplications />} />
        <Route path="score" element={<MyScore />} />
      </Route>

      {/* —— 班委 + 管理端（桌面优先） —— */}
      <Route path="/admin" element={<Gate><AdminLayout /></Gate>}>
        <Route index element={<Navigate to={user?.role === 'CLASS_LEADER' ? 'review-first' : 'dashboard'} replace />} />
        <Route path="dashboard" element={<RoleGate roles={['GRADE_ADMIN']}><Dashboard /></RoleGate>} />
        <Route path="batches" element={<RoleGate roles={['GRADE_ADMIN']}><Batches /></RoleGate>} />
        <Route path="students" element={<RoleGate roles={['GRADE_ADMIN']}><Students /></RoleGate>} />
        <Route path="grades" element={<RoleGate roles={['GRADE_ADMIN']}><Grades /></RoleGate>} />
        <Route path="rules" element={<RoleGate roles={['GRADE_ADMIN']}><Rules /></RoleGate>} />
        <Route path="review-first" element={<RoleGate roles={['CLASS_LEADER', 'GRADE_ADMIN']}><FirstReview /></RoleGate>} />
        <Route path="review" element={<RoleGate roles={['GRADE_ADMIN']}><SecondReview /></RoleGate>} />
        <Route path="calc" element={<RoleGate roles={['GRADE_ADMIN']}><Calc /></RoleGate>} />
        <Route path="publish" element={<RoleGate roles={['GRADE_ADMIN']}><Publish /></RoleGate>} />
        <Route path="export" element={<RoleGate roles={['GRADE_ADMIN']}><ExportCenter /></RoleGate>} />
        <Route path="scholarship" element={<RoleGate roles={['GRADE_ADMIN']}><Scholarship /></RoleGate>} />
        <Route path="system" element={<RoleGate roles={['GRADE_ADMIN']}><System /></RoleGate>} />
      </Route>

      <Route path="/" element={<Navigate to={user ? (user.role === 'STUDENT' ? '/student/home' : '/admin') : '/login'} replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
