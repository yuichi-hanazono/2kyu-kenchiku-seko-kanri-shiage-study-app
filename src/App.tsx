import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import sampleQuestions from '../data/sample/questions.json';
import { loadQuestionBank, loadStudyState, makeBackup, progressFor, readBackup, saveQuestionBank, saveStudyState } from './storage';
import { validateQuestionBank } from './questionBank';
import { EMPTY_STATE, type Question, type QuestionProgress, type Rating, type StudyState } from './types';

type Page = 'home' | 'today' | 'first' | 'memory' | 'quiz' | 'written' | 'difficult';

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

function questionSourceText(question: Question): string | null {
  if (!question.source) return null;
  const pages = [...new Set(question.source.citations.map((citation) => citation.pdfPage))].sort((a, b) => a - b);
  const pageText = pages.length ? `PDF p.${pages.join(', ')}` : 'PDFページ未設定';
  const yearText = question.year ? `${question.year}年度` : '';
  const numberText = question.questionNumber ? `問${question.questionNumber}` : '';
  return `出典：${[yearText, numberText, pageText].filter(Boolean).join(' / ')}（非公開・確認済み）`;
}

function withRating(progress: QuestionProgress, rating: Rating): QuestionProgress {
  return {
    ...progress,
    rating,
    nextReviewOn: nextReviewDate(rating),
    isDifficult: rating === 'weak' ? true : progress.isDifficult,
  };
}

