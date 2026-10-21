import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  type DocumentReference,
} from 'firebase/firestore';
import { getBytes, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { loadStudyEventOutbox, normalizeState, type LocalSyncMetadata } from './storage';
import { firebaseDatabase, firebaseStorage } from './firebase';
import { validateQuestionBank, type QuestionBank } from './questionBank';
import {
  applyStudyEvents,
  bankIdForHash,
  deduplicateStudyEvents,
  findConcurrentSettingConflicts,
  serializeStudyEvent,
  validateStudyEvent,
  type EventConflict,
  type StudyEvent,
} from './syncDomain';
import type { StudyState } from './types';

const MAX_BANK_SIZE_BYTES = 10 * 1024 * 1024;
const INITIAL_SNAPSHOT_ID = 'initial';
const MANIFEST_ID = 'manifest';

export type CloudManifest = {
  schemaVersion: 1;
  bankId: string;
  bankHash: string;
  storagePath: string;
  questionCount: number;
  updatedAt: string;
};

type CloudInitialSnapshot = {
  schemaVersion: 1;
  bankId: string;
  bankHash: string;
  deviceId: string;
  createdAt: string;
  progress: StudyState;
};

export type CloudBundle = {
  manifest: CloudManifest;
  bank: QuestionBank;
  initialState: StudyState;
  events: StudyEvent[];
};

export type SyncResult = {
  state: StudyState;
  metadata: LocalSyncMetadata;
  eventCount: number;
  pendingUploaded: number;
  acknowledgedEventIds: string[];
  stillPendingEvents: StudyEvent[];
  conflicts: EventConflict[];
};

function requireServices(): { database: NonNullable<typeof firebaseDatabase>; storage: NonNullable<typeof firebaseStorage> } {
  if (!firebaseDatabase || !firebaseStorage) throw new Error('Firebase設定がありません。クラウド同期は無効です。');
  return { database: firebaseDatabase, storage: firebaseStorage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{64}$/iu.test(value);
}

function userDocumentPath(userId: string, collectionName: 'sync' | 'snapshots', documentId: string): string {
  return `users/${userId}/${collectionName}/${documentId}`;
}

function manifestReference(userId: string): DocumentReference {
  const { database } = requireServices();
  return doc(database, userDocumentPath(userId, 'sync', MANIFEST_ID));
}

function snapshotReference(userId: string): DocumentReference {
  const { database } = requireServices();
  return doc(database, userDocumentPath(userId, 'snapshots', INITIAL_SNAPSHOT_ID));
}

function eventsCollection(userId: string) {
  const { database } = requireServices();
  return collection(database, `users/${userId}/events`);
}

function isObjectNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'storage/object-not-found';
}

async function verifyStoredBank(storagePath: string, bytes: Uint8Array, bankHash: string, bankId: string): Promise<void> {
  const { storage } = requireServices();
  const storageReference = ref(storage, storagePath);
  const metadata = await getMetadata(storageReference);
  if (
    metadata.contentType !== 'application/json'
    || metadata.customMetadata?.bankHash !== bankHash
    || metadata.customMetadata?.bankId !== bankId
    || metadata.size !== bytes.byteLength
  ) {
    throw new Error('同じ問題バンクIDのクラウドファイルが別内容です。既存データを上書きしません。');
  }
  const storedBytes = new Uint8Array(await getBytes(storageReference, MAX_BANK_SIZE_BYTES));
  if (storedBytes.length !== bytes.length || storedBytes.some((part, index) => part !== bytes[index])) {
    throw new Error('クラウド保存済みの問題バンクがハッシュIDと一致しません。既存データを上書きしません。');
  }
}

async function uploadBankOnce(storagePath: string, bytes: Uint8Array, bankHash: string, bankId: string): Promise<void> {
  const { storage } = requireServices();
  try {
    await verifyStoredBank(storagePath, bytes, bankHash, bankId);
    return;
  } catch (error) {
    if (!isObjectNotFound(error)) throw error;
  }

  try {
    await uploadBytes(ref(storage, storagePath), bytes, {
      contentType: 'application/json',
      customMetadata: { bankHash, bankId },
    });
  } catch (uploadError) {
    // Two devices can race to create the exact same content-addressed object.
    try {
      await verifyStoredBank(storagePath, bytes, bankHash, bankId);
      return;
    } catch {
      throw uploadError;
    }
  }
}

export async function hashQuestionBank(bank: QuestionBank): Promise<{ bankHash: string; bankId: string }> {
  const canonicalBank = JSON.stringify(validateQuestionBank(bank));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalBank));
  const bankHash = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
  return { bankHash, bankId: bankIdForHash(bankHash) };
}

function parseManifest(value: unknown, userId: string): CloudManifest {
  if (!isRecord(value)) throw new Error('クラウドの問題バンク情報を読み取れません。');
  if (
    value.schemaVersion !== 1 || !isSha256(value.bankHash) || value.bankId !== bankIdForHash(value.bankHash)
    || value.storagePath !== `users/${userId}/banks/${value.bankId}.json`
    || !Number.isSafeInteger(value.questionCount) || (value.questionCount as number) < 1
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error('クラウドの問題バンク情報が不正です。ローカルデータは変更していません。');
  }
  return value as CloudManifest;
}

