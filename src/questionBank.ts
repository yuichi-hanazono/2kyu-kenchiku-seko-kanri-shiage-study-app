import type {
  OfficialAnswerSource,
  PublisherReferenceSource,
  QuestionCitationRole,
  QuestionExtractionMethod,
  QuestionSource,
  QuestionSourceCitation,
  VerifiedQuestion,
} from './types';

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

function validateSource(value: unknown, path: string, requiredRoles: QuestionCitationRole[]): QuestionSource {
  if (!isRecord(value) || !isRecord(value.document)) invalid(path, '出典と資料情報が必要です。');
  const document = value.document;
  if (!isNonEmptyString(document.fileName)) invalid(`${path}.document.fileName`, '必須の文字列です。');
  if (typeof document.sha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(document.sha256)) {
    invalid(`${path}.document.sha256`, '64桁のSHA-256値が必要です。');
  }
  if (!Array.isArray(value.citations) || value.citations.length === 0) {
    invalid(`${path}.citations`, '出典ページが1件以上必要です。');
  }

  const allowedRoles: QuestionCitationRole[] = [
    'question', 'choice', 'answer', 'publisher_reference_answer', 'explanation', 'figure_or_table', 'other',
  ];
  const allowedMethods: QuestionExtractionMethod[] = ['pdfjs_text_layer', 'tesseract_js_ocr', 'manual_transcription'];
  const citations = value.citations.map((candidate, citationIndex): QuestionSourceCitation => {
    const citationPath = `${path}.citations[${citationIndex}]`;
    if (!isRecord(candidate)) invalid(citationPath, 'オブジェクトではありません。');
    if (!Number.isSafeInteger(candidate.pdfPage) || (candidate.pdfPage as number) < 1) {
      invalid(`${citationPath}.pdfPage`, '1以上のPDFページ番号が必要です。');
    }
    if (!allowedRoles.includes(candidate.role as QuestionCitationRole)) invalid(`${citationPath}.role`, '出典の役割が不正です。');
    if (typeof candidate.quote !== 'string') invalid(`${citationPath}.quote`, '文字列が必要です。');
    if (!allowedMethods.includes(candidate.extractionMethod as QuestionExtractionMethod)) {
      invalid(`${citationPath}.extractionMethod`, '抽出方法が不正です。');
    }
    if (candidate.reviewStatus !== 'verified') invalid(`${citationPath}.reviewStatus`, '確認済みの出典ページが必要です。');
    if (candidate.printedPageLabel !== undefined && candidate.printedPageLabel !== null && typeof candidate.printedPageLabel !== 'string') {
      invalid(`${citationPath}.printedPageLabel`, '文字列またはnullが必要です。');
    }

    return {
      pdfPage: candidate.pdfPage as number,
      ...(candidate.printedPageLabel !== undefined ? { printedPageLabel: candidate.printedPageLabel as string | null } : {}),
      role: candidate.role as QuestionCitationRole,
      quote: candidate.quote,
      extractionMethod: candidate.extractionMethod as QuestionExtractionMethod,
      reviewStatus: 'verified',
    };
  });

  for (const requiredRole of requiredRoles) {
    if (!citations.some((citation) => citation.role === requiredRole)) {
      invalid(`${path}.citations`, `${requiredRole}の根拠ページが必要です。`);
    }
  }

  return {
    document: { fileName: document.fileName as string, sha256: document.sha256 },
    citations,
  };
}

