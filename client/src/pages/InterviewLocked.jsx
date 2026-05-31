import { Box, Paper, Typography, Stack } from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';

export default function InterviewLocked() {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: 6, maxWidth: 520, textAlign: 'center' }}>
        <Stack spacing={3} alignItems="center">
          <LockIcon sx={{ fontSize: 64, color: 'warning.main' }} />
          <Typography variant="h4">This interview is closed</Typography>
          <Typography variant="body1" color="text.secondary">
            This interview link has already been completed or is no longer available. If you believe this is a mistake, please contact your recruiter.
          </Typography>
        </Stack>
      </Paper>
    </Box>
  );
}
