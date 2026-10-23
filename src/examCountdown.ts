export const EXAM_DATE = { year: 2026, month: 11, day: 8 } as const;

function localCalendarDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function examCalendarDayNumber(): number {
  return Date.UTC(EXAM_DATE.year, EXAM_DATE.month - 1, EXAM_DATE.day) / 86_400_000;
}

export function formatExamCountdown(today: Date): string {
  const daysUntilExam = examCalendarDayNumber() - localCalendarDayNumber(today);

  if (daysUntilExam > 0) return `試験まであと${daysUntilExam}日`;
  if (daysUntilExam === 0) return '試験日当日';
  return `試験日から${Math.abs(daysUntilExam)}日経過`;
}