function validateCommonQuestion(value: Record<string, unknown>, path: string): {
  id: string;
  sourceLabel: string;
  title: string;
  category: string;
  prompt: string;
  year: number;
  examSection: '第二次検定';
  specialty: '仕上げ';
  questionNumber: string;
  contentKind: 'official_past_question';
  distribution: 'private_only';
  reviewedAt: string;
  reviewStatus: 'verified';
} {
  for (const field of ['id', 'sourceLabel', 'title', 'category', 'prompt'] as const) {
    if (!isNonEmptyString(value[field])) invalid(`${path}.${field}`, '必須の文字列です。');
  }
  if (!Number.isSafeInteger(value.year) || (value.year as number) < 1) invalid(`${path}.year`, '1以上の整数が必要です。');
  if (value.examSection !== '第二次検定') invalid(`${path}.examSection`, '第二次検定のみ取り込めます。');
  if (value.specialty !== '仕上げ') invalid(`${path}.specialty`, '仕上げのみ取り込めます。');
  if (!isNonEmptyString(value.questionNumber)) invalid(`${path}.questionNumber`, '必須の文字列です。');
  if (value.contentKind !== 'official_past_question') invalid(`${path}.contentKind`, 'official_past_question のみ取り込めます。');
  if (value.distribution !== 'private_only') invalid(`${path}.distribution`, 'private_only の問題のみ取り込めます。');
  if (!isIsoDateTime(value.reviewedAt)) invalid(`${path}.reviewedAt`, '有効なISO日時が必要です。');
  if (value.reviewStatus !== 'verified') invalid(`${path}.reviewStatus`, 'verified の問題のみ取り込めます。');

  return {
    id: value.id as string,
    sourceLabel: value.sourceLabel as string,
    title: value.title as string,
    category: value.category as string,
    prompt: value.prompt as string,
    year: value.year as number,
    examSection: '第二次検定',
    specialty: '仕上げ',
    questionNumber: value.questionNumber as string,
    contentKind: 'official_past_question',
    distribution: 'private_only',
    reviewedAt: value.reviewedAt,
    reviewStatus: 'verified',
  };
}

function validateOfficialAnswerSource(value: unknown, path: string): OfficialAnswerSource {
  if (!isRecord(value)) invalid(path, '公式正答の根拠が必要です。');
  for (const field of ['issuer', 'url', 'reference', 'checkedAt'] as const) {
    if (!isNonEmptyString(value[field])) invalid(`${path}.${field}`, '必須の文字列です。');
  }
  if (!/^https:\/\/www\.fcip-shiken\.jp\//u.test(value.url as string)) {
    invalid(`${path}.url`, '公式試験実施機関のHTTPS URLが必要です。');
  }
  if (!isIsoDateTime(value.checkedAt)) invalid(`${path}.checkedAt`, '有効なISO日時が必要です。');
  if (!Number.isSafeInteger(value.keyOption) || (value.keyOption as number) < 1 || (value.keyOption as number) > 4) {
    invalid(`${path}.keyOption`, '1から4までの公式選択肢番号が必要です。');
  }
  return {
    issuer: value.issuer as string,
    url: value.url as string,
    reference: value.reference as string,
    checkedAt: value.checkedAt as string,
    keyOption: value.keyOption as number,
  };
}

function validatePublisherReferenceSource(value: unknown, path: string): PublisherReferenceSource {
  if (!isRecord(value)) invalid(path, '出版社参考答案の根拠が必要です。');
  for (const field of ['publisher', 'reference'] as const) {
    if (!isNonEmptyString(value[field])) invalid(`${path}.${field}`, '必須の文字列です。');
  }
  return {
    publisher: value.publisher as string,
    reference: value.reference as string,
    source: validateSource(value.source, `${path}.source`, ['publisher_reference_answer']),
  };
}

