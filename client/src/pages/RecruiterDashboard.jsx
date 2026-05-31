import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AppBar, Toolbar, Typography, Button, Box, Paper, Grid, Tabs, Tab,
  Table, TableHead, TableRow, TableCell, TableBody, Chip, IconButton, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Stack,
  Alert, CircularProgress, Tooltip, Snackbar
} from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import AddIcon from '@mui/icons-material/Add';
import LogoutIcon from '@mui/icons-material/Logout';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LinkIcon from '@mui/icons-material/Link';
import DeleteIcon from '@mui/icons-material/Delete';
import { api } from '../utils/api';
import { useAuthStore } from '../store/authStore';
import { buildInterviewLink, copyToClipboard } from '../utils/interviewLink';

const STATUSES = ['all', 'pending', 'in_progress', 'completed', 'processing', 'done', 'failed'];

export default function RecruiterDashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tab, setTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [tplOpen, setTplOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  const [createdLink, setCreatedLink] = useState(null);
  const [toast, setToast] = useState(null); // { msg, severity }

  // Per-row copy handler. e.stopPropagation prevents the row's onClick from
  // navigating to the detail page when the recruiter clicks the copy icon.
  const handleCopyLink = async (e, token) => {
    e.stopPropagation();
    const url = buildInterviewLink(token);
    const ok = await copyToClipboard(url);
    setToast(ok
      ? { msg: 'Interview link copied to clipboard', severity: 'success' }
      : { msg: 'Could not copy — link logged to console', severity: 'warning' });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.log('[copy-link] Manual copy fallback — link:', url);
    }
  };

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [s, ss] = await Promise.all([
        api.get('/api/recruiter/stats'),
        api.get('/api/recruiter/sessions', { params: { status: tab === 'all' ? undefined : tab } })
      ]);
      setStats(s.data);
      setSessions(ss.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); /* eslint-disable-next-line */ }, [tab]);

  return (
    <Box>
      <AppBar position="sticky" elevation={0}>
        <Toolbar sx={{ justifyContent: 'space-between' }}>
          <Typography variant="h6">Intervi AI · Recruiter</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">{user?.email}</Typography>
            <IconButton onClick={() => { logout(); navigate('/recruiter/login'); }}>
              <LogoutIcon />
            </IconButton>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box sx={{ maxWidth: 1200, mx: 'auto', p: 3 }}>
        {/* stats */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <StatCard label="Total interviews" value={stats?.total ?? '—'} />
          <StatCard label="Completed" value={stats?.completed ?? '—'} />
          <StatCard label="In progress" value={stats?.inProgress ?? '—'} />
          <StatCard label="Average score" value={stats?.avgScore != null ? `${stats.avgScore}/100` : '—'} />
        </Grid>

        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setTplOpen(true)}>Create Template</Button>
          <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setInvOpen(true)}>Create Interview</Button>
        </Stack>

        <Paper>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable">
            {STATUSES.map((s) => <Tab key={s} value={s} label={s.replace('_', ' ')} />)}
          </Tabs>
          {loading ? (
            <Box sx={{ p: 6, display: 'flex', justifyContent: 'center' }}><CircularProgress /></Box>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Candidate</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Score</TableCell>
                  <TableCell>Flags</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="center">Link</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {sessions.length === 0 ? (
                  <TableRow><TableCell colSpan={8} align="center">
                    <Typography color="text.secondary" sx={{ py: 4 }}>No sessions yet.</Typography>
                  </TableCell></TableRow>
                ) : sessions.map((s) => (
                  <TableRow key={s.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/recruiter/session/${s.id}`)}>
                    <TableCell>
                      <Box>
                        <Typography>{s.candidateName}</Typography>
                        <Typography variant="caption" color="text.secondary">{s.candidateEmail}</Typography>
                      </Box>
                    </TableCell>
                    <TableCell>{s.role}</TableCell>
                    <TableCell><StatusBadge status={s.status} /></TableCell>
                    <TableCell>{s.overallScore != null ? `${s.overallScore}/100` : '—'}</TableCell>
                    <TableCell>{s.flagCount > 0 ? <Chip size="small" label={s.flagCount} color="warning" /> : '—'}</TableCell>
                    <TableCell>{new Date(s.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell align="center">
                      <Tooltip title={s.isLocked ? 'Interview already completed (link is locked)' : 'Copy interview link'}>
                        {/* span wrapper so Tooltip still works when the button is disabled */}
                        <span>
                          <IconButton
                            size="small"
                            onClick={(e) => handleCopyLink(e, s.token)}
                            disabled={!s.token}
                            aria-label="copy interview link"
                          >
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell><ArrowForwardIcon fontSize="small" /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      </Box>

      <CreateTemplateDialog open={tplOpen} onClose={() => { setTplOpen(false); fetchAll(); }} />
      <CreateInterviewDialog
        open={invOpen}
        onClose={() => { setInvOpen(false); fetchAll(); }}
        onCreated={(link) => setCreatedLink(link)}
      />

      <Dialog open={!!createdLink} onClose={() => setCreatedLink(null)}>
        <DialogTitle>Interview link created</DialogTitle>
        <DialogContent>
          <Alert severity="success" sx={{ mb: 2 }}>Share this link with the candidate.</Alert>
          <TextField fullWidth value={createdLink || ''} InputProps={{ readOnly: true }} />
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<ContentCopyIcon />}
            onClick={async () => {
              const ok = await copyToClipboard(createdLink);
              setToast(ok
                ? { msg: 'Interview link copied', severity: 'success' }
                : { msg: 'Could not copy — please copy manually', severity: 'warning' });
            }}
          >
            Copy
          </Button>
          <Button onClick={() => setCreatedLink(null)}>Done</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)} variant="filled" sx={{ width: '100%' }}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

function StatCard({ label, value }) {
  return (
    <Grid item xs={6} md={3}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography variant="h4">{value}</Typography>
      </Paper>
    </Grid>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending: 'default',
    in_progress: 'info',
    completed: 'warning',
    processing: 'warning',
    done: 'success',
    failed: 'error'
  };
  return <Chip size="small" label={status.replace('_', ' ')} color={map[status] || 'default'} />;
}

function CreateTemplateDialog({ open, onClose }) {
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('');
  const [questions, setQuestions] = useState([{ text: '', thinkingTime: 15, answerTime: 90 }]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setTitle(''); setRole(''); setQuestions([{ text: '', thinkingTime: 15, answerTime: 90 }]); setErr(null); };
  const update = (i, k, v) => {
    const next = [...questions]; next[i] = { ...next[i], [k]: v }; setQuestions(next);
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/recruiter/templates', { title, role, questions });
      reset(); onClose();
    } catch (e) { setErr(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Create interview template</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextField label="Job role" value={role} onChange={(e) => setRole(e.target.value)} />
          <Typography variant="subtitle1" sx={{ mt: 2 }}>Questions</Typography>
          {questions.map((q, i) => (
            <Paper key={i} variant="outlined" sx={{ p: 2 }}>
              <Stack spacing={1.5}>
                <TextField
                  label={`Question ${i + 1}`}
                  value={q.text}
                  onChange={(e) => update(i, 'text', e.target.value)}
                  multiline
                  minRows={2}
                />
                <Stack direction="row" spacing={1}>
                  <TextField
                    label="Thinking time (s)" type="number"
                    value={q.thinkingTime}
                    onChange={(e) => update(i, 'thinkingTime', Number(e.target.value))}
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Answer time (s)" type="number"
                    value={q.answerTime}
                    onChange={(e) => update(i, 'answerTime', Number(e.target.value))}
                    sx={{ flex: 1 }}
                  />
                  <IconButton color="error" onClick={() => setQuestions(questions.filter((_, j) => j !== i))} disabled={questions.length === 1}>
                    <DeleteIcon />
                  </IconButton>
                </Stack>
              </Stack>
            </Paper>
          ))}
          <Button startIcon={<AddIcon />} onClick={() => setQuestions([...questions, { text: '', thinkingTime: 15, answerTime: 90 }])}>
            Add question
          </Button>
          {err && <Alert severity="error">{err}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !title || !role || questions.some((q) => !q.text)}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CreateInterviewDialog({ open, onClose, onCreated }) {
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [candidateEmail, setCandidateEmail] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get('/api/recruiter/templates').then((r) => setTemplates(r.data));
  }, [open]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const { data } = await api.post('/api/recruiter/sessions', {
        templateId, candidateName, candidateEmail, expiresInDays
      });
      onCreated?.(data.link);
      onClose();
    } catch (e) { setErr(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create interview</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label="Template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.length === 0
              ? <MenuItem disabled value="">Create a template first</MenuItem>
              : templates.map((t) => <MenuItem key={t._id} value={t._id}>{t.title} — {t.role}</MenuItem>)
            }
          </TextField>
          <TextField label="Candidate name" value={candidateName} onChange={(e) => setCandidateName(e.target.value)} />
          <TextField label="Candidate email" type="email" value={candidateEmail} onChange={(e) => setCandidateEmail(e.target.value)} />
          <TextField label="Expires in (days)" type="number" value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))} />
          {err && <Alert severity="error">{err}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !templateId || !candidateName || !candidateEmail}>
          Create link
        </Button>
      </DialogActions>
    </Dialog>
  );
}
