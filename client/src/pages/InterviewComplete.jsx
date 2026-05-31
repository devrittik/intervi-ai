import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Paper, Typography, Stack } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useMediaStore } from '../store/mediaStore';

export default function InterviewComplete() {
  const { token } = useParams();
  const candidateName = useMediaStore((s) => s.candidateName);
  const teardown = useMediaStore((s) => s.teardown);

  // Belt-and-braces — InterviewPage already torn down, but if a user lands here
  // directly with a lingering stream, kill it now so the camera light goes off.
  useEffect(() => { teardown(); }, [teardown]);

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: 6, maxWidth: 560, textAlign: 'center' }}>
        <Stack spacing={3} alignItems="center">
          <CheckCircleIcon sx={{ fontSize: 72, color: 'success.main' }} />
          <Typography variant="h4">
            {candidateName ? `Thank you, ${candidateName}!` : 'Thank you!'}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Your interview has been recorded and submitted. The recruiter will review your responses and reach out shortly.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Session reference: {token.slice(0, 8)}…
          </Typography>
        </Stack>
      </Paper>
    </Box>
  );
}
