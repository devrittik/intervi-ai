import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';

export default function ProtectedRoute({ children }) {
  const token = useAuthStore((s) => s.token);
  const loc = useLocation();
  if (!token) return <Navigate to="/recruiter/login" replace state={{ from: loc }} />;
  return children;
}
