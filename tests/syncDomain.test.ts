import { describe, expect, it } from 'vitest';
import { EMPTY_STATE } from '../src/types';
import {
  applyStudyEvents,
  decideCloudImport,
  decideLocalMigration,
  deduplicateStudyEvents,
  findConcurrentSettingConflicts,
  validateStudyEvent,
  type StudyEvent,
} from '../src/syncDomain';

const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function event(
  eventId: string,
  deviceId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): StudyEvent {
  return validateStudyEvent({
    schemaVersion: 1,
    eventId,
    deviceId,
    questionId: 'q1',
    occurredAt,
    ...payload,
  });
}

describe('sync domain', () => {
  it('deduplicates retries before applying events to the aggregate state', () => {
    const correct = event('11111111-1111-4111-8111-111111111111', DEVICE_A, '2026-10-21T09:00:00.000Z', {
      kind: 'quiz_answer',
      studiedOn: '2026-10-21',
      correct: true,
      rating: 'good',
      nextReviewOn: '2026-10-28',
    });
    const incorrect = event('22222222-2222-4222-8222-222222222222', DEVICE_B, '2026-10-21T10:00:00.000Z', {
      kind: 'quiz_answer',
      studiedOn: '2026-10-21',
      correct: false,
      rating: 'weak',
      nextReviewOn: '2026-10-22',
    });

    const state = applyStudyEvents(EMPTY_STATE, [correct, correct, incorrect]);
    expect(state.records.q1.quizTestCount).toBe(2);
    expect(state.records.q1.quizCorrectCount).toBe(1);
    expect(state.records.q1.quizIncorrectCount).toBe(1);
    expect(state.records.q1.quizCorrectStreak).toBe(0);
    expect(state.records.q1.rating).toBe('weak');
    expect(deduplicateStudyEvents([correct, correct])).toHaveLength(1);
  });

  it('rejects the same event ID when the payload differs', () => {
    const original = event('33333333-3333-4333-8333-333333333333', DEVICE_A, '2026-10-21T09:00:00.000Z', {
      kind: 'rating',
      studiedOn: '2026-10-21',
      rating: 'good',
      nextReviewOn: '2026-10-28',
    });
    const changed = { ...original, rating: 'weak' as const, nextReviewOn: '2026-10-22' };

    expect(() => deduplicateStudyEvents([original, changed])).toThrow('別の内容と重複');
  });

  it('reports same-question setting changes made by another device', () => {
    const localRating = event('44444444-4444-4444-8444-444444444444', DEVICE_A, '2026-10-21T09:00:00.000Z', {
      kind: 'rating',
      studiedOn: '2026-10-21',
      rating: 'good',
      nextReviewOn: '2026-10-28',
    });
    const remoteRating = event('55555555-5555-4555-8555-555555555555', DEVICE_B, '2026-10-21T10:00:00.000Z', {
      kind: 'rating',
      studiedOn: '2026-10-21',
      rating: 'weak',
      nextReviewOn: '2026-10-22',
    });

    expect(findConcurrentSettingConflicts([localRating], [remoteRating])).toEqual([
      { questionId: 'q1', field: 'rating' },
    ]);
    expect(findConcurrentSettingConflicts([localRating], [{ ...remoteRating, deviceId: DEVICE_A }])).toEqual([]);
  });

  it('requires a current backup before either destructive migration action', () => {
    expect(decideLocalMigration({
      userId: 'user-a', linkedUserId: null, hasPrivateBank: true,
      backupIsCurrent: false, cloudAlreadyInitialized: false,
    })).toEqual({ allowed: false, reason: 'backup_required' });
    expect(decideCloudImport({
      userId: 'user-a', linkedUserId: null, cloudAvailable: true,
      backupIsCurrent: false, localBankId: null, cloudBankId: 'bank-a', hasPendingEvents: false,
    })).toEqual({ allowed: false, reason: 'backup_required' });
  });
});
