import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import sampleQuestions from '../data/sample/questions.json';
import {
  acknowledgeStudyEvents,
  appendStudyEventAndState,
  getOrCreateDeviceId,
  loadLocalSyncMetadata,
  loadLocalSyncSnapshot,
  loadQuestionBank,
  loadStudyEventOutbox,
  loadStudyState,
  makeBackup,
  makeDeviceBackup,
  progressFor,
  readBackup,
  replaceLocalCloudData,
  restoreLocalStudyData,
  saveLocalSyncMetadata,
  saveMigratedLocalLink,
  saveQuestionBank,
  saveStudyState,
  validateLocalSyncMetadata,
  type LocalSyncMetadata,
} from './storage';
import { validateQuestionBank, type QuestionBank } from './questionBank';
import { firebaseAuth, firebaseConfigured, firebaseMissingConfig } from './firebase';
import { checkCloudManifest, downloadCloudBundle, hashQuestionBank, migrateLocalDataToCloud, syncLinkedDevice } from './cloudSync';
import {
  applyStudyEvent,
  applyStudyEvents,
  createStudyEvent,
  decideCloudImport,
  decideLocalMigration,
  deduplicateStudyEvents,
  localDataSignature,
  validateStudyEvent,
  type NewStudyEvent,
  type StudyEvent,
} from './syncDomain';
import {
  EMPTY_PROGRESS,
  EMPTY_STATE,
  type MultipleChoiceQuestion,
  type Question,
  type QuestionProgress,
  type QuestionSource,
  type PublisherReferenceSource,
  type Rating,
  type StudyState,
  type WrittenQuestion,
} from './types';

type Page = 'home' | 'today' | 'first' | 'memory' | 'quiz' | 'written' | 'difficult';
type LearningPage = 'first' | 'memory' | 'quiz' | 'written';

const sampleQuestionList = sampleQuestions as Question[];

const navigation: { id: Page; label: string; symbol: string; group?: string }[] = [
  { id: 'home', label: 'ホーム', symbol: '⌂' },
  { id: 'today', label: '今日の学習', symbol: '▦', group: '学習メニュー' },
  { id: 'first', label: '初回学習', symbol: '▤' },
  { id: 'memory', label: '暗記確認', symbol: '◇' },
  { id: 'quiz', label: '4択演習', symbol: '☷' },
  { id: 'written', label: '記述式暗記', symbol: '✎' },
  { id: 'difficult', label: '苦手問題', symbol: '☆' },
];

const pageTitles: Record<Page, { title: string; subtitle: string }> = {
  home: { title: 'ホーム', subtitle: '今日の学習状況を確認しましょう。' },
  today: { title: '今日の学習', subtitle: '今日取り組む問題をまとめています。' },
  first: { title: '初回学習', subtitle: '解答と解説を読み、まずは全体像をつかみましょう。' },
  memory: { title: '暗記確認', subtitle: '思い出せるか確認して、手応えを記録しましょう。' },
  quiz: { title: '4択演習', subtitle: '選択肢を選ぶと、その場で結果を確認できます。' },
  written: { title: '記述式暗記', subtitle: '自分の言葉で書き、解答例と見比べましょう。' },
  difficult: { title: '苦手問題', subtitle: 'あとでもう一度確認したい問題を集めています。' },
};

const ratingOptions: { value: Rating; label: string; symbol: string; tone: string }[] = [
  { value: 'good', label: '覚えた', symbol: '○', tone: 'good' },
  { value: 'unsure', label: 'あやしい', symbol: '△', tone: 'unsure' },
  { value: 'weak', label: '忘れた', symbol: '×', tone: 'weak' },
];

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDate(date = new Date()): string {
  return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' }).format(date);
}

function nextReviewDate(rating: Rating): string {
  const date = new Date();
  date.setDate(date.getDate() + (rating === 'good' ? 7 : rating === 'unsure' ? 3 : 1));
  return localDateKey(date);
}

function totalStudyCount(progress: QuestionProgress): number {
  return progress.firstStudyCount + progress.memoryTestCount + progress.quizTestCount + progress.writtenTestCount + progress.legacyAttempts;
}

function isWrittenQuestion(question: Question): question is WrittenQuestion {
  return question.questionType === 'written';
}

function isMultipleChoiceQuestion(question: Question): question is MultipleChoiceQuestion {
  return !isWrittenQuestion(question);
}

function isLearningPage(page: Page): page is LearningPage {
  return page === 'first' || page === 'memory' || page === 'quiz' || page === 'written';
}

function questionNumberValue(question: Question): string | null {
  const rawValue = question.questionNumber?.normalize('NFKC').trim();
  if (!rawValue) return null;

  const value = rawValue
    .replace(/^(?:問題|問|第)\s*/u, '')
    .replace(/\s*(?:問題|問)$/u, '')
    .replace(/\s+/gu, '')
    .toUpperCase();
  return value || null;
}

function sourcePageText(source: QuestionSource): string {
  const pages = [...new Set(source.citations.map((citation) => citation.pdfPage))].sort((a, b) => a - b);
  return pages.length ? `PDF p.${pages.join(', ')}` : 'PDFページ未設定';
}

function questionSourceText(question: Question): string | null {
  if (!question.source) return null;
  const yearText = question.year ? `${question.year}年度` : '';
  const numberText = question.questionNumber ? `問${question.questionNumber}` : '';
  return `出典：${[yearText, numberText, sourcePageText(question.source)].filter(Boolean).join(' / ')}（非公開・確認済み）`;
}

function publisherReferenceSourceText(question: WrittenQuestion): string {
  const answer = question.publisher_reference_answer;
  return `出典：${answer.publisher} / ${answer.reference} / ${answer.source.document.fileName} / ${sourcePageText(answer.source)}`;
}

function formatWrittenReferenceAnswer(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]*(【設問[^】]+】)[ \t]*/gu, '\n$1\n')
    .replace(/[ \t]*(【選択肢[^】]*】)[ \t]*/gu, '$1\n')
    .replace(/[ \t]*(①\s*工程名又は作業名：)/gu, '\n$1')
    .replace(/[ \t]*(②\s*主な要因と作業内容：)/gu, '\n$1')
    .replace(/[ \t]*(③\s*対応策：)/gu, '\n$1')
    .replace(/[ \t]*／[ \t]*/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{2,}/gu, '\n')
    .trim();
}

function publisherMultipleChoiceSourceText(source: PublisherReferenceSource): string {
  return `出典：${source.publisher} / ${source.reference} / ${source.source.document.fileName} / ${sourcePageText(source.source)}`;
}

function multipleChoiceAnswerEvidence(question: MultipleChoiceQuestion) {
  if (question.answerVerification === 'official_key_verified') {
    return {
      kind: 'official' as const,
      label: '公式正答（照合済み）',
      note: '試験実施機関が公表した正答と照合済みです。',
      source: `出典：${question.officialAnswerSource.issuer} / ${question.officialAnswerSource.reference} / ${question.officialAnswerSource.url}`,
    };
  }
  if (question.answerVerification === 'publisher_reference_only') {
    return {
      kind: 'publisher' as const,
      label: '出版社参考答案（学習上の正答）',
      note: '出版社の参考答案を学習上の正答として採用しています。公式正答とは照合していません。',
      source: publisherMultipleChoiceSourceText(question.publisherReferenceSource),
    };
  }
  return {
    kind: 'unknown' as const,
    label: '解答',
    note: '',
    source: null,
  };
}

