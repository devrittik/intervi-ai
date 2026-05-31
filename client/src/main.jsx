import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline } from '@mui/material';

import '@fontsource/sora/400.css';
import '@fontsource/sora/500.css';
import '@fontsource/sora/600.css';
import '@fontsource/sora/700.css';

import './index.css';
import theme from './theme';

import HardwareCheck from './pages/HardwareCheck';
import InterviewPage from './pages/InterviewPage';
import InterviewComplete from './pages/InterviewComplete';
import InterviewLocked from './pages/InterviewLocked';
import RecruiterLogin from './pages/RecruiterLogin';
import RecruiterDashboard from './pages/RecruiterDashboard';
import SessionDetail from './pages/SessionDetail';
import ProtectedRoute from './components/shared/ProtectedRoute';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/recruiter/login" replace />} />

          {/* Candidate flow */}
          <Route path="/interview/:token" element={<HardwareCheck />} />
          <Route path="/interview/:token/run" element={<InterviewPage />} />
          <Route path="/interview/:token/done" element={<InterviewComplete />} />
          <Route path="/interview/:token/locked" element={<InterviewLocked />} />

          {/* Recruiter flow */}
          <Route path="/recruiter/login" element={<RecruiterLogin />} />
          <Route
            path="/recruiter"
            element={
              <ProtectedRoute>
                <RecruiterDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/recruiter/session/:id"
            element={
              <ProtectedRoute>
                <SessionDetail />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<Navigate to="/recruiter/login" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
