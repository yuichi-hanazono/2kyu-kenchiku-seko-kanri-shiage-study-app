import type { Question } from './types';

type CitationRole = 'question' | 'choice' | 'answer' | 'explanation' | 'figure_or_table' | 'other';
type ExtractionMethod = 'pdfjs_text_layer' | 'tesseract_js_ocr' | 'manual_transcription';

export type QuestionCitation = {
  pdfPage: number;
  printedPageLabel?: string | null;
  role: CitationRole;
  quote: string;
  extractionMethod: ExtractionMethod;
  reviewStatus: 'verified';
};

export type VerifiedQuestion = Question & {
  year: number;
  examSection: '第二次検定';
  specialty: '仕上げ';
  questionNumber: string;
  contentKind: 'official_past_question';
  answerVerification: 'official_key_verified';
  distribution: 'private_only';
  reviewedAt: string;
  questionType: 'multiple_choice';
  reviewStatus: 'verified';
  officialAnswerSource: {
    issuer: string;
    url: string;
    reference: string;
    checkedAt: string;
    keyOption: number;
  };
  source: {
    document: { fileName: string; sha256: string };
    citations: QuestionCitation[];
  };
};

export type QuestionBank = {
  app: 'building-management-study-app';
  schemaVersion: 1;
  questions: VerifiedQuestion[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(path: string, reason: string): never {
  throw new Error(`問題バンク ${path}: ${reason}`);
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(0, 0, 0, 0);
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
  ) return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return true;
}

function validateQuestion(value: unknown, index: number): VerifiedQuestion {
  const path = `questions[${index}]`;
  if (!isRecord(value)) invalid(path, 'オブジェクトではありません。');

  for (const field of ['id', 'sourceLabel', 'title', 'category', 'prompt', 'answer'] as const) {
    if (!isNonEmptyString(value[field])) invalid(`${path}.${field}`, '必須の文字列です。');
  }
  if (!Number.isSafeInteger(value.year) || (value.year as number) < 1) invalid(`${path}.year`, '1以上の整数が必要です。');
  if (value.examSection !== '第二次検定') invalid(`${path}.examSection`, '第二次検定のみ取り込めます。');
  if (value.specialty !== '仕上げ') invalid(`${path}.specialty`, '仕上げのみ取り込めます。');
  if (!isNonEmptyString(value.questionNumber)) invalid(`${path}.questionNumber`, '必須の文字列です。');
  if (value.contentKind !== 'official_past_question') invalid(`${path}.contentKind`, 'official_past_question のみ取り込めます。');
  if (value.answerVerification !== 'official_key_verified') invalid(`${path}.answerVerification`, 'official_key_verified の正答のみ取り込めます。');
  if (value.distribution !== 'private_only') invalid(`${path}.distribution`, 'private_only の問題のみ取り込めます。');
  if (!isIsoDateTime(value.reviewedAt)) invalid(`${path}.reviewedAt`, '有効なISO日時が必要です。');
  if (typeof value.explanation !== 'string') invalid(`${path}.explanation`, '文字列が必要です。');
  if (value.questionType !== 'multiple_choice') invalid(`${path}.questionType`, 'multiple_choice のみ取り込めます。');
  if (value.reviewStatus !== 'verified') invalid(`${path}.reviewStatus`, 'verified の問題のみ取り込めます。');
  if (!isRecord(value.officialAnswerSource)) invalid(`${path}.officialAnswerSource`, '公式正答の根拠が必要です。');
  for (const field of ['issuer', 'url', 'reference', 'checkedAt'] as const) {
    if (!isNonEmptyString(value.officialAnswerSource[field])) {
      invalid(`${path}.officialAnswerSource.${field}`, '必須の文字列です。');
    }
  }
  if (!/^https:\/\/www\.fcip-shiken\.jp\//u.test(value.officialAnswerSource.url as string)) {
    invalid(`${path}.officialAnswerSource.url`, '公式試験実施機関のHTTPS URLが必要です。');
  }
  if (!isIsoDateTime(value.officialAnswerSource.checkedAt)) {
    invalid(`${path}.officialAnswerSource.checkedAt`, '有効なISO日時が必要です。');
  }
  if (!Number.isSafeInteger(value.officialAnswerSource.keyOption) || (value.officialAnswerSource.keyOption as number) < 1 || (value.officialAnswerSource.keyOption as number) > 4) {
    invalid(`${path}.officialAnswerSource.keyOption`, '1から4までの公式選択肢番号が必要です。');
  }
  if (!Array.isArray(value.choices) || value.choices.length !== 4 || !value.choices.every(isNonEmptyString)) {
    invalid(`${path}.choices`, '空でない選択肢が4件必要です。');
  }
  if (!Number.isSafeInteger(value.correctChoice) || (value.correctChoice as number) < 0 || (value.correctChoice as number) >= 4) {
    invalid(`${path}.correctChoice`, '選択肢の範囲内の整数が必要です。');
  }

  if (!isRecord(value.source) || !isRecord(value.source.document)) {
    invalid(`${path}.source`, '出典と資料情報が必要です。');
  }
  const document = value.source.document;
  if (!isNonEmptyString(document.fileName)) invalid(`${path}.source.document.fileName`, '必須の文字列です。');
  if (typeof document.sha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(document.sha256)) {
    invalid(`${path}.source.document.sha256`, '64桁のSHA-256値が必要です。');
  }
  if (!Array.isArray(value.source.citations) || value.source.citations.length === 0) {
    invalid(`${path}.source.citations`, '出典ページが1件以上必要です。');
  }

  const allowedRoles: CitationRole[] = ['question', 'choice', 'answer', 'explanation', 'figure_or_table', 'other'];
  const allowedMethods: ExtractionMethod[] = ['pdfjs_text_layer', 'tesseract_js_ocr', 'manual_transcription'];
  const citations = value.source.citations.map((candidate, citationIndex): QuestionCitation => {
    const citationPath = `${path}.source.citations[${citationIndex}]`;
    if (!isRecord(candidate)) invalid(citationPath, 'オブジェクトではありません。');
    if (!Number.isSafeInteger(candidate.pdfPage) || (candidate.pdfPage as number) < 1) {
      invalid(`${citationPath}.pdfPage`, '1以上のPDFページ番号が必要です。');
    }
    if (!allowedRoles.includes(candidate.role as CitationRole)) invalid(`${citationPath}.role`, '出典の役割が不正です。');
    if (typeof candidate.quote !== 'string') invalid(`${citationPath}.quote`, '文字列が必要です。');
    if (!allowedMethods.includes(candidate.extractionMethod as ExtractionMethod)) {
      invalid(`${citationPath}.extractionMethod`, '抽出方法が不正です。');
    }
    if (candidate.reviewStatus !== 'verified') invalid(`${citationPath}.reviewStatus`, '確認済みの出典ページが必要です。');
    if (candidate.printedPageLabel !== undefined && candidate.printedPageLabel !== null && typeof candidate.printedPageLabel !== 'string') {
      invalid(`${citationPath}.printedPageLabel`, '文字列またはnullが必要です。');
    }

    return {
      pdfPage: candidate.pdfPage as number,
      ...(candidate.printedPageLabel !== undefined ? { printedPageLabel: candidate.printedPageLabel as string | null } : {}),
      role: candidate.role as CitationRole,
      quote: candidate.quote,
      extractionMethod: candidate.extractionMethod as ExtractionMethod,
      reviewStatus: 'verified',
    };
  });

  if (!citations.some((citation) => citation.role === 'question')) {
    invalid(`${path}.source.citations`, '問題文の根拠ページが必要です。');
  }
  for (const requiredRole of ['choice', 'answer'] as const) {
    if (!citations.some((citation) => citation.role === requiredRole)) {
      invalid(`${path}.source.citations`, `${requiredRole}の根拠ページが必要です。`);
    }
  }

  return {
    id: value.id as string,
    sourceLabel: value.sourceLabel as string,
    title: value.title as string,
    category: value.category as string,
    prompt: value.prompt as string,
    answer: value.answer as string,
    explanation: value.explanation,
    choices: value.choices as string[],
    correctChoice: value.correctChoice as number,
    year: value.year as number,
    examSection: '第二次検定',
    specialty: '仕上げ',
    questionNumber: value.questionNumber as string,
    contentKind: 'official_past_question',
    answerVerification: 'official_key_verified',
    distribution: 'private_only',
    reviewedAt: value.reviewedAt,
    questionType: 'multiple_choice',
    reviewStatus: 'verified',
    officialAnswerSource: {
      issuer: value.officialAnswerSource.issuer as string,
      url: value.officialAnswerSource.url as string,
      reference: value.officialAnswerSource.reference as string,
      checkedAt: value.officialAnswerSource.checkedAt as string,
      keyOption: value.officialAnswerSource.keyOption as number,
    },
    source: {
      document: { fileName: document.fileName as string, sha256: document.sha256 },
      citations,
    },
  };
}

export function validateQuestionBank(value: unknown): QuestionBank {
  if (!isRecord(value) || value.app !== 'building-management-study-app' || value.schemaVersion !== 1) {
    throw new Error('このアプリの問題バンク形式ではありません。');
  }
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw new Error('問題バンクに問題がありません。');
  }

  const ids = new Set<string>();
  const questions = value.questions.map((candidate, index) => {
    const question = validateQuestion(candidate, index);
    if (ids.has(question.id)) invalid(`questions[${index}].id`, 'IDが重複しています。');
    ids.add(question.id);
    return question;
  });

  return { app: 'building-management-study-app', schemaVersion: 1, questions };
}