function parseInitialSnapshot(value: unknown, manifest: CloudManifest): CloudInitialSnapshot {
  if (!isRecord(value) || !isRecord(value.progress) || !isRecord(value.progress.records)) {
    throw new Error('クラウドの初期学習データを読み取れません。');
  }
  if (
    value.schemaVersion !== 1 || value.bankId !== manifest.bankId || value.bankHash !== manifest.bankHash
    || typeof value.deviceId !== 'string' || typeof value.createdAt !== 'string'
    || value.progress.schemaVersion !== 2
  ) {
    throw new Error('クラウドの初期学習データと問題バンクが一致しません。ローカルデータは変更していません。');
  }
  return {
    schemaVersion: 1,
    bankId: manifest.bankId,
    bankHash: manifest.bankHash,
    deviceId: value.deviceId,
    createdAt: value.createdAt,
    progress: normalizeState(value.progress, new Set(), true),
  };
}

async function loadRemoteState(userId: string): Promise<{
  manifest: CloudManifest;
  initialState: StudyState;
  events: StudyEvent[];
} | null> {
  const manifestSnapshot = await getDoc(manifestReference(userId));
  if (!manifestSnapshot.exists()) return null;
  const manifest = parseManifest(manifestSnapshot.data(), userId);
  const initialSnapshot = await getDoc(snapshotReference(userId));
  if (!initialSnapshot.exists()) throw new Error('クラウド初期データが見つかりません。既存データは変更していません。');
  const initial = parseInitialSnapshot(initialSnapshot.data(), manifest);
  const eventSnapshots = await getDocs(eventsCollection(userId));
  const events = eventSnapshots.docs.map((snapshot) => {
    const event = validateStudyEvent(snapshot.data());
    if (snapshot.id !== event.eventId) throw new Error('クラウドの学習イベントIDが一致しません。');
    return event;
  });
  return {
    manifest,
    initialState: initial.progress,
    events: deduplicateStudyEvents(events),
  };
}

export async function checkCloudManifest(user: User): Promise<CloudManifest | null> {
  const snapshot = await getDoc(manifestReference(user.uid));
  return snapshot.exists() ? parseManifest(snapshot.data(), user.uid) : null;
}

export async function migrateLocalDataToCloud(
  user: User,
  bank: QuestionBank,
  state: StudyState,
  deviceId: string,
): Promise<LocalSyncMetadata> {
  const { database } = requireServices();
  const checkedBank = validateQuestionBank(bank);
  const { bankHash, bankId } = await hashQuestionBank(checkedBank);
  const storagePath = `users/${user.uid}/banks/${bankId}.json`;
  const bankBytes = new TextEncoder().encode(JSON.stringify(checkedBank));
  if (bankBytes.byteLength > MAX_BANK_SIZE_BYTES) throw new Error('問題バンクが10MBを超えるため、クラウドへ保存できません。');

  if ((await getDoc(manifestReference(user.uid))).exists() || (await getDoc(snapshotReference(user.uid))).exists()) {
    throw new Error('このGoogleアカウントには既にクラウドデータがあります。初回移行で上書きしません。クラウドから取り込んでください。');
  }

  // Upload first. If Firestore initialization loses a race, this immutable hash path is an orphan only;
  // neither the existing cloud manifest nor the device's IndexedDB is replaced.
  await uploadBankOnce(storagePath, bankBytes, bankHash, bankId);

  const manifest: CloudManifest = {
    schemaVersion: 1,
    bankId,
    bankHash,
    storagePath,
    questionCount: checkedBank.questions.length,
    updatedAt: new Date().toISOString(),
  };
  const initialSnapshot: CloudInitialSnapshot = {
    schemaVersion: 1,
    bankId,
    bankHash,
    deviceId,
    createdAt: new Date().toISOString(),
    progress: state,
  };

  await runTransaction(database, async (transaction) => {
    const [remoteManifest, remoteSnapshot] = await Promise.all([
      transaction.get(manifestReference(user.uid)),
      transaction.get(snapshotReference(user.uid)),
    ]);
    if (remoteManifest.exists() || remoteSnapshot.exists()) {
      throw new Error('別端末が先にクラウド初期化を完了しました。既存のクラウドデータは変更していません。');
    }
    transaction.set(manifestReference(user.uid), manifest);
    transaction.set(snapshotReference(user.uid), initialSnapshot);
  });

  return {
    schemaVersion: 1,
    userId: user.uid,
    bankId,
    bankHash,
    knownEventIds: [],
  };
}

