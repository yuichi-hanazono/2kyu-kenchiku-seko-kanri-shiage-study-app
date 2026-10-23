import { describe, expect, it } from 'vitest';
import { formatExamCountdown } from '../src/examCountdown';

describe('formatExamCountdown', () => {
  it('shows one day remaining on the day before the exam', () => {
    expect(formatExamCountdown(new Date(2026, 10, 7, 23, 59))).toBe('試験まであと1日');
  });

  it('shows the exam-day message on the exam date', () => {
    expect(formatExamCountdown(new Date(2026, 10, 8, 0, 1))).toBe('試験日当日');
  });

  it('shows elapsed calendar days on the day after the exam', () => {
    expect(formatExamCountdown(new Date(2026, 10, 9, 0, 1))).toBe('試験日から1日経過');
  });

  it('shows sixteen days remaining on October 23, 2026', () => {
    expect(formatExamCountdown(new Date(2026, 9, 23, 12))).toBe('試験まであと16日');
  });
});
