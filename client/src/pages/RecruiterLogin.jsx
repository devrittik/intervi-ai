import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Paper, Tabs, Tab, TextField, Button, Typography, Alert, Stack
} from '@mui/material';
import { api } from '../utils/api';
import { useAuthStore } from '../store/authStore';

export default function RecruiterLogin() {
  const [tab, setTab] = useState(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const path = tab === 0 ? '/api/auth/login' : '/api/auth/register';
      const body = tab === 0 ? { email, password } : { email, password, name };
      const { data } = await api.post(path, body);
      setAuth(data.token, data.user);
      navigate('/recruiter', { replace: true });
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: 4, width: '100%', maxWidth: 420 }}>
        <Typography variant="h4" sx={{ mb: 1 }}>Recruiter portal</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Sign in to create templates and review interviews.
        </Typography>

        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="Sign in" />
          <Tab label="Create account" />
        </Tabs>

        <form onSubmit={submit}>
          <Stack spacing={2}>
            {tab === 1 && (
              <TextField label="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
            )}
            <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {err && <Alert severity="error">{err}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={busy}>
              {tab === 0 ? 'Sign in' : 'Create account'}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Box>
  );
}
