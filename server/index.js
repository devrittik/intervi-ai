/**
 * Server entrypoint.
 * - HTTP (Express) for REST.
 * - Socket.IO for proctoring events + recruiter live updates.
 * - Native ws upgrade handler for Deepgram Voice Agent proxy.
 *
 * Run a worker separately:  npm run worker
 */
require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server: SocketServer } = require('socket.io');

const logger = require('./utils/logger');
const requestId = require('./middleware/requestId');
const httpLogger = require('./middleware/logger');
const { connectDB } = require('./config/db');
const { attachVoiceAgentProxy } = require('./routes/voiceAgent');
const { ProctoringEvent, InterviewSession } = require('./models');

const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const chunkRoutes = require('./routes/chunks');
const recruiterRoutes = require('./routes/recruiter');

const PORT = Number(process.env.PORT) || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

async function main() {
  await connectDB();

  const app = express();
  app.set('trust proxy', 1);

  app.use(
    cors({
      origin: CLIENT_URL,
      credentials: true,
      exposedHeaders: ['x-request-id']
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);
  app.use(httpLogger);

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/chunks', chunkRoutes);
  app.use('/api/recruiter', recruiterRoutes);

  // Global error handler — never leak stack traces in production.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logger.error('unhandled_error', {
      requestId: req.requestId,
      err: err.message,
      stack: err.stack
    });
    res.status(err.status || 500).json({
      error: err.code || 'server_error',
      message: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  });

  const httpServer = http.createServer(app);

  /* ---------- Socket.IO ---------- */
  const io = new SocketServer(httpServer, {
    cors: { origin: CLIENT_URL, credentials: true },
    pingInterval: 25_000,
    pingTimeout: 20_000
  });

  io.on('connection', (socket) => {
    logger.info('socket_connected', { sid: socket.id });

    socket.on('join_session', async ({ token } = {}) => {
      if (!token) return;
      const session = await InterviewSession.findOne({ token }).select('_id isLocked');
      if (!session) return socket.emit('error_event', { error: 'session_not_found' });
      socket.data.sessionId = session._id.toString();
      socket.join(`session_${session._id}`);
      logger.info('socket_join_session', { sid: socket.id, sessionId: session._id.toString() });
    });

    socket.on('join_recruiter', ({ sessionId } = {}) => {
      if (!sessionId) return;
      socket.join(`recruiter_${sessionId}`);
      logger.info('socket_join_recruiter', { sid: socket.id, sessionId });
    });

    socket.on('proctoring_event', async (payload = {}) => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) return;
      const { type, questionIndex, metadata } = payload;
      if (!type) return;

      try {
        const evt = await ProctoringEvent.create({
          sessionId,
          type,
          questionIndex: typeof questionIndex === 'number' ? questionIndex : null,
          metadata: metadata || {}
        });
        logger.info('proctoring_event', { sessionId, type, questionIndex });

        // Forward to recruiter listeners for live dashboard.
        io.to(`recruiter_${sessionId}`).emit('proctoring_event', {
          id: evt._id,
          sessionId,
          type: evt.type,
          questionIndex: evt.questionIndex,
          timestamp: evt.timestamp,
          metadata: evt.metadata
        });
      } catch (err) {
        logger.error('proctoring_event_save_failed', { sessionId, err: err.message });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.info('socket_disconnect', { sid: socket.id, reason });
    });
  });

  // Expose io to routes if we ever need to push (e.g. worker → REST → io).
  app.set('io', io);

  /* ---------- Deepgram Voice Agent WS proxy ---------- */
  attachVoiceAgentProxy(httpServer);

  httpServer.listen(PORT, () => {
    logger.info('server_listening', { port: PORT, clientUrl: CLIENT_URL });
  });

  process.on('unhandledRejection', (err) => {
    logger.error('unhandled_rejection', { err: err?.message, stack: err?.stack });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { err: err?.message, stack: err?.stack });
  });
}

main().catch((err) => {
  logger.error('fatal_boot_error', { err: err.message, stack: err.stack });
  process.exit(1);
});
