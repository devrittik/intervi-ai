/**
 * Mongoose models.
 * - User (recruiter)
 * - InterviewTemplate
 * - InterviewSession (the “central brain” — holds chunks/answers/transcripts/status)
 * - ProctoringEvent (append-only)
 */
const mongoose = require('mongoose');
const { Schema, model } = mongoose;

/* ---------------- User ---------------- */
const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    password: { type: String, required: true }, // bcrypt hash
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ['recruiter'], default: 'recruiter' }
  },
  { timestamps: true }
);

/* ---------------- InterviewTemplate ---------------- */
const QuestionSchema = new Schema(
  {
    index: { type: Number, required: true },
    text: { type: String, required: true },
    thinkingTime: { type: Number, default: 15 }, // seconds before answer phase
    answerTime: { type: Number, default: 90 }    // max seconds to answer
  },
  { _id: false }
);

const InterviewTemplateSchema = new Schema(
  {
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true }, // job title
    questions: { type: [QuestionSchema], default: [] }
  },
  { timestamps: true }
);

/* ---------------- InterviewSession ---------------- */
const UploadedChunkSchema = new Schema(
  {
    questionIndex: { type: Number, required: true },
    chunkIndex: { type: Number, required: true },
    s3Key: { type: String, required: true },
    size: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const AnswerSchema = new Schema(
  {
    questionIndex: { type: Number, required: true },
    mergedVideoKey: { type: String, default: null }, // S3 key for the merged .webm
    transcript: { type: String, default: '' },       // from Deepgram Voice Agent (live)
    aiScore: { type: Number, default: null },        // 0-100
    aiFeedback: { type: String, default: '' },       // 2 sentences from Groq
    spokenReview: { type: String, default: '' }      // text we asked Voice Agent to speak
  },
  { _id: false }
);

const InterviewSessionSchema = new Schema(
  {
    templateId: { type: Schema.Types.ObjectId, ref: 'InterviewTemplate', required: true, index: true },
    token: { type: String, required: true, unique: true, index: true }, // UUID for the candidate link
    candidateName: { type: String, required: true, trim: true },
    candidateEmail: { type: String, required: true, trim: true, lowercase: true },

    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'processing', 'done', 'failed'],
      default: 'pending',
      index: true
    },

    currentQuestionIndex: { type: Number, default: 0 },
    answeredQuestions: { type: [Number], default: [] },

    uploadedChunks: { type: [UploadedChunkSchema], default: [] },
    answers: { type: [AnswerSchema], default: [] },

    overallScore: { type: Number, default: null },
    overallFeedback: { type: String, default: '' },
    // [polish-summary] Up to 3 each. Default [] keeps legacy docs valid.
    overallStrengths: { type: [String], default: [] },
    overallWeaknesses: { type: [String], default: [] },

    expiresAt: { type: Date, default: null, index: true },
    completedAt: { type: Date, default: null },

    // Hard lock — once true, /interview/:token always shows the “already completed” page.
    isLocked: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

/* ---------------- ProctoringEvent ---------------- */
const ProctoringEventSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true, index: true },
    type: {
      type: String,
      enum: [
        'TAB_SWITCH',
        'WINDOW_BLUR',
        'FACE_ABSENT',
        'MULTIPLE_FACES',
        'FULLSCREEN_EXIT',
        'COPY_PASTE',
        'CAMERA_DISCONNECT',
        'MIC_DISCONNECT',
        'RECONNECT'
      ],
      required: true
    },
    questionIndex: { type: Number, default: null },
    timestamp: { type: Date, default: Date.now, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

const User = mongoose.models.User || model('User', UserSchema);
const InterviewTemplate =
  mongoose.models.InterviewTemplate || model('InterviewTemplate', InterviewTemplateSchema);
const InterviewSession =
  mongoose.models.InterviewSession || model('InterviewSession', InterviewSessionSchema);
const ProctoringEvent =
  mongoose.models.ProctoringEvent || model('ProctoringEvent', ProctoringEventSchema);

module.exports = { User, InterviewTemplate, InterviewSession, ProctoringEvent };
