import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth, JwtUser } from './store/auth';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import StudentLayout from './layouts/StudentLayout';
import AdminLayout from './layouts/AdminLayout';
import StudentHome from './pages/student/Home';
import Apply from './pages/student/Apply';
import MyApplications from './pages/student/Applications';
import MyScore from './pages/student/Score';
import FirstReview from './pages/leader/FirstReview';
import Dashboard from './pages/admin/Dashboard';
import Batches from './pages/admin/Batches';
import Students from './pages/admin/Students';
import Grades from './pages/admin/Grades';
import Rules from './pages/admin/Rules';
import SecondReview from './pages/admin/SecondReview';
import Calc from './pages/admin/Calc';
import Publish from './pages/admin/Publish';
import ExportCenter from './pages/admin/Export';
import System from './pages/admin/System';

const FULL_SCREEN = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' };

/** 未登录只放行 /login；mustChangePwd 全局强制改密 */
function Gate({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <div style={FULL_SCREEN}><Spin size="large" tip="正在恢复会话…"></Spin></div>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (user.mustChangePwd && loc.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** 角色门禁：STUDENT 进学生端，其余进管理端 */
function RoleGate({ roles, children }: { roles: JwtUser['role'][]; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  const pass = user.role === 'SUPER_ADMIN' || roles.includes(user.role);
  if (!pass) return <Navigate to={user.role === 'STUDENT' ? '/student/home' : '/admin/dashboard'} replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, ready } = useAuth();
  if (ready && !user) {
    // 未登录：只挂载登录/改密
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<ChangePassword />} />

      {/* —— 学生端（移动优先） —— */}
      <Route path="/student" element={<Gate><RoleGate roles={['STUDENT']}><StudentLayout /></RoleGate></Gate>}>
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
        <Route path="system" element={<RoleGate roles={['GRADE_ADMIN']}><System /></RoleGate>} />
      </Route>

      <Route path="/" element={<Navigate to={user ? (user.role === 'STUDENT' ? '/student/home' : '/admin') : '/login'} replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
