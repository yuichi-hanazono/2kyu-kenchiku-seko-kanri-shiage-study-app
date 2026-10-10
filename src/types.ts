export type Rating = 'good' | 'unsure' | 'weak';
export type QuizResult = 'correct' | 'incorrect';

export type QuestionSourceCitation = {
  pdfPage: number;
  printedPageLabel?: string | null;
  role: string;
};

export type QuestionSource = {
  document: { fileName: string; sha256: string };
  citations: QuestionSourceCitation[];
};

export type Question = {
  id: string;
  sourceLabel: string;
  title: string;
  category: string;
  prompt: string;
  answer: string;
  explanation: string;
  choices: string[];
  correctChoice: number;
  year?: number;
  examSection?: string;
  specialty?: string;
  questionNumber?: string;
  reviewStatus?: string;
  source?: QuestionSource;
};

export type QuestionProgress = {
  firstStudyCount: number;
  firstStudyCompletedAt: string | null;
  memoryTestCount: number;
  quizTestCount: number;
  writtenTestCount: number;
  quizCorrectCount: number;
  quizIncorrectCount: number;
  quizCorrectStreak: number;
  lastQuizResult: QuizResult | null;
  nextReviewOn: string | null;
  lastStudiedOn: string | null;
  rating: Rating | null;
  isDifficult: boolean;
  legacyAttempts: number;
};

export type StudyState = {
  schemaVersion: 2;
  records: Record<string, QuestionProgress>;
};

export const EMPTY_PROGRESS: QuestionProgress = {
  firstStudyCount: 0,
  firstStudyCompletedAt: null,
  memoryTestCount: 0,
  quizTestCount: 0,
  writtenTestCount: 0,
  quizCorrectCount: 0,
  quizIncorrectCount: 0,
  quizCorrectStreak: 0,
  lastQuizResult: null,
  nextReviewOn: null,
  lastStudiedOn: null,
  rating: null,
  isDifficult: false,
  legacyAttempts: 0,
};

export const EMPTY_STATE: StudyState = {
  schemaVersion: 2,
  records: {},
};