export async function downloadCloudBundle(user: User): Promise<CloudBundle> {
  const { storage } = requireServices();
  const remote = await loadRemoteState(user.uid);
  if (!remote) throw new Error('クラウドに初回移行データがありません。');
  const bytes = await getBytes(ref(storage, remote.manifest.storagePath), MAX_BANK_SIZE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('クラウドの問題バンクJSONを読み取れません。ローカルデータは変更していません。');
  }
  const bank = validateQuestionBank(parsed);
  ensureEventsBelongToBank(remote.events, bank);
  const identity = await hashQuestionBank(bank);
  if (identity.bankHash !== remote.manifest.bankHash || identity.bankId !== remote.manifest.bankId) {
    throw new Error('問題バンクの内容ハッシュがクラウドのメタデータと一致しません。ローカルデータは変更していません。');
  }
  if (bank.questions.length !== remote.manifest.questionCount) throw new Error('問題バンクの問題数がクラウドのメタデータと一致しません。');
  return { ...remote, bank };
}

function ensureEventsBelongToBank(events: readonly StudyEvent[], bank: QuestionBank): void {
  const questionIds = new Set(bank.questions.map((question) => question.id));
  const invalidEvent = events.find((event) => !questionIds.has(event.questionId));
  if (invalidEvent) {
    throw new Error(`学習イベントの問題ID「${invalidEvent.questionId}」が問題バンクにありません。問題バンクを混ぜず、ローカルデータは変更していません。`);
  }
}

async function writeEventIdempotently(userId: string, event: StudyEvent): Promise<void> {
  const { database } = requireServices();
  const eventReference = doc(database, `users/${userId}/events/${event.eventId}`);
  await runTransaction(database, async (transaction) => {
    const existing = await transaction.get(eventReference);
    if (existing.exists()) {
      const saved = validateStudyEvent(existing.data());
      if (serializeStudyEvent(saved) !== serializeStudyEvent(event)) {
        throw new Error(`学習イベントIDが別内容で既に使われています: ${event.eventId}`);
      }
      return;
    }
    transaction.set(eventReference, event);
  });
}

export async function syncLinkedDevice(user: User, bank: QuestionBank, metadata: LocalSyncMetadata, outbox: StudyEvent[]): Promise<SyncResult> {
  if (metadata.userId !== user.uid) throw new Error('この端末は別のGoogleアカウントに紐付いています。バックアップ後にクラウドデータを取り込んでください。');
  const localIdentity = await hashQuestionBank(bank);
  if (localIdentity.bankId !== metadata.bankId || localIdentity.bankHash !== metadata.bankHash) {
    throw new Error('端末の問題バンクが同期時の版と異なります。クラウドと端末のバンクを確認するまで同期を止めました。');
  }

  const remote = await loadRemoteState(user.uid);
  if (!remote) throw new Error('クラウドの初期データがありません。同期情報とクラウド設定を確認してください。');
  if (remote.manifest.bankId !== metadata.bankId || remote.manifest.bankHash !== metadata.bankHash) {
    throw new Error('クラウドと端末の問題バンクが異なります。履歴を混ぜず、同期を止めました。');
  }

  let pending = deduplicateStudyEvents([...outbox, ...await loadStudyEventOutbox()]);
  ensureEventsBelongToBank([...remote.events, ...pending], bank);
  const initialPendingEvents = pending;
  const initialPendingIds = new Set(initialPendingEvents.map((event) => event.eventId));
  const knownIds = new Set(metadata.knownEventIds);

  let refreshed = remote;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const remoteIds = new Set(refreshed.events.map((event) => event.eventId));
    for (const event of pending) {
      if (!remoteIds.has(event.eventId)) await writeEventIdempotently(user.uid, event);
    }
    // Re-read after writes so a timeout/retry or another device cannot double-count an event.
    const nextRemote = await loadRemoteState(user.uid);
    if (!nextRemote) throw new Error('クラウドの初期データを再確認できませんでした。未同期イベントは端末に保持しています。');
    refreshed = nextRemote;
    const latestOutbox = await loadStudyEventOutbox();
    const delivered = new Set(refreshed.events.map((event) => event.eventId));
    pending = latestOutbox.filter((event) => !delivered.has(event.eventId));
    if (pending.length === 0) break;
  }

  const deliveredIds = new Set(refreshed.events.map((event) => event.eventId));
  const latestOutbox = await loadStudyEventOutbox();
  const stillPendingEvents = deduplicateStudyEvents(latestOutbox.filter((event) => !deliveredIds.has(event.eventId)));
  const state = applyStudyEvents(refreshed.initialState, [...refreshed.events, ...stillPendingEvents]);
  const localEventsForConflict = deduplicateStudyEvents([...initialPendingEvents, ...latestOutbox]);
  const localEventIds = new Set(localEventsForConflict.map((event) => event.eventId));
  const remoteNew = refreshed.events.filter((event) => !knownIds.has(event.eventId) && !localEventIds.has(event.eventId));
  const conflicts = findConcurrentSettingConflicts(localEventsForConflict, remoteNew);

  return {
    state,
    metadata: {
      schemaVersion: 1,
      userId: user.uid,
      bankId: refreshed.manifest.bankId,
      bankHash: refreshed.manifest.bankHash,
      knownEventIds: [...deliveredIds],
    },
    eventCount: refreshed.events.length,
    pendingUploaded: [...initialPendingIds].filter((id) => deliveredIds.has(id)).length,
    acknowledgedEventIds: [...deliveredIds],
    stillPendingEvents,
    conflicts,
  };
}