function multipleChoiceQuizResultLabel(question: MultipleChoiceQuestion, isCorrect: boolean): string {
  const evidence = multipleChoiceAnswerEvidence(question);
  if (evidence.kind === 'publisher') return isCorrect ? '出版社参考答案と一致しました' : '出版社参考答案と異なります';
  if (evidence.kind === 'official') return isCorrect ? '公式正答と一致しました' : '公式正答と異なります';
  return isCorrect ? '登録された解答と一致しました' : '登録された解答と異なります';
}

function App() {
  const [page, setPage] = useState<Page>('home');
  const [questions, setQuestions] = useState<Question[]>(sampleQuestionList);
  const [privateQuestionBank, setPrivateQuestionBank] = useState<QuestionBank | null>(null);
  const [studyState, setStudyState] = useState<StudyState>(EMPTY_STATE);
  const [isLoaded, setIsLoaded] = useState(false);
  const [stateCanBeSaved, setStateCanBeSaved] = useState(false);
  const [storageMessage, setStorageMessage] = useState('');
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!firebaseConfigured);
  const [deviceId, setDeviceId] = useState('');
  const [localSyncMetadata, setLocalSyncMetadata] = useState<LocalSyncMetadata | null>(null);
  const [cloudManifestAvailable, setCloudManifestAvailable] = useState<boolean | null>(null);
  const [syncMessage, setSyncMessage] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [localBackupSignature, setLocalBackupSignature] = useState<string | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [questionNumberFilters, setQuestionNumberFilters] = useState<Partial<Record<LearningPage, string[]>>>({});
  const [answerVisible, setAnswerVisible] = useState(false);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [writtenAnswer, setWrittenAnswer] = useState('');
  const [writtenRevealed, setWrittenRevealed] = useState(false);
  const memoryRatingRecorded = useRef(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const questionBankInput = useRef<HTMLInputElement>(null);
  const stateRef = useRef<StudyState>(EMPTY_STATE);
  const eventQueueRef = useRef<Promise<void>>(Promise.resolve());
  const syncInProgressRef = useRef(false);
  const syncRequestedRef = useRef(false);

  const isPrivateQuestionBankLoaded = privateQuestionBank !== null;
  const currentLocalSignature = useMemo(
    () => localDataSignature(privateQuestionBank, studyState),
    [privateQuestionBank, studyState],
  );
  const localBackupIsCurrent = localBackupSignature === currentLocalSignature;

  const questionIds = useMemo(() => new Set(questions.map((question) => question.id)), [questions]);

  const today = localDateKey();
  const allProgress = useMemo(
    () => questions.map((question) => progressFor(studyState, question.id)),
    [questions, studyState],
  );
  const studiedToday = useMemo(
    () => questions.filter((question) => progressFor(studyState, question.id).lastStudiedOn === today),
    [questions, studyState, today],
  );
  const difficultQuestions = useMemo(
    () => questions.filter((question) => progressFor(studyState, question.id).isDifficult),
    [questions, studyState],
  );
  const modeQuestions = useMemo(() => {
    if (page === 'quiz') return questions.filter(isMultipleChoiceQuestion);
    if (page === 'written') return questions.filter(isWrittenQuestion);
    return questions;
  }, [page, questions]);
  const questionNumberOptions = useMemo(
    () => [...new Set(modeQuestions.map(questionNumberValue).filter((value): value is string => value !== null))]
      .sort((left, right) => left.localeCompare(right, 'ja', { numeric: true, sensitivity: 'base' })),
    [modeQuestions],
  );
  const activeLearningPage = isLearningPage(page) ? page : null;
  const selectedQuestionNumbers = activeLearningPage ? questionNumberFilters[activeLearningPage] ?? [] : [];
  const pageQuestions = useMemo(() => {
    if (!activeLearningPage || selectedQuestionNumbers.length === 0) return modeQuestions;
    const selectedNumbers = new Set(selectedQuestionNumbers);
    return modeQuestions.filter((question) => {
      const value = questionNumberValue(question);
      return value !== null && selectedNumbers.has(value);
    });
  }, [activeLearningPage, modeQuestions, selectedQuestionNumbers]);
  const studiedQuestionCount = allProgress.filter((progress) => totalStudyCount(progress) > 0).length;
  const currentQuestion = pageQuestions.length ? pageQuestions[questionIndex % pageQuestions.length] : undefined;
  const currentProgress = currentQuestion ? progressFor(studyState, currentQuestion.id) : EMPTY_PROGRESS;

  useEffect(() => {
    let active = true;
    async function loadAppData() {
      try {
        const savedBank = await loadQuestionBank();
        const initialQuestions = savedBank?.questions ?? sampleQuestionList;
        if (active) {
          setQuestions(initialQuestions);
          setPrivateQuestionBank(savedBank);
        }
        const [savedState, savedDeviceId, savedSyncMetadata] = await Promise.all([
          loadStudyState(new Set(initialQuestions.map((question) => question.id))),
          getOrCreateDeviceId(),
          loadLocalSyncMetadata(),
        ]);
        if (active) {
          stateRef.current = savedState;
          setStudyState(savedState);
          setDeviceId(savedDeviceId);
          setLocalSyncMetadata(savedSyncMetadata);
          setStateCanBeSaved(true);
        }
      } catch (error: unknown) {
        if (active) setStorageMessage(error instanceof Error ? error.message : '保存データを読み込めませんでした。');
      } finally {
        if (active) setIsLoaded(true);
      }
    }
    void loadAppData();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!firebaseAuth) {
      setAuthReady(true);
      return;
    }
    return onAuthStateChanged(firebaseAuth, (user) => {
      setAuthUser(user);
      setAuthReady(true);
      if (!user) setCloudManifestAvailable(null);
    }, (error) => {
      setAuthReady(true);
      setSyncMessage(error.message || 'Firebaseの認証状態を確認できませんでした。');
    });
  }, []);

  useEffect(() => {
    if (isLoaded && authReady && authUser) void refreshCloudStatus(authUser);
  }, [isLoaded, authReady, authUser]);

  useEffect(() => {
    if (authUser && localSyncMetadata?.userId === authUser.uid && cloudManifestAvailable === true) {
      void runSync(true);
    }
  }, [authUser, localSyncMetadata?.userId, localSyncMetadata?.bankId, localSyncMetadata?.bankHash, cloudManifestAvailable]);

  useEffect(() => {
    const syncWhenOnline = () => {
      if (document.visibilityState === 'visible' && authUser && localSyncMetadata?.userId === authUser.uid) {
        void runSync(true);
      }
    };
    window.addEventListener('online', syncWhenOnline);
    document.addEventListener('visibilitychange', syncWhenOnline);
    return () => {
      window.removeEventListener('online', syncWhenOnline);
      document.removeEventListener('visibilitychange', syncWhenOnline);
    };
  }, [authUser, localSyncMetadata]);

  function changePage(nextPage: Page) {
    setPage(nextPage);
    setQuestionIndex(0);
    setAnswerVisible(false);
    setSelectedChoice(null);
    setWrittenAnswer('');
    setWrittenRevealed(false);
    memoryRatingRecorded.current = false;
  }

  function resetQuestionInteraction() {
    setQuestionIndex(0);
    setAnswerVisible(false);
    setSelectedChoice(null);
    setWrittenAnswer('');
    setWrittenRevealed(false);
    memoryRatingRecorded.current = false;
  }

  function toggleQuestionNumber(number: string) {
    if (!activeLearningPage) return;
    setQuestionNumberFilters((current) => {
      const selected = current[activeLearningPage] ?? [];
      const next = selected.includes(number)
        ? selected.filter((value) => value !== number)
        : [...selected, number];
      return { ...current, [activeLearningPage]: next };
    });
    resetQuestionInteraction();
  }

  function resetQuestionNumberFilter() {
    if (!activeLearningPage) return;
    setQuestionNumberFilters((current) => ({ ...current, [activeLearningPage]: [] }));
    resetQuestionInteraction();
  }

  function moveQuestion(direction: -1 | 1) {
    if (pageQuestions.length === 0) return;
    setQuestionIndex((index) => (index + direction + pageQuestions.length) % pageQuestions.length);
    setAnswerVisible(false);
    setSelectedChoice(null);
    setWrittenAnswer('');
    setWrittenRevealed(false);
    memoryRatingRecorded.current = false;
  }

  function recordStudyEvent(payload: NewStudyEvent | ((current: StudyState) => NewStudyEvent)) {
    const operation = eventQueueRef.current.then(async () => {
      if (!deviceId || !stateCanBeSaved) throw new Error('端末情報を準備できていないため、学習記録を保存できません。');
      const event = createStudyEvent(deviceId, typeof payload === 'function' ? payload(stateRef.current) : payload);
      const next = applyStudyEvent(stateRef.current, event);
      await appendStudyEventAndState(event, next);
      stateRef.current = next;
      setStudyState(next);
      setStorageMessage((message) => message.startsWith('学習データを保存できません') ? '' : message);
    });
    eventQueueRef.current = operation.catch((error: unknown) => {
      setStorageMessage(error instanceof Error ? error.message : '学習イベントを端末に保存できませんでした。');
    });
    void operation.then(
      () => {
        if (authUser && localSyncMetadata?.userId === authUser.uid) void runSync(true);
      },
      () => undefined,
    );
  }

  function recordFirstStudy(questionId: string) {
    const completedAt = new Date().toISOString();
    recordStudyEvent({ kind: 'first_study', questionId, studiedOn: today, completedAt });
  }

  function recordWrittenTest(questionId: string) {
    recordStudyEvent({ kind: 'written_test', questionId, studiedOn: today });
  }

  function toggleDifficult(questionId: string) {
    recordStudyEvent((current) => ({
      kind: 'difficulty_set',
      questionId,
      isDifficult: !progressFor(current, questionId).isDifficult,
    }));
  }

  function handleRating(questionId: string, rating: Rating) {
    const nextReviewOn = nextReviewDate(rating);
    if (page === 'memory') {
      const countTest = !memoryRatingRecorded.current;
      memoryRatingRecorded.current = true;
      recordStudyEvent({ kind: 'memory_rating', questionId, studiedOn: today, countTest, rating, nextReviewOn });
      return;
    }
    recordStudyEvent({ kind: 'rating', questionId, studiedOn: today, rating, nextReviewOn });
  }

  async function refreshCloudStatus(user: User) {
    try {
      const manifest = await checkCloudManifest(user);
      setCloudManifestAvailable(Boolean(manifest));
      if (!manifest) {
        setSyncMessage(localSyncMetadata?.userId === user.uid
          ? 'この端末は同期済みですが、クラウドの問題バンク情報が見つかりません。データは変更していません。'
          : 'このGoogleアカウントにクラウドデータはありません。移行元端末から初回移行するか、移行済み端末から取得できます。');
        return;
      }
      if (localSyncMetadata?.userId === user.uid) {
        setSyncMessage('クラウドデータを確認しました。同期を開始します。');
      } else if (localSyncMetadata?.userId) {
        setSyncMessage('この端末は別のGoogleアカウントに紐付いています。バックアップ後、クラウドデータを明示的に取得できます。');
      } else {
        setSyncMessage('クラウドデータがあります。端末バックアップを作成してから、問題バンクと学習履歴を取得してください。');
      }
    } catch (error) {
      setCloudManifestAvailable(null);
      setSyncMessage(error instanceof Error ? error.message : 'クラウドの状態を確認できませんでした。');
    }
  }

  async function runSync(quiet = false) {
    if (syncInProgressRef.current) {
      syncRequestedRef.current = true;
      return;
    }
    if (!authUser || !deviceId || localSyncMetadata?.userId !== authUser.uid) {
      if (!quiet) setSyncMessage('このGoogleアカウントに端末が紐付いていません。初回移行またはクラウド取得を行ってください。');
      return;
    }

    syncInProgressRef.current = true;
    setSyncBusy(true);
    try {
      await eventQueueRef.current;
      const snapshot = await loadLocalSyncSnapshot();
      if (!snapshot.bank) throw new Error('この端末に問題バンクがありません。クラウドから取得してください。');
      const result = await syncLinkedDevice(authUser, snapshot.bank, localSyncMetadata, snapshot.outbox);

      const commit = eventQueueRef.current.then(async () => {
        const latestSnapshot = await loadLocalSyncSnapshot();
        const linkedMetadata = await loadLocalSyncMetadata();
        const latestIdentity = latestSnapshot.bank ? await hashQuestionBank(latestSnapshot.bank) : null;
        if (
          linkedMetadata?.userId !== authUser.uid
          || !latestIdentity
          || latestIdentity.bankId !== result.metadata.bankId
          || latestIdentity.bankHash !== result.metadata.bankHash
        ) {
          throw new Error('同期中に端末の連携先または問題バンクが変わりました。クラウド結果で上書きせず、再確認してください。');
        }
        const latestOutbox = await loadStudyEventOutbox();
        const alreadyIncluded = new Set([
          ...result.metadata.knownEventIds,
          ...result.stillPendingEvents.map((event) => event.eventId),
        ]);
        const eventsCreatedDuringSync = latestOutbox.filter((event) => !alreadyIncluded.has(event.eventId));
        const mergedState = applyStudyEvents(result.state, eventsCreatedDuringSync);
        await acknowledgeStudyEvents(result.acknowledgedEventIds);
        await saveStudyState(mergedState);
        await saveLocalSyncMetadata(result.metadata);
        stateRef.current = mergedState;
        setStudyState(mergedState);
        setLocalSyncMetadata(result.metadata);
      });
      eventQueueRef.current = commit.catch((error: unknown) => {
        setStorageMessage(error instanceof Error ? error.message : '同期後の端末保存に失敗しました。');
      });
      await commit;
      setCloudManifestAvailable(true);
      const pendingCount = await loadStudyEventOutbox().then((events) => events.length);
      const conflicts = result.conflicts.length
        ? ` 別端末でも同じ問題の評価・苦手設定が変更されています（${result.conflicts.map((conflict) => `${conflict.questionId}:${conflict.field}`).join('、')}）。現在は更新日時順で表示し、履歴自体は保持しています。`
        : '';
      setSyncMessage(`同期しました。クラウドに${result.eventCount}件の学習イベント、未送信${pendingCount}件。${conflicts}`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '同期に失敗しました。端末の学習データは保持しています。');
    } finally {
      syncInProgressRef.current = false;
      setSyncBusy(false);
      if (syncRequestedRef.current) {
        syncRequestedRef.current = false;
        queueMicrotask(() => void runSync(true));
      }
    }
  }

  async function signInWithGoogle() {
    if (!firebaseAuth) return;
    try {
      await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Googleログインに失敗しました。');
    }
  }

  async function signOutFromGoogle() {
    if (!firebaseAuth) return;
    try {
      await signOut(firebaseAuth);
      setSyncMessage('ログアウトしました。端末内の問題バンクと学習履歴は残っています。');
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'ログアウトに失敗しました。');
    }
  }

  async function downloadDeviceBackup() {
    if (!stateCanBeSaved) {
      setSyncMessage('学習データを読み込めていないため、端末全体のバックアップを作成できません。');
      return;
    }
    try {
      await eventQueueRef.current;
      const snapshot = await loadLocalSyncSnapshot();
      const blob = new Blob([makeDeviceBackup(snapshot.state, snapshot.bank, snapshot.outbox, localSyncMetadata)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `study-device-backup-${today}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setLocalBackupSignature(snapshot.signature);
      setSyncMessage(`端末全体のバックアップを作成しました（問題バンク${snapshot.bank?.questions.length ?? 0}問・未同期イベント${snapshot.outbox.length}件）。`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '端末全体のバックアップを作成できませんでした。');
    }
  }

  async function migrateLocalToCloud() {
    if (!authUser || !deviceId) return;
    try {
      await eventQueueRef.current;
      const snapshot = await loadLocalSyncSnapshot();
      const decision = decideLocalMigration({
        userId: authUser.uid,
        linkedUserId: localSyncMetadata?.userId ?? null,
        hasPrivateBank: snapshot.bank !== null,
        backupIsCurrent: localBackupSignature === snapshot.signature,
        cloudAlreadyInitialized: cloudManifestAvailable === true,
      });
      if (!decision.allowed) {
        const messages = {
          private_bank_required: '初回移行には検証済みの非公開問題バンクが必要です。まずスマホで問題JSONを読み込んでください。',
          backup_required: '移行前に、最新の「問題バンク＋学習履歴」端末バックアップを作成してください。',
          cloud_exists: 'このGoogleアカウントには既にクラウドデータがあります。上書きせず、取得操作を使ってください。',
          already_linked: 'この端末はすでにこのGoogleアカウントに同期されています。同期ボタンを使ってください。',
          different_account: 'この端末は別のGoogleアカウントに紐付いています。先にバックアップしてからクラウド取得を選んでください。',
        };
        setSyncMessage(messages[decision.reason]);
        return;
      }
      if (!window.confirm(`この端末の問題バンク（${snapshot.bank?.questions.length ?? 0}問）と現在の学習状態を、このGoogleアカウントの初期データとして保存します。既存のクラウドデータは上書きしません。続けますか？`)) return;

      setSyncBusy(true);
      const metadata = await migrateLocalDataToCloud(authUser, snapshot.bank!, snapshot.state, deviceId);
      const link = eventQueueRef.current.then(async () => {
        const latest = await loadLocalSyncSnapshot();
        const latestIdentity = latest.bank ? await hashQuestionBank(latest.bank) : null;
        const baselineIds = new Set(snapshot.outbox.map((event) => event.eventId));
        const expectedState = applyStudyEvents(snapshot.state, latest.outbox.filter((event) => !baselineIds.has(event.eventId)));
        if (
          !latestIdentity
          || latestIdentity.bankId !== metadata.bankId
          || latestIdentity.bankHash !== metadata.bankHash
          || localDataSignature(latest.bank, latest.state) !== localDataSignature(snapshot.bank, expectedState)
        ) {
          throw new Error('初回移行中に端末データが変更されたため、この端末を同期済みにしませんでした。クラウドには移行開始時点のスナップショットが作成されている可能性があります。内容を確認し、バックアップ後にクラウドから取得してください。');
        }
        await saveMigratedLocalLink(metadata, snapshot.outbox.map((event) => event.eventId));
      });
      eventQueueRef.current = link.catch((error: unknown) => {
        setStorageMessage(error instanceof Error ? error.message : '同期情報を端末に保存できませんでした。');
      });
      await link;
      setLocalSyncMetadata(metadata);
      setCloudManifestAvailable(true);
      setSyncMessage('初回移行が完了しました。これ以降の学習イベントは、オンライン時に自動同期されます。');
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '初回移行に失敗しました。端末データは変更していません。');
    } finally {
      setSyncBusy(false);
    }
  }

  async function importCloudToDevice() {
    if (!authUser) return;
    try {
      await eventQueueRef.current;
      const snapshot = await loadLocalSyncSnapshot();
      const manifest = await checkCloudManifest(authUser);
      if (!manifest) {
        setCloudManifestAvailable(false);
        setSyncMessage('取得できるクラウドデータがありません。');
        return;
      }
      const localBankId = snapshot.bank ? (await hashQuestionBank(snapshot.bank)).bankId : null;
      const decision = decideCloudImport({
        userId: authUser.uid,
        linkedUserId: localSyncMetadata?.userId ?? null,
        cloudAvailable: true,
        backupIsCurrent: localBackupSignature === snapshot.signature,
        localBankId,
        cloudBankId: manifest.bankId,
        hasPendingEvents: snapshot.outbox.length > 0,
      });
      if (!decision.allowed) {
        setSyncMessage(decision.reason === 'backup_required'
          ? '取得前に、現在端末の問題バンクと学習履歴を含む最新バックアップを作成してください。'
          : 'この端末はすでにこのGoogleアカウントに同期されています。上書き取得ではなく通常同期を使ってください。');
        return;
      }

      const warnings = [
        '現在端末の問題バンクと学習履歴をクラウドの初回データ＋学習イベントで置き換えます。',
        decision.replacesDifferentBank ? '問題バンクIDが異なるため、現在の問題バンクはクラウド版に置き換わります。問題バンクは混ぜません。' : '',
        decision.discardsPendingEvents ? `未同期イベント${snapshot.outbox.length}件も置き換え対象です。直前の端末全体バックアップから回復できます。` : '',
        'この端末の最新バックアップを作成済みであることを確認してください。続けますか？',
      ].filter(Boolean).join('\n\n');
      if (!window.confirm(warnings)) return;

      setSyncBusy(true);
      const bundle = await downloadCloudBundle(authUser);
      const importedState = applyStudyEvents(bundle.initialState, bundle.events);
      const metadata: LocalSyncMetadata = {
        schemaVersion: 1,
        userId: authUser.uid,
        bankId: bundle.manifest.bankId,
        bankHash: bundle.manifest.bankHash,
        knownEventIds: bundle.events.map((event) => event.eventId),
      };
      const commit = eventQueueRef.current.then(async () => {
        await replaceLocalCloudData(bundle.bank, importedState, metadata, snapshot.syncSignature);
        stateRef.current = importedState;
        setStudyState(importedState);
        setPrivateQuestionBank(bundle.bank);
        setQuestions(bundle.bank.questions);
        setQuestionNumberFilters({});
        setLocalSyncMetadata(metadata);
        setLocalBackupSignature(null);
        setCloudManifestAvailable(true);
      });
      eventQueueRef.current = commit.catch((error: unknown) => {
        setStorageMessage(error instanceof Error ? error.message : 'クラウドデータを端末に保存できませんでした。');
      });
      await commit;
      setSyncMessage(`問題バンク${bundle.bank.questions.length}問と学習イベント${bundle.events.length}件を端末に取得しました。問題バンクを混在させず、IndexedDBに保存しました。`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'クラウド取得に失敗しました。端末データは変更していません。');
    } finally {
      setSyncBusy(false);
    }
  }

  async function downloadBackup() {
    if (!stateCanBeSaved) {
      setStorageMessage('学習データを読み込めていないため、バックアップを作成できません。既存データは変更していません。');
      return;
    }
    try {
      await eventQueueRef.current;
      const blob = new Blob([makeBackup(stateRef.current)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `study-backup-${today}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStorageMessage('学習データのバックアップを保存しました。');
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : 'バックアップを作成できませんでした。');
    }
  }

  async function restoreBackup(file: File | undefined) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse((await file.text()).replace(/^\uFEFF/u, ''));
      const deviceBackup = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).backupType === 'device-sync-backup-v1');
      const backupRecord = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      const restoredBank = deviceBackup
        ? backupRecord?.questionBank === null ? null : validateQuestionBank(backupRecord?.questionBank)
        : undefined;
      let restoredOutbox: StudyEvent[] = [];
      if (deviceBackup && backupRecord?.outbox !== undefined) {
        if (!Array.isArray(backupRecord.outbox)) throw new Error('端末バックアップの未同期イベントが不正です。');
        restoredOutbox = deduplicateStudyEvents(backupRecord.outbox.map(validateStudyEvent));
      }
      const restoredSyncMetadata = deviceBackup && backupRecord?.syncMetadata != null
        ? validateLocalSyncMetadata(backupRecord.syncMetadata)
        : null;
      if (restoredSyncMetadata && restoredBank) {
        const restoredIdentity = await hashQuestionBank(restoredBank);
        if (restoredIdentity.bankId !== restoredSyncMetadata.bankId || restoredIdentity.bankHash !== restoredSyncMetadata.bankHash) {
          throw new Error('端末バックアップの問題バンクと同期情報が一致しません。端末データは変更していません。');
        }
      }
      const backupProgress = backupRecord?.progress && typeof backupRecord.progress === 'object'
        ? backupRecord.progress as Record<string, unknown>
        : null;
      const backupRecordIds = backupProgress?.records && typeof backupProgress.records === 'object'
        ? Object.keys(backupProgress.records as Record<string, unknown>)
        : [];
      const restoreQuestionIds = restoredBank
        ? new Set([...restoredBank.questions.map((question) => question.id), ...(deviceBackup ? backupRecordIds : [])])
        : deviceBackup ? new Set([...sampleQuestionList.map((question) => question.id), ...backupRecordIds]) : questionIds;
      const restored = readBackup(parsed, restoreQuestionIds);
      if (!window.confirm(deviceBackup
        ? '現在の問題バンク・学習データ・未同期イベントを端末バックアップの内容に置き換えます。バックアップに同期情報があれば再送できる状態に戻します。続けますか？'
        : '現在の学習データをバックアップの内容に置き換えます。端末のクラウド紐付けと未同期イベントは解除・破棄されます。続けますか？')) return;
      const restoreOperation = eventQueueRef.current.then(async () => {
        await restoreLocalStudyData(
          restored,
          deviceBackup ? restoredBank : undefined,
          deviceBackup ? restoredOutbox : [],
          deviceBackup ? restoredSyncMetadata : null,
        );
        stateRef.current = restored;
        setStudyState(restored);
        if (deviceBackup) {
          setPrivateQuestionBank(restoredBank ?? null);
          setQuestions(restoredBank?.questions ?? sampleQuestionList);
          setQuestionNumberFilters({});
        }
        setLocalSyncMetadata(deviceBackup ? restoredSyncMetadata : null);
        setLocalBackupSignature(null);
        setStateCanBeSaved(true);
      });
      eventQueueRef.current = restoreOperation.catch((error: unknown) => {
        setStorageMessage(error instanceof Error ? error.message : 'バックアップからの復元に失敗しました。');
      });
      await restoreOperation;
      setStorageMessage('バックアップから学習データを復元しました。');
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : 'バックアップを読み込めませんでした。');
    } finally {
      if (restoreInput.current) restoreInput.current.value = '';
    }
  }

  async function importQuestionBank(file: File | undefined) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const bank = validateQuestionBank(parsed);
      if (localSyncMetadata) {
        const incomingIdentity = await hashQuestionBank(bank);
        if (incomingIdentity.bankId !== localSyncMetadata.bankId || incomingIdentity.bankHash !== localSyncMetadata.bankHash) {
          setStorageMessage('この端末はクラウド同期済みのため、別版の問題バンクを読み込めません。同期成功を確認後、右上の「バックアップ」で通常の学習データJSONを保存し、そのJSONを「復元」して連携を解除してから読み込んでください。未同期イベントは先に同期してください。');
          return;
        }
      }
      if (isPrivateQuestionBankLoaded && !window.confirm('保存済みの問題バンクをこのファイルの内容に置き換えます。続けますか？')) return;

      const importOperation = eventQueueRef.current.then(async () => {
        await saveQuestionBank(bank);
        setQuestions(bank.questions);
        setQuestionNumberFilters({});
        setPrivateQuestionBank(bank);
        changePage('home');
      });
      eventQueueRef.current = importOperation.catch((error: unknown) => {
        setStorageMessage(error instanceof Error ? error.message : '問題バンクを保存できませんでした。');
      });
      await importOperation;
      setStorageMessage(
        `${bank.questions.length}問の問題バンクを読み込み、ブラウザー内に保存しました。` +
          (stateCanBeSaved ? '' : ' 学習履歴を読み込めていないため、進捗保存は無効のままです。'),
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'JSONを読み取れません。';
      setStorageMessage(`問題バンクを読み込めませんでした。${detail}`);
    } finally {
      if (questionBankInput.current) questionBankInput.current.value = '';
    }
  }

  function handleChoice(question: MultipleChoiceQuestion, choiceIndex: number) {
    if (selectedChoice !== null) return;
    const isCorrect = choiceIndex === question.correctChoice;
    setSelectedChoice(choiceIndex);
    const rating: Rating = isCorrect ? 'good' : 'weak';
    recordStudyEvent({
      kind: 'quiz_answer', questionId: question.id, studiedOn: today,
      correct: isCorrect, rating, nextReviewOn: nextReviewDate(rating),
    });
  }

  function renderQuestionCard(question: Question, compact = false) {
    const progress = progressFor(studyState, question.id);
    return (
      <article className={`question-card${compact ? ' question-card--compact' : ''}`} key={question.id}>
        <div className="question-card__topline">
          <span className="sample-tag">{question.sourceLabel}</span>
          <span className="question-category">{question.category} · {question.id.slice(-2)}</span>
        </div>
        {questionSourceText(question) && <span className="muted-small">{questionSourceText(question)}</span>}
        <h3>{question.title}</h3>
        <p className="question-card__prompt">{question.prompt}</p>
        {renderAnswerContent(question, 'question-card__answer')}
        <div className="question-card__footer">
          <span className="muted-small">学習回数 {totalStudyCount(progress)}回{progress.legacyAttempts > 0 ? '（旧記録含む）' : ''}</span>
          {progress.nextReviewOn && <span className="muted-small">次回復習 {progress.nextReviewOn}</span>}
          <button className={`text-button${progress.isDifficult ? ' text-button--active' : ''}`} onClick={() => toggleDifficult(question.id)}>
            {progress.isDifficult ? '☆ 苦手から外す' : '☆ 苦手に追加'}
          </button>
        </div>
      </article>
    );
  }

  function renderAnswerContent(question: Question, className = 'revealed-answer') {
    if (isWrittenQuestion(question)) {
      return (
        <div className={className}>
          <span className="eyebrow">出版社参考答案</span>
          <p className="written-answer-text">{formatWrittenReferenceAnswer(question.publisher_reference_answer.text)}</p>
          <p className="muted-small">出版社資料に基づく参考答案です。公式正答ではありません。</p>
          <p className="muted-small">{publisherReferenceSourceText(question)}</p>
          {question.explanation && <><span className="eyebrow">解説</span><p>{question.explanation}</p></>}
        </div>
      );
    }
    const evidence = multipleChoiceAnswerEvidence(question);
    return (
      <div className={className}>
        <span className="eyebrow">{evidence.label}</span>
        <p>{question.answer}</p>
        {evidence.kind !== 'unknown' && (
          <div className={`answer-evidence answer-evidence--${evidence.kind}`} role="note">
            <strong>{evidence.label}</strong>
            <p>{evidence.note}</p>
            <small>{evidence.source}</small>
          </div>
        )}
        <span className="eyebrow">解説</span>
        <p>{question.explanation}</p>
      </div>
    );
  }

  function renderHome() {
    return (
      <>
        <section className="welcome-card">
          <div className="welcome-card__copy">
            <span className="welcome-card__date">{formatDate()}</span>
            <h2>今日も少しずつ、<br className="mobile-break" />積み重ねていきましょう。</h2>
            <p>短い時間でも、続けることが力になります。</p>
            <button className="button button--light" onClick={() => changePage('today')}>今日の学習をはじめる <span aria-hidden="true">→</span></button>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="welcome-art__sun" />
            <div className="welcome-art__book"><span /><span /><span /></div>
            <div className="welcome-art__sparkle">✦</div>
          </div>
        </section>

        <section className="stat-grid" aria-label="学習状況">
          <div className="stat-card"><span className="stat-card__icon stat-card__icon--blue">▦</span><span className="stat-card__label">今日取り組んだ問題</span><strong>{studiedToday.length}<small> / {questions.length}</small></strong><span className="stat-card__hint">今日の学習記録</span></div>
          <div className="stat-card"><span className="stat-card__icon stat-card__icon--green">✓</span><span className="stat-card__label">学習した問題</span><strong>{studiedQuestionCount}<small> / {questions.length}</small></strong><span className="stat-card__hint">初回学習またはテストを記録</span></div>
          <div className="stat-card"><span className="stat-card__icon stat-card__icon--peach">☆</span><span className="stat-card__label">苦手問題</span><strong>{difficultQuestions.length}<small> 問</small></strong><span className="stat-card__hint">あとで復習したい問題</span></div>
        </section>

        <div className="section-heading"><div><span className="eyebrow">START LEARNING</span><h2>学習メニュー</h2></div><button className="text-button" onClick={() => changePage('today')}>今日の学習を見る →</button></div>
        <section className="menu-grid">
          {navigation.filter((item) => ['first', 'memory', 'quiz', 'written'].includes(item.id)).map((item, index) => (
            <button className="menu-card" key={item.id} onClick={() => changePage(item.id)}>
              <span className={`menu-card__icon menu-card__icon--${index + 1}`}>{item.symbol}</span>
              <span className="menu-card__body"><strong>{item.label}</strong><small>{['解答・解説から学ぶ', '○△×で暗記をチェック', '4つの選択肢で確認', '書いて解答例と見比べる'][index]}</small></span>
              <span className="menu-card__arrow">→</span>
            </button>
          ))}
        </section>

        <div className="section-heading section-heading--compact"><div><span className="eyebrow">REVIEW</span><h2>苦手問題</h2></div><button className="text-button" onClick={() => changePage('difficult')}>一覧を見る →</button></div>
        {difficultQuestions.length ? <div className="mini-list">{difficultQuestions.slice(0, 2).map((question) => <button key={question.id} className="mini-list__item" onClick={() => changePage('difficult')}><span className="mini-list__dot">☆</span><span><strong>{question.title}</strong><small>{question.category} · {question.id}</small></span><span className="mini-list__arrow">→</span></button>)}</div> : <div className="empty-inline"><span>☆</span><p>苦手に登録した問題はここに表示されます。</p></div>}
      </>
    );
  }

  function renderToday() {
    const remaining = questions.filter((question) => progressFor(studyState, question.id).lastStudiedOn !== today);
    return (
      <>
        <section className="today-summary">
          <div className="today-summary__icon">☀</div>
          <div><span className="eyebrow">TODAY'S PLAN · {formatDate()}</span><h2>今日の学習は {studiedToday.length} / {questions.length} 問</h2><p>{remaining.length ? '気になるメニューから、ひとつ選んで始めてみましょう。' : '今日の問題にすべて取り組みました。おつかれさまでした！'}</p></div>
          <div className="progress-ring" style={{ '--progress': `${Math.round((studiedToday.length / questions.length) * 100)}%` } as CSSProperties}><strong>{Math.round((studiedToday.length / questions.length) * 100)}<small>%</small></strong></div>
        </section>
        <div className="section-heading"><div><span className="eyebrow">DAILY CHECKLIST</span><h2>今日の問題</h2></div><span className="muted-small">取り組むと自動で記録されます</span></div>
        <div className="today-list">
          {questions.map((question) => {
            const done = progressFor(studyState, question.id).lastStudiedOn === today;
            return <div className={`today-row${done ? ' today-row--done' : ''}`} key={question.id}><span className="today-row__check">{done ? '✓' : '○'}</span><span className="today-row__text"><strong>{question.title}</strong><small>{question.category} · {question.id}</small></span><span className={`today-row__status${done ? ' today-row__status--done' : ''}`}>{done ? '学習済み' : '未学習'}</span><button className="text-button" onClick={() => changePage('memory')}>取り組む →</button></div>;
          })}
        </div>
        <section className="notice-card"><span>i</span><p>{isPrivateQuestionBankLoaded ? '現在は非公開問題バンクの学習状況を表示しています。問題文・出典データはこの端末内に保存されます。' : '現在はサンプル問題の学習状況を表示しています。目標時間や通知の設定は今後の追加機能です。'}</p></section>
      </>
    );
  }

  function renderStudyMode() {
    if (!currentQuestion) {
      const isWrittenPage = page === 'written';
      return <>{renderQuestionNumberFilter()}<section className="empty-state"><span className="empty-state__icon">{isWrittenPage ? '✎' : '☷'}</span><h2>{isWrittenPage ? '記述式問題はまだありません' : '問題がありません'}</h2><p>{isWrittenPage ? '非公開の問題バンクを読み込むと、記述式問題がここに表示されます。' : '問題バンクを読み込むと、この画面で演習できます。'}</p></section></>;
    }

    if (page === 'first') {
      return <>
        <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--blue">▤</span><div><span className="eyebrow">FIRST LEARNING</span><h2>まずは解答・解説を読んでみましょう</h2><p>このモードでは正誤判定を行いません。自分のペースで読み進められます。</p></div></div>
        {renderQuestionNumberFilter()}
        <div className="question-position"><span>問題 {questionIndex + 1}<small> / {pageQuestions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / pageQuestions.length) * 100}%` }} /></span></div>
        {renderQuestionCard(currentQuestion)}
        <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => { recordFirstStudy(currentQuestion.id); moveQuestion(1); }}>読んだので次へ <span>→</span></button></div>
      </>;
    }

    if (page === 'memory') {
      return <>
        <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--mint">◇</span><div><span className="eyebrow">MEMORY CHECK</span><h2>思い出せるか、確認してみましょう</h2><p>解答を見たあと、今の手応えを○△×で記録できます。</p></div></div>
        {renderQuestionNumberFilter()}
        <div className="question-position"><span>問題 {questionIndex + 1}<small> / {pageQuestions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / pageQuestions.length) * 100}%` }} /></span></div>
        <article className="study-card"><div className="question-card__topline"><span className="sample-tag">{currentQuestion.sourceLabel}</span><span className="question-category">{currentQuestion.category} · {currentQuestion.id}</span></div>{questionSourceText(currentQuestion) && <span className="muted-small">{questionSourceText(currentQuestion)}</span>}<span className="eyebrow">QUESTION</span><h2 className="study-card__prompt">{currentQuestion.prompt}</h2>{answerVisible ? renderAnswerContent(currentQuestion) : <button className="button button--primary button--wide" onClick={() => setAnswerVisible(true)}>解答・解説を見る</button>}</article>
        {answerVisible && <section className="rating-panel"><div><strong>どのくらい思い出せましたか？</strong><small>手応えと次回復習日を記録します。</small></div><div className="rating-buttons">{ratingOptions.map((option) => <button key={option.value} className={`rating-button rating-button--${option.tone}${currentProgress.rating === option.value ? ' is-selected' : ''}`} onClick={() => handleRating(currentQuestion.id, option.value)}><strong>{option.symbol}</strong><span>{option.label}</span></button>)}</div></section>}
        <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => moveQuestion(1)}>次の問題 <span>→</span></button></div>
      </>;
    }

    if (page === 'quiz') {
      if (!isMultipleChoiceQuestion(currentQuestion)) return null;
      return <>
        <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--peach">☷</span><div><span className="eyebrow">MULTIPLE CHOICE</span><h2>選択肢を選んで答えましょう</h2><p>選ぶと正誤と解説が表示されます。</p></div></div>
        {renderQuestionNumberFilter()}
        <div className="question-position"><span>問題 {questionIndex + 1}<small> / {pageQuestions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / pageQuestions.length) * 100}%` }} /></span></div>
        <article className="study-card">
          <div className="question-card__topline"><span className="sample-tag">{currentQuestion.sourceLabel}</span><span className="question-category">{currentQuestion.category} · {currentQuestion.id}</span></div>
          {questionSourceText(currentQuestion) && <span className="muted-small">{questionSourceText(currentQuestion)}</span>}
          <span className="eyebrow">QUESTION</span>
          <h2 className="study-card__prompt">{currentQuestion.prompt}</h2>
          <div className="choice-list">
            {currentQuestion.choices.map((choice, index) => {
              const isCorrect = index === currentQuestion.correctChoice;
              const isSelected = selectedChoice === index;
              const stateClass = selectedChoice === null ? '' : isCorrect ? ' choice-button--correct' : isSelected ? ' choice-button--incorrect' : ' choice-button--muted';
              const evidenceLabel = currentQuestion.answerVerification === 'publisher_reference_only'
                ? '参考答案'
                : currentQuestion.answerVerification === 'official_key_verified' ? '公式正答' : '登録解答';
              return (
                <button key={choice} className={`choice-button${stateClass}`} onClick={() => handleChoice(currentQuestion, index)} disabled={selectedChoice !== null}>
                  <span>{String.fromCharCode(65 + index)}</span>{choice}{selectedChoice !== null && isCorrect && <b>{evidenceLabel}</b>}
                </button>
              );
            })}
          </div>
          {selectedChoice !== null && (() => {
            const isCorrect = selectedChoice === currentQuestion.correctChoice;
            const evidence = multipleChoiceAnswerEvidence(currentQuestion);
            return (
              <div className={`quiz-feedback${isCorrect ? ' quiz-feedback--correct' : ' quiz-feedback--incorrect'}`}>
                <strong>{multipleChoiceQuizResultLabel(currentQuestion, isCorrect)}</strong>
                <p>{currentQuestion.explanation}</p>
                <small>{evidence.label}：{currentQuestion.choices[currentQuestion.correctChoice]}</small>
                {evidence.source && <small className="quiz-feedback__source">{evidence.source}</small>}
                {evidence.note && <small className="quiz-feedback__note">{evidence.note}</small>}
              </div>
            );
          })()}
        </article>
        <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => moveQuestion(1)}>次の問題 <span>→</span></button></div>
      </>;
    }

    if (page !== 'written' || !isWrittenQuestion(currentQuestion)) return null;
    const missingKeywords = (currentQuestion.requiredKeywords ?? []).filter((keyword) => !writtenAnswer.includes(keyword));
    return <>
      <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--lavender">✎</span><div><span className="eyebrow">WRITTEN RECALL</span><h2>思い出した内容を書いてみましょう</h2><p>書いたあとに出版社参考答案と見比べ、自分で記録できます。</p></div></div>
      <section className="ai-note"><span className="ai-note__icon">自分</span><p><strong>答案は自分で確認します</strong><br />入力内容の自動判定は行わず、出版社参考答案と見比べた手応えを記録します。</p></section>
      {renderQuestionNumberFilter()}
      <div className="question-position"><span>問題 {questionIndex + 1}<small> / {pageQuestions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / pageQuestions.length) * 100}%` }} /></span></div>
      <article className="study-card"><div className="question-card__topline"><span className="sample-tag">{currentQuestion.sourceLabel}</span><span className="question-category">{currentQuestion.category} · {currentQuestion.id}</span></div>{questionSourceText(currentQuestion) && <span className="muted-small">{questionSourceText(currentQuestion)}</span>}<span className="eyebrow">QUESTION</span><h2 className="study-card__prompt">{currentQuestion.prompt}</h2><label className="answer-label" htmlFor="written-answer">自分の回答</label><textarea id="written-answer" className="answer-input" placeholder="思い出した内容を入力してください…" value={writtenAnswer} onChange={(event) => setWrittenAnswer(event.target.value)} rows={5} />{writtenRevealed ? <>{renderAnswerContent(currentQuestion)}{currentQuestion.requiredKeywords && <div className="question-card__answer"><span className="eyebrow">回答内で見つからないキーワード</span><p>{missingKeywords.length ? missingKeywords.join('、') : '設定されたキーワードは回答内にすべて見つかりました。'}</p><p className="muted-small">入力文との単純な文字列照合です。正誤や採点の判定ではありません。</p></div>}</> : <button className="button button--primary button--wide" onClick={() => { setWrittenRevealed(true); recordWrittenTest(currentQuestion.id); }}>出版社参考答案を見る</button>}</article>
      {writtenRevealed && <section className="rating-panel"><div><strong>自分で確認</strong><small>見比べた手応えを○△×で記録します。</small></div><div className="rating-buttons">{ratingOptions.map((option) => <button key={option.value} className={`rating-button rating-button--${option.tone}${currentProgress.rating === option.value ? ' is-selected' : ''}`} onClick={() => handleRating(currentQuestion.id, option.value)}><strong>{option.symbol}</strong><span>{option.label}</span></button>)}</div></section>}
      <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => moveQuestion(1)}>次の問題 <span>→</span></button></div>
    </>;
  }

  function renderDifficult() {
    return difficultQuestions.length ? <div className="difficult-list">{difficultQuestions.map((question) => renderQuestionCard(question, true))}</div> : <section className="empty-state"><span className="empty-state__icon">☆</span><h2>苦手問題はまだありません</h2><p>問題カードの「苦手に追加」または暗記確認の「×」から登録できます。</p><button className="button button--primary" onClick={() => changePage('memory')}>暗記確認をはじめる →</button></section>;
  }

  function renderSyncPanel() {
    const isLinkedToAccount = Boolean(authUser && localSyncMetadata?.userId === authUser.uid);
    const canUseLocalData = isLoaded && stateCanBeSaved && !syncBusy;
    return (
      <section className="sync-panel" aria-labelledby="sync-panel-title">
        <div className="sync-panel__heading">
          <div><span className="eyebrow">CROSS-DEVICE STUDY</span><h2 id="sync-panel-title">スマホ・PC間の学習同期</h2></div>
          <span className={`sync-status${isLinkedToAccount ? ' sync-status--linked' : ''}`}><i />{!firebaseConfigured ? 'ローカル保存' : isLinkedToAccount ? 'アカウント連携済み' : '未連携'}</span>
        </div>
        <p className="sync-panel__intro">問題バンクと学習履歴は通常この端末のIndexedDBに保存されます。Googleアカウントを連携すると、非公開問題バンクはFirebase Storageへ、学習イベントはFirestoreへユーザー専用データとして同期します。オフライン中もこの端末で学習できます。</p>
        {!firebaseConfigured ? (
          <div className="sync-panel__notice" role="status">
            <strong>クラウド同期は未設定です</strong>
            <span>Firebase設定がないため、現在はサンプル問題・ローカル保存で動作しています。.envまたはGitHub Actions Variablesに設定してください（不足: {firebaseMissingConfig.join(', ')}）。</span>
          </div>
        ) : !authReady ? (
          <div className="sync-panel__notice">Firebaseの認証状態を確認しています…</div>
        ) : !authUser ? (
          <div className="sync-panel__actions"><button className="button button--primary" onClick={() => void signInWithGoogle()} disabled={!canUseLocalData}>Googleでログイン</button><span className="muted-small">ログインだけではデータをアップロードしません。初回移行・取得はバックアップ後の明示操作です。</span></div>
        ) : (
          <>
            <div className="sync-panel__account"><span><strong>{authUser.displayName || 'Googleアカウント'}</strong><small>{authUser.email || authUser.uid}</small></span><button className="text-button" onClick={() => void signOutFromGoogle()} disabled={syncBusy}>ログアウト</button></div>
            <div className="sync-panel__actions">
              <button className="button button--outline" onClick={() => void downloadDeviceBackup()} disabled={!canUseLocalData}>{localBackupIsCurrent ? '最新バックアップを再作成' : '端末全体をバックアップ'}</button>
              {isLinkedToAccount && cloudManifestAvailable && <button className="button button--primary" onClick={() => void runSync()} disabled={!canUseLocalData}>{syncBusy ? '同期中…' : '今すぐ同期'}</button>}
              {!isLinkedToAccount && cloudManifestAvailable && <button className="button button--primary" onClick={() => void importCloudToDevice()} disabled={!canUseLocalData || !localBackupIsCurrent}>{syncBusy ? '取得中…' : 'クラウドからこの端末へ取得'}</button>}
              {!isLinkedToAccount && cloudManifestAvailable === false && <button className="button button--primary" onClick={() => void migrateLocalToCloud()} disabled={!canUseLocalData || !localBackupIsCurrent || !privateQuestionBank}>{syncBusy ? '初回移行中…' : 'この端末から初回移行'}</button>}
              {cloudManifestAvailable === null && <button className="button button--outline" onClick={() => void refreshCloudStatus(authUser)} disabled={syncBusy}>クラウド状態を確認</button>}
              {isLinkedToAccount && !cloudManifestAvailable && <button className="button button--outline" onClick={() => void refreshCloudStatus(authUser)} disabled={syncBusy}>クラウドを再確認</button>}
            </div>
            {localBackupIsCurrent && <p className="sync-panel__backup-note">現在の問題バンクと学習状態を含むバックアップを作成済みです。データ変更後は再作成が必要です。</p>}
          </>
        )}
        {syncMessage && <p className="sync-panel__message" role="status">{syncBusy && <span className="sync-panel__spinner" aria-hidden="true" />} {syncMessage}</p>}
        <p className="sync-panel__privacy">教材データをクラウドに置く場合は、教材の利用許諾・個人情報・共有端末の扱いを事前に確認してください。同期失敗時は端末内データを上書きしません。</p>
      </section>
    );
  }

  function renderQuestionNumberFilter() {
    return (
      <section className="question-filter" aria-label="問題番号フィルター">
        <div className="question-filter__header">
          <div className="question-filter__summary">
            <strong>問題番号で絞り込む</strong>
            <span className="question-filter__count" aria-live="polite">
              {selectedQuestionNumbers.length > 0 && `${selectedQuestionNumbers.length}種類選択中・`}
              対象 {pageQuestions.length} / {modeQuestions.length}問
            </span>
          </div>
          <button
            className="text-button question-filter__reset"
            type="button"
            onClick={resetQuestionNumberFilter}
            disabled={selectedQuestionNumbers.length === 0}
          >
            リセット
          </button>
        </div>
        {questionNumberOptions.length > 0 ? (
          <div className="question-filter__options" role="group" aria-label="問題番号を選択">
            {questionNumberOptions.map((number) => {
              const isSelected = selectedQuestionNumbers.includes(number);
              return (
                <button
                  key={number}
                  className={`question-filter__option${isSelected ? ' is-selected' : ''}`}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggleQuestionNumber(number)}
                >
                  問題{number}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="question-filter__empty">問題番号付きの問題がありません。絞り込みなしで全問題を表示します。</p>
        )}
      </section>
    );
  }

  const currentTitle = pageTitles[page];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => changePage('home')} aria-label="ホームへ"><span className="brand__mark">S</span><span><strong>施工管理</strong><small>STUDY ROOM</small></span></button>
        <nav className="sidebar-nav" aria-label="メインメニュー">
          {navigation.map((item) => <div key={item.id}>{item.group && <span className="nav-group-label">{item.group}</span>}<button className={`nav-item${page === item.id ? ' nav-item--active' : ''}`} onClick={() => changePage(item.id)}><span className="nav-item__symbol">{item.symbol}</span><span>{item.label}</span>{item.id === 'difficult' && difficultQuestions.length > 0 && <span className="nav-count">{difficultQuestions.length}</span>}</button></div>)}
        </nav>
        <div className="sidebar-bottom"><span className="sidebar-bottom__dot" /><span>学習データはこの端末に保存</span></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div><span className="topbar__breadcrumb">学習室 <span>/</span> {currentTitle.title}</span><h1>{currentTitle.title}</h1></div><div className="topbar__actions"><button className="button button--quiet" onClick={() => questionBankInput.current?.click()} disabled={!isLoaded}><span>＋</span> 問題読込</button><input ref={questionBankInput} type="file" accept="application/json,.json" hidden onChange={(event) => void importQuestionBank(event.target.files?.[0])} /><button className="button button--quiet" onClick={downloadBackup}><span>↓</span> バックアップ</button><button className="button button--quiet" onClick={() => restoreInput.current?.click()}><span>↥</span> 復元</button><input ref={restoreInput} type="file" accept="application/json,.json" hidden onChange={(event) => void restoreBackup(event.target.files?.[0])} /></div></header>
        <div className="content-wrap">
          {storageMessage && <div className={`storage-banner${storageMessage.includes('できません') || storageMessage.includes('利用できません') || storageMessage.includes('読み込めません') ? ' storage-banner--error' : ''}`} role="status">{storageMessage}<button onClick={() => setStorageMessage('')} aria-label="閉じる">×</button></div>}
          {renderSyncPanel()}
          <div className="page-lead"><p>{currentTitle.subtitle}</p><span className="sample-disclaimer"><span>!</span> {isPrivateQuestionBankLoaded ? `非公開の問題バンクを使用中です（${questions.length}問・このブラウザーに保存）。` : 'sample/AI作成練習問題です。公式過去問・教材の実データではありません。'}</span></div>
          {!isLoaded && <div className="loading-card">学習データを読み込んでいます…</div>}
          {isLoaded && page === 'home' && renderHome()}
          {isLoaded && page === 'today' && renderToday()}
          {isLoaded && ['first', 'memory', 'quiz', 'written'].includes(page) && renderStudyMode()}
          {isLoaded && page === 'difficult' && renderDifficult()}
          <footer className="page-footer"><span>施工管理 学習室</span><span>学習データはブラウザー内に保存されます</span></footer>
        </div>
      </main>
    </div>
  );
}

export default App;
