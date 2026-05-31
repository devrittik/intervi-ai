import { useEffect, useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, AppBar, Toolbar, IconButton, Typography, Stack, Paper, Grid, Chip,
  Divider, Skeleton, Alert, Button, List, ListItem, ListItemText,
  TextField, Tooltip, Snackbar
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LinkIcon from '@mui/icons-material/Link';
import { api } from '../utils/api';
import { buildInterviewLink, copyToClipboard } from '../utils/interviewLink';

export default function SessionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null); // { msg, severity }
  const pollRef = useRef(null);

  const handleCopyLink = async () => {
    const url = buildInterviewLink(data?.token);
    if (!url) return;
    const ok = await copyToClipboard(url);
    setToast(ok
      ? { msg: 'Interview link copied to clipboard', severity: 'success' }
      : { msg: 'Could not copy — please select & copy manually', severity: 'warning' });
  };

  const load = async () => {
    try {
      const { data } = await api.get(`/api/recruiter/sessions/${id}`);
      setData(data);
      // Poll while still processing.
      if (data.status === 'processing' || data.status === 'in_progress' || data.status === 'completed') {
        if (!pollRef.current) {
          pollRef.current = setInterval(load, 5000);
        }
      } else {
        clearInterval(pollRef.current); pollRef.current = null;
      }
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  useEffect(() => {
    load();
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line
  }, [id]);

  if (err) return (
    <Box sx={{ p: 4 }}><Alert severity="error">{err}</Alert></Box>
  );
  if (!data) return (
    <Box sx={{ p: 4 }}><Skeleton variant="rectangular" height={400} /></Box>
  );

  return (
    <Box>
      <AppBar position="sticky" elevation={0}>
        <Toolbar>
          <IconButton onClick={() => navigate('/recruiter')}><ArrowBackIcon /></IconButton>
          <Box sx={{ flex: 1, ml: 1 }}>
            <Typography variant="h6">{data.candidateName}</Typography>
            <Typography variant="caption" color="text.secondary">{data.candidateEmail}</Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <StatusBadge status={data.status} />
            <IconButton onClick={load}><RefreshIcon /></IconButton>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box sx={{ maxWidth: 1280, mx: 'auto', p: 3 }}>
        <Grid container spacing={3}>
          <Grid item xs={12} md={8}>
            <Stack spacing={2}>
              {data.template.questions.map((q) => {
                const ans = data.answers.find((a) => a.questionIndex === q.index);
                return <QuestionCard key={q.index} q={q} ans={ans} status={data.status} />;
              })}
            </Stack>
          </Grid>

          <Grid item xs={12} md={4}>
            <Stack spacing={2}>
              <Paper sx={{ p: 3 }}>
                <Typography variant="overline" color="text.secondary">Overall score</Typography>
                <ScoreRing score={data.overallScore} />
                {data.overallFeedback && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    {data.overallFeedback}
                  </Typography>
                )}

                {/* [polish-summary] Strengths / weaknesses lists. Each shows
                    up to 3 short bullets. Either list may be empty — we just
                    hide the section in that case. */}
                {data.overallStrengths?.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="caption" sx={{ color: 'success.main', fontWeight: 600 }}>
                      STRENGTHS
                    </Typography>
                    <Box component="ul" sx={{ pl: 2.5, my: 0.5 }}>
                      {data.overallStrengths.map((s, i) => (
                        <li key={i}>
                          <Typography variant="body2" sx={{ lineHeight: 1.4 }}>{s}</Typography>
                        </li>
                      ))}
                    </Box>
                  </Box>
                )}

                {data.overallWeaknesses?.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 600 }}>
                      AREAS TO IMPROVE
                    </Typography>
                    <Box component="ul" sx={{ pl: 2.5, my: 0.5 }}>
                      {data.overallWeaknesses.map((s, i) => (
                        <li key={i}>
                          <Typography variant="body2" sx={{ lineHeight: 1.4 }}>{s}</Typography>
                        </li>
                      ))}
                    </Box>
                  </Box>
                )}
              </Paper>

              <Paper sx={{ p: 3 }}>
                <Typography variant="overline" color="text.secondary">Candidate</Typography>
                <Stack spacing={0.5} sx={{ mt: 1 }}>
                  <Typography variant="body2">{data.candidateName}</Typography>
                  <Typography variant="caption" color="text.secondary">{data.candidateEmail}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Role: {data.template.role}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Started: {new Date(data.createdAt).toLocaleString()}
                  </Typography>
                  {data.completedAt && (
                    <Typography variant="caption" color="text.secondary">
                      Completed: {new Date(data.completedAt).toLocaleString()}
                    </Typography>
                  )}
                </Stack>
              </Paper>

              <Paper sx={{ p: 3 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <LinkIcon fontSize="small" sx={{ opacity: 0.6 }} />
                  <Typography variant="overline" color="text.secondary">Interview link</Typography>
                </Stack>
                <TextField
                  fullWidth
                  size="small"
                  value={buildInterviewLink(data.token)}
                  InputProps={{ readOnly: true }}
                  onFocus={(e) => e.target.select()}
                  sx={{ mb: 1.5 }}
                />
                <Stack direction="row" spacing={1}>
                  <Tooltip title="Copy candidate interview URL">
                    <Button
                      variant="contained"
                      size="small"
                      startIcon={<ContentCopyIcon />}
                      onClick={handleCopyLink}
                      fullWidth
                    >
                      Copy link
                    </Button>
                  </Tooltip>
                </Stack>
                {data.isLocked && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                    This interview has been completed — the link will show a "closed" page if reopened.
                  </Typography>
                )}
              </Paper>

              <Paper sx={{ p: 3 }}>
                <Typography variant="overline" color="text.secondary">
                  Proctoring flags ({data.proctoring.length})
                </Typography>
                {data.proctoring.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    No suspicious activity detected.
                  </Typography>
                ) : (
                  <List dense>
                    {data.proctoring.map((p) => (
                      <ListItem key={p._id} disablePadding sx={{ py: 0.5 }}>
                        <ListItemText
                          primary={<Chip label={p.type} size="small" color="warning" />}
                          secondary={
                            <>
                              {new Date(p.timestamp).toLocaleTimeString()} ·
                              {p.questionIndex != null ? ` Q${p.questionIndex + 1}` : ' (no question)'}
                            </>
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                )}
              </Paper>
            </Stack>
          </Grid>
        </Grid>
      </Box>

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

function QuestionCard({ q, ans, status }) {
  const showSkeleton = (status === 'processing' || status === 'in_progress' || status === 'completed') && !ans?.mergedVideoKey;
  return (
    <Paper sx={{ p: 3 }}>
      <Typography variant="overline" color="text.secondary">Question {q.index + 1}</Typography>
      <Typography variant="h6" sx={{ mb: 2 }}>{q.text}</Typography>

      {ans?.videoUrl ? (
        <video src={ans.videoUrl} controls style={{ width: '100%', borderRadius: 8, background: '#000' }} />
      ) : showSkeleton ? (
        <Skeleton variant="rectangular" height={240} />
      ) : (
        <Alert severity="info">No video recorded.</Alert>
      )}

      <Divider sx={{ my: 2 }} />

      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <Typography variant="overline" color="text.secondary">Transcript</Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {ans?.transcript || (showSkeleton ? <Skeleton width="80%" /> : '—')}
          </Typography>
        </Grid>
        <Grid item xs={12} md={4}>
          <Typography variant="overline" color="text.secondary">AI score</Typography>
          <Typography variant="h4">{ans?.aiScore != null ? `${ans.aiScore}/100` : '—'}</Typography>
          {ans?.aiFeedback && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {ans.aiFeedback}
            </Typography>
          )}
        </Grid>
      </Grid>
    </Paper>
  );
}

function ScoreRing({ score }) {
  const value = typeof score === 'number' ? score : 0;
  const size = 140, stroke = 10, r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - value / 100);
  const color = value >= 75 ? '#10b981' : value >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <Box sx={{ position: 'relative', width: size, height: size, mx: 'auto', mt: 1 }}>
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size/2} cy={size/2} r={r}
          stroke={typeof score === 'number' ? color : 'rgba(255,255,255,0.2)'}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={typeof score === 'number' ? offset : c}
          strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <Box sx={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column'
      }}>
        <Typography variant="h4">{typeof score === 'number' ? score : '—'}</Typography>
        <Typography variant="caption" color="text.secondary">/ 100</Typography>
      </Box>
    </Box>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending: 'default', in_progress: 'info', completed: 'warning',
    processing: 'warning', done: 'success', failed: 'error'
  };
  return <Chip size="small" label={status.replace('_', ' ')} color={map[status] || 'default'} />;
}