function validateMultipleChoiceQuestion(value: Record<string, unknown>, index: number): VerifiedQuestion {
  const path = `questions[${index}]`;
  const common = validateCommonQuestion(value, path);
  if (value.questionType !== 'multiple_choice') invalid(`${path}.questionType`, 'questionType が不正です。');
  if ('publisher_reference_answer' in value || 'requiredKeywords' in value) {
    invalid(path, '記述式専用フィールドは multiple_choice に指定できません。');
  }
  if (!isNonEmptyString(value.answer)) invalid(`${path}.answer`, '必須の文字列です。');
  if (typeof value.explanation !== 'string') invalid(`${path}.explanation`, '文字列が必要です。');
  if (!Array.isArray(value.choices) || value.choices.length !== 4 || !value.choices.every(isNonEmptyString)) {
    invalid(`${path}.choices`, '空でない選択肢が4件必要です。');
  }
  if (!Number.isSafeInteger(value.correctChoice) || (value.correctChoice as number) < 0 || (value.correctChoice as number) >= 4) {
    invalid(`${path}.correctChoice`, '選択肢の範囲内の整数が必要です。');
  }

  let answerEvidence:
    | { answerVerification: 'official_key_verified'; officialAnswerSource: OfficialAnswerSource }
    | { answerVerification: 'publisher_reference_only'; publisherReferenceSource: PublisherReferenceSource };
  let requiredSourceRoles: QuestionCitationRole[];
  if (value.answerVerification === 'official_key_verified') {
    if ('publisherReferenceSource' in value) {
      invalid(`${path}.publisherReferenceSource`, '公式正答の問題に出版社参考答案の出典は指定できません。');
    }
    answerEvidence = {
      answerVerification: 'official_key_verified',
      officialAnswerSource: validateOfficialAnswerSource(value.officialAnswerSource, `${path}.officialAnswerSource`),
    };
    requiredSourceRoles = ['question', 'choice', 'answer'];
  } else if (value.answerVerification === 'publisher_reference_only') {
    if ('officialAnswerSource' in value) {
      invalid(`${path}.officialAnswerSource`, '出版社参考答案のみの問題に公式正答の出典は指定できません。');
    }
    answerEvidence = {
      answerVerification: 'publisher_reference_only',
      publisherReferenceSource: validatePublisherReferenceSource(
        value.publisherReferenceSource,
        `${path}.publisherReferenceSource`,
      ),
    };
    requiredSourceRoles = ['question', 'choice'];
  } else {
    invalid(`${path}.answerVerification`, 'official_key_verified または publisher_reference_only が必要です。');
  }

  return {
    ...common,
    explanation: value.explanation,
    choices: value.choices as string[],
    correctChoice: value.correctChoice as number,
    answer: value.answer as string,
    ...answerEvidence,
    distribution: 'private_only',
    questionType: 'multiple_choice',
    source: validateSource(value.source, `${path}.source`, requiredSourceRoles),
  };
}

function validateWrittenQuestion(value: Record<string, unknown>, index: number): VerifiedQuestion {
  const path = `questions[${index}]`;
  const common = validateCommonQuestion(value, path);
  if (value.questionType !== 'written') invalid(`${path}.questionType`, 'questionType が不正です。');
  for (const field of ['answer', 'choices', 'correctChoice', 'answerVerification', 'officialAnswerSource', 'publisherReferenceSource'] as const) {
    if (field in value) invalid(`${path}.${field}`, '記述式には公式正答・4択用フィールドを指定できません。');
  }
  if (value.explanation !== undefined && typeof value.explanation !== 'string') {
    invalid(`${path}.explanation`, '文字列が必要です。');
  }

  const reference = value.publisher_reference_answer;
  if (!isRecord(reference)) invalid(`${path}.publisher_reference_answer`, '出版社参考答案が必要です。');
  for (const field of ['text', 'publisher', 'reference'] as const) {
    if (!isNonEmptyString(reference[field])) {
      invalid(`${path}.publisher_reference_answer.${field}`, '必須の文字列です。');
    }
  }
  const referenceSource = validateSource(
    reference.source,
    `${path}.publisher_reference_answer.source`,
    ['publisher_reference_answer'],
  );

  let requiredKeywords: string[] | undefined;
  if (value.requiredKeywords !== undefined) {
    if (!Array.isArray(value.requiredKeywords) || value.requiredKeywords.length === 0 || !value.requiredKeywords.every(isNonEmptyString)) {
      invalid(`${path}.requiredKeywords`, '空でないキーワードが1件以上必要です。');
    }
    requiredKeywords = value.requiredKeywords as string[];
  }

  return {
    ...common,
    ...(value.explanation !== undefined ? { explanation: value.explanation } : {}),
    questionType: 'written',
    publisher_reference_answer: {
      text: reference.text as string,
      publisher: reference.publisher as string,
      reference: reference.reference as string,
      source: referenceSource,
    },
    ...(requiredKeywords ? { requiredKeywords } : {}),
    source: validateSource(value.source, `${path}.source`, ['question']),
  };
}

function validateQuestion(value: unknown, index: number): VerifiedQuestion {
  const path = `questions[${index}]`;
  if (!isRecord(value)) invalid(path, 'オブジェクトではありません。');
  if (value.questionType === 'multiple_choice') return validateMultipleChoiceQuestion(value, index);
  if (value.questionType === 'written') return validateWrittenQuestion(value, index);
  invalid(`${path}.questionType`, 'multiple_choice または written が必要です。');
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