function App() {
  const [page, setPage] = useState<Page>('home');
  const [questions, setQuestions] = useState<Question[]>(sampleQuestionList);
  const [isPrivateQuestionBankLoaded, setIsPrivateQuestionBankLoaded] = useState(false);
  const [studyState, setStudyState] = useState<StudyState>(EMPTY_STATE);
  const [isLoaded, setIsLoaded] = useState(false);
  const [stateCanBeSaved, setStateCanBeSaved] = useState(false);
  const [storageMessage, setStorageMessage] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerVisible, setAnswerVisible] = useState(false);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [writtenAnswer, setWrittenAnswer] = useState('');
  const [writtenRevealed, setWrittenRevealed] = useState(false);
  const memoryRatingRecorded = useRef(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const questionBankInput = useRef<HTMLInputElement>(null);

  const questionIds = useMemo(() => new Set(questions.map((question) => question.id)), [questions]);

  const today = localDateKey();
  const allProgress = useMemo(
    () => questions.map((question) => progressFor(studyState, question.id)),
    [studyState],
  );
  const studiedToday = useMemo(
    () => questions.filter((question) => progressFor(studyState, question.id).lastStudiedOn === today),
    [studyState, today],
  );
  const difficultQuestions = useMemo(
    () => questions.filter((question) => progressFor(studyState, question.id).isDifficult),
    [studyState],
  );
  const studiedQuestionCount = allProgress.filter((progress) => totalStudyCount(progress) > 0).length;
  const currentQuestion = questions[questionIndex % questions.length];
  const currentProgress = progressFor(studyState, currentQuestion.id);

  useEffect(() => {
    let active = true;
    async function loadAppData() {
      try {
        const savedBank = await loadQuestionBank();
        const initialQuestions = savedBank?.questions ?? sampleQuestionList;
        if (active) {
          setQuestions(initialQuestions);
          setIsPrivateQuestionBankLoaded(savedBank !== null);
        }
        const savedState = await loadStudyState(new Set(initialQuestions.map((question) => question.id)));
        if (active) {
          setStudyState(savedState);
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
    if (!isLoaded || !stateCanBeSaved) return;
    saveStudyState(studyState).then(
      () => setStorageMessage((message) => message.startsWith('学習データを保存できません') ? '' : message),
      (error: unknown) => setStorageMessage(error instanceof Error ? error.message : '学習データを保存できませんでした。'),
    );
  }, [isLoaded, stateCanBeSaved, studyState]);

  function changePage(nextPage: Page) {
    setPage(nextPage);
    setQuestionIndex(0);
    setAnswerVisible(false);
    setSelectedChoice(null);
    setWrittenAnswer('');
    setWrittenRevealed(false);
    memoryRatingRecorded.current = false;
  }

  function moveQuestion(direction: -1 | 1) {
    setQuestionIndex((index) => (index + direction + questions.length) % questions.length);
    setAnswerVisible(false);
    setSelectedChoice(null);
    setWrittenAnswer('');
    setWrittenRevealed(false);
    memoryRatingRecorded.current = false;
  }

  function updateProgress(questionId: string, update: (previous: QuestionProgress) => QuestionProgress) {
    setStudyState((current) => {
      const previous = progressFor(current, questionId);
      return {
        ...current,
        records: {
          ...current.records,
          [questionId]: {
            ...update(previous),
            lastStudiedOn: today,
          },
        },
      };
    });
  }

  function recordFirstStudy(questionId: string) {
    const completedAt = new Date().toISOString();
    updateProgress(questionId, (previous) => ({
      ...previous,
      firstStudyCount: previous.firstStudyCount + 1,
      firstStudyCompletedAt: previous.firstStudyCompletedAt ?? completedAt,
    }));
  }

  function recordWrittenTest(questionId: string) {
    updateProgress(questionId, (previous) => ({ ...previous, writtenTestCount: previous.writtenTestCount + 1 }));
  }

  function toggleDifficult(questionId: string) {
    setStudyState((current) => {
      const progress = progressFor(current, questionId);
      return {
        ...current,
        records: {
          ...current.records,
          [questionId]: { ...progress, isDifficult: !progress.isDifficult },
        },
      };
    });
  }

  function handleRating(questionId: string, rating: Rating) {
    if (page === 'memory') {
      const countTest = !memoryRatingRecorded.current;
      memoryRatingRecorded.current = true;
      updateProgress(questionId, (previous) => withRating({
        ...previous,
        memoryTestCount: previous.memoryTestCount + (countTest ? 1 : 0),
      }, rating));
      return;
    }
    updateProgress(questionId, (previous) => withRating(previous, rating));
  }

  function downloadBackup() {
    if (!stateCanBeSaved) {
      setStorageMessage('学習データを読み込めていないため、バックアップを作成できません。既存データは変更していません。');
      return;
    }
    const blob = new Blob([makeBackup(studyState)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `study-backup-${today}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStorageMessage('学習データのバックアップを保存しました。');
  }

  async function restoreBackup(file: File | undefined) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse((await file.text()).replace(/^\uFEFF/u, ''));
      const restored = readBackup(parsed, questionIds);
      if (!window.confirm('現在の学習データをバックアップの内容に置き換えます。続けますか？')) return;
      await saveStudyState(restored);
      setStudyState(restored);
      setStateCanBeSaved(true);
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
      if (isPrivateQuestionBankLoaded && !window.confirm('保存済みの問題バンクをこのファイルの内容に置き換えます。続けますか？')) return;

      await saveQuestionBank(bank);
      setQuestions(bank.questions);
      setIsPrivateQuestionBankLoaded(true);
      changePage('home');
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

  function handleChoice(choiceIndex: number) {
    if (selectedChoice !== null) return;
    const isCorrect = choiceIndex === currentQuestion.correctChoice;
    setSelectedChoice(choiceIndex);
    updateProgress(currentQuestion.id, (previous) => withRating({
      ...previous,
      quizTestCount: previous.quizTestCount + 1,
      quizCorrectCount: previous.quizCorrectCount + (isCorrect ? 1 : 0),
      quizIncorrectCount: previous.quizIncorrectCount + (isCorrect ? 0 : 1),
      quizCorrectStreak: isCorrect ? previous.quizCorrectStreak + 1 : 0,
      lastQuizResult: isCorrect ? 'correct' : 'incorrect',
    }, isCorrect ? 'good' : 'weak'));
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
        <div className="question-card__answer">
          <span className="eyebrow">解答</span>
          <p>{question.answer}</p>
          <span className="eyebrow">解説</span>
          <p>{question.explanation}</p>
        </div>
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
    if (page === 'first') {
      return <>
        <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--blue">▤</span><div><span className="eyebrow">FIRST LEARNING</span><h2>まずは解答・解説を読んでみましょう</h2><p>このモードでは正誤判定を行いません。自分のペースで読み進められます。</p></div></div>
        <div className="question-position"><span>問題 {questionIndex + 1}<small> / {questions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / questions.length) * 100}%` }} /></span></div>
        {renderQuestionCard(currentQuestion)}
        <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => { recordFirstStudy(currentQuestion.id); moveQuestion(1); }}>読んだので次へ <span>→</span></button></div>
      </>;
    }

    if (page === 'memory') {
      return <>
        <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--mint">◇</span><div><span className="eyebrow">MEMORY CHECK</span><h2>思い出せるか、確認してみましょう</h2><p>解答を見たあと、今の手応えを○△×で記録できます。</p></div></div>
        <div className="question-position"><span>問題 {questionIndex + 1}<small> / {questions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / questions.length) * 100}%` }} /></span></div>
        <article className="study-card"><div className="question-card__topline"><span className="sample-tag">{currentQuestion.sourceLabel}</span><span className="question-category">{currentQuestion.category} · {currentQuestion.id}</span></div>{questionSourceText(currentQuestion) && <span className="muted-small">{questionSourceText(currentQuestion)}</span>}<span className="eyebrow">QUESTION</span><h2 className="study-card__prompt">{currentQuestion.prompt}</h2>{answerVisible ? <div className="revealed-answer"><span className="eyebrow">解答</span><p>{currentQuestion.answer}</p><span className="eyebrow">解説</span><p>{currentQuestion.explanation}</p></div> : <button className="button button--primary button--wide" onClick={() => setAnswerVisible(true)}>解答・解説を見る</button>}</article>
        {answerVisible && <section className="rating-panel"><div><strong>どのくらい思い出せましたか？</strong><small>手応えと次回復習日を記録します。</small></div><div className="rating-buttons">{ratingOptions.map((option) => <button key={option.value} className={`rating-button rating-button--${option.tone}${currentProgress.rating === option.value ? ' is-selected' : ''}`} onClick={() => handleRating(currentQuestion.id, option.value)}><strong>{option.symbol}</strong><span>{option.label}</span></button>)}</div></section>}
        <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => moveQuestion(1)}>次の問題 <span>→</span></button></div>
      </>;
    }

    if (page === 'quiz') {
      return <>
        <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--peach">☷</span><div><span className="eyebrow">MULTIPLE CHOICE</span><h2>選択肢を選んで答えましょう</h2><p>選ぶと正誤と解説が表示されます。</p></div></div>
        <div className="question-position"><span>問題 {questionIndex + 1}<small> / {questions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / questions.length) * 100}%` }} /></span></div>
        <article className="study-card"><div className="question-card__topline"><span className="sample-tag">{currentQuestion.sourceLabel}</span><span className="question-category">{currentQuestion.category} · {currentQuestion.id}</span></div>{questionSourceText(currentQuestion) && <span className="muted-small">{questionSourceText(currentQuestion)}</span>}<span className="eyebrow">QUESTION</span><h2 className="study-card__prompt">{currentQuestion.prompt}</h2><div className="choice-list">{currentQuestion.choices.map((choice, index) => { const isCorrect = index === currentQuestion.correctChoice; const isSelected = selectedChoice === index; const stateClass = selectedChoice === null ? '' : isCorrect ? ' choice-button--correct' : isSelected ? ' choice-button--incorrect' : ' choice-button--muted'; return <button key={choice} className={`choice-button${stateClass}`} onClick={() => handleChoice(index)} disabled={selectedChoice !== null}><span>{String.fromCharCode(65 + index)}</span>{choice}{selectedChoice !== null && isCorrect && <b>正解</b>}</button>; })}</div>{selectedChoice !== null && <div className={`quiz-feedback${selectedChoice === currentQuestion.correctChoice ? ' quiz-feedback--correct' : ' quiz-feedback--incorrect'}`}><strong>{selectedChoice === currentQuestion.correctChoice ? '正解です' : '今回は不正解'}</strong><p>{currentQuestion.explanation}</p><small>正答：{currentQuestion.choices[currentQuestion.correctChoice]}</small></div>}</article>
        <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => moveQuestion(1)}>次の問題 <span>→</span></button></div>
      </>;
    }

    return <>
      <div className="mode-intro"><span className="mode-intro__icon mode-intro__icon--lavender">✎</span><div><span className="eyebrow">WRITTEN RECALL</span><h2>思い出した内容を書いてみましょう</h2><p>書いたあとに解答例を表示し、自分で見比べます。</p></div></div>
      <section className="ai-note"><span className="ai-note__icon">AI</span><p><strong>AI採点は未実装です</strong><br />入力内容は自動採点・送信されません。解答例と見比べて自己確認してください。</p></section>
      <div className="question-position"><span>問題 {questionIndex + 1}<small> / {questions.length}</small></span><span className="position-track"><i style={{ width: `${((questionIndex + 1) / questions.length) * 100}%` }} /></span></div>
      <article className="study-card"><div className="question-card__topline"><span className="sample-tag">{currentQuestion.sourceLabel}</span><span className="question-category">{currentQuestion.category} · {currentQuestion.id}</span></div>{questionSourceText(currentQuestion) && <span className="muted-small">{questionSourceText(currentQuestion)}</span>}<span className="eyebrow">QUESTION</span><h2 className="study-card__prompt">{currentQuestion.prompt}</h2><label className="answer-label" htmlFor="written-answer">自分の回答</label><textarea id="written-answer" className="answer-input" placeholder="思い出した内容を入力してください…" value={writtenAnswer} onChange={(event) => setWrittenAnswer(event.target.value)} rows={5} />{writtenRevealed ? <div className="revealed-answer"><span className="eyebrow">解答例</span><p>{currentQuestion.answer}</p><span className="eyebrow">解説</span><p>{currentQuestion.explanation}</p></div> : <button className="button button--primary button--wide" onClick={() => { setWrittenRevealed(true); recordWrittenTest(currentQuestion.id); }}>解答例と見比べる</button>}</article>
      {writtenRevealed && <section className="rating-panel"><div><strong>自分で確認</strong><small>自動採点ではありません。見比べた感覚を記録できます。</small></div><div className="rating-buttons">{ratingOptions.map((option) => <button key={option.value} className={`rating-button rating-button--${option.tone}${currentProgress.rating === option.value ? ' is-selected' : ''}`} onClick={() => handleRating(currentQuestion.id, option.value)}><strong>{option.symbol}</strong><span>{option.label}</span></button>)}</div></section>}
      <div className="mode-actions"><button className="button button--outline" onClick={() => moveQuestion(-1)}>← 前の問題</button><button className="button button--primary" onClick={() => moveQuestion(1)}>次の問題 <span>→</span></button></div>
    </>;
  }

  function renderDifficult() {
    return difficultQuestions.length ? <div className="difficult-list">{difficultQuestions.map((question) => renderQuestionCard(question, true))}</div> : <section className="empty-state"><span className="empty-state__icon">☆</span><h2>苦手問題はまだありません</h2><p>問題カードの「苦手に追加」または暗記確認の「×」から登録できます。</p><button className="button button--primary" onClick={() => changePage('memory')}>暗記確認をはじめる →</button></section>;
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
