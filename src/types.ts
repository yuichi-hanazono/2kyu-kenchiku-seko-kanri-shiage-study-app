export type Rating = 'good' | 'unsure' | 'weak';
export type QuizResult = 'correct' | 'incorrect';

export type QuestionCitationRole =
  | 'question'
  | 'choice'
  | 'answer'
  | 'publisher_reference_answer'
  | 'explanation'
  | 'figure_or_table'
  | 'other';

export type QuestionExtractionMethod = 'pdfjs_text_layer' | 'tesseract_js_ocr' | 'manual_transcription';

export type QuestionSourceCitation = {
  pdfPage: number;
  printedPageLabel?: string | null;
  role: QuestionCitationRole;
  quote: string;
  extractionMethod: QuestionExtractionMethod;
  reviewStatus: 'verified';
};

export type QuestionSource = {
  document: { fileName: string; sha256: string };
  citations: QuestionSourceCitation[];
};

export type OfficialAnswerSource = {
  issuer: string;
  url: string;
  reference: string;
  checkedAt: string;
  keyOption: number;
};

export type PublisherReferenceAnswer = {
  text: string;
  publisher: string;
  reference: string;
  source: QuestionSource;
};

export type QuestionBase = {
  id: string;
  sourceLabel: string;
  title: string;
  category: string;
  prompt: string;
  explanation?: string;
  year?: number;
  examSection?: string;
  specialty?: string;
  questionNumber?: string;
  contentKind?: string;
  distribution?: 'private_only';
  reviewedAt?: string;
  reviewStatus?: string;
  source?: QuestionSource;
};

/** questionType is optional only for the app's existing display-only sample cards. */
export type MultipleChoiceQuestion = QuestionBase & {
  questionType?: 'multiple_choice';
  answer: string;
  explanation: string;
  choices: string[];
  correctChoice: number;
  answerVerification?: 'official_key_verified';
  officialAnswerSource?: OfficialAnswerSource;
};

export type WrittenQuestion = QuestionBase & {
  questionType: 'written';
  publisher_reference_answer: PublisherReferenceAnswer;
  requiredKeywords?: string[];
  answer?: never;
  choices?: never;
  correctChoice?: never;
  answerVerification?: never;
  officialAnswerSource?: never;
};

export type Question = MultipleChoiceQuestion | WrittenQuestion;

export type VerifiedQuestionBase = QuestionBase & {
  year: number;
  examSection: '第二次検定';
  specialty: '仕上げ';
  questionNumber: string;
  contentKind: 'official_past_question';
  distribution: 'private_only';
  reviewedAt: string;
  reviewStatus: 'verified';
  source: QuestionSource;
};

export type VerifiedMultipleChoiceQuestion = MultipleChoiceQuestion & VerifiedQuestionBase & {
  questionType: 'multiple_choice';
  answerVerification: 'official_key_verified';
  officialAnswerSource: OfficialAnswerSource;
};

export type VerifiedWrittenQuestion = WrittenQuestion & VerifiedQuestionBase;

export type VerifiedQuestion = VerifiedMultipleChoiceQuestion | VerifiedWrittenQuestion;

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
