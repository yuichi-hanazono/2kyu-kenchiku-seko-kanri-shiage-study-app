# 施工管理 学習室

推奨リポジトリ名: `2kyu-kenchiku-seko-kanri-shiage-study-app`

React、TypeScript、Viteで作成した、スマートフォン対応の学習Webアプリ最小実装です。

本番ビルドはPWAとしてスマートフォンのホーム画面へ追加できます。GitHub Pages等へ配置する場合も、教材由来の問題文・OCR本文・答案例を公開リポジトリへ含めないでください。公開版にはサンプルデータだけを含め、検証済みの非公開問題バンクはスマートフォン側から読み込みます。

## 起動方法

```bash
pnpm install --ignore-scripts
pnpm dev
```

本番用のビルド確認:

```bash
pnpm build
```

GitHub Pagesへの公開準備:

- `.github/workflows/deploy-pages.yml` が`main`へのpush後に本番ビルドを作成します。
- リポジトリ設定の Pages で、公開元を「GitHub Actions」に一度設定します。
- 公開後はスマートフォンのブラウザーでURLを開き、「ホーム画面に追加」を選べます。
- 問題データと学習履歴はIndexedDBに保存され、Firebaseを設定するとGoogleアカウント経由で端末間同期できます。未設定時は従来どおりローカルのみで動作します。

## スマホ・PC間の同期設定

同期を使うと、問題バンク本体は認証ユーザー専用のFirebase Storageパスに、学習イベントと同期メタデータはFirestoreに保存します。サンプル版・ローカル学習はFirebase設定なしでも利用できます。Firebase Web設定はブラウザーへ配布される公開クライアント設定であり、管理者キー・サービスアカウント鍵は使用しません。

### Firebaseプロジェクト

1. Firebase ConsoleでプロジェクトとWebアプリを作成し、AuthenticationのGoogleプロバイダを有効にします。
2. Firestore Databaseを作成し、`firestore.rules`をデプロイします。リージョンは利用者に近い場所を選んでください。
3. Cloud Storageのバケットを作成し、`storage.rules`をデプロイします。Cloud Storage for Firebaseの利用には従量課金のBlazeプランが必要です（Blazeでも対象範囲の無料利用枠はあります）。料金・利用量を確認してから有効化してください。[Firebaseの料金要件](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)
4. Firebase Authenticationの「設定」→「承認済みドメイン」に `yuichi-hanazono.github.io` を追加します。開発時は `localhost` も追加してください（最近作成したFirebaseプロジェクトではlocalhostが初期登録されない場合があります）。Googleプロバイダの有効化と承認済みドメインが必要です。[Googleログインの公式手順](https://firebase.google.com/docs/auth/web/google-signin)
5. `tools/firebase-storage-cors.json`を使い、ブラウザーから非公開バケットを直接取得するためのCORSを設定します（gcloud CLIが必要です）。[WebからのStorage取得にはCORS設定が必要です](https://firebase.google.com/docs/storage/web/download-files)

```powershell
gcloud storage buckets update gs://<FirebaseのStorageバケット名> --cors-file=tools/firebase-storage-cors.json
```

Firestore / StorageルールはFirebase CLIでデプロイできます。プロジェクトIDはFirebase Consoleのプロジェクト設定から指定してください。

```powershell
pnpm dlx firebase-tools login
pnpm dlx firebase-tools deploy --only firestore:rules,storage --project <FirebaseプロジェクトID>
```

6. ローカル開発ではFirebase Consoleのプロジェクト設定にあるWebアプリ設定を使い、`.env.example`を参考に`.env`を作成します。APIキー、認証ドメイン、プロジェクトID、Storageバケット名、アプリIDを`VITE_FIREBASE_*`へ設定して`pnpm dev`を起動します。`.env`はGitへ登録しません。
7. GitHub Pagesでは、リポジトリのSettings → Secrets and variables → Actions → Variablesに次の変数を追加し、`main`へ反映して再デプロイします。これらは公開クライアント設定なのでActionsの「Variables」を使い、Admin SDK鍵やサービスロール鍵は登録しないでください。

```text
FIREBASE_API_KEY
FIREBASE_AUTH_DOMAIN
FIREBASE_PROJECT_ID
FIREBASE_STORAGE_BUCKET
FIREBASE_APP_ID
```

Firebase設定が不足しているビルドでは、アプリに不足項目を表示してクラウド機能のみ無効にします。

### 初回移行と2台目の利用

1. **移行元のスマホ**で現在使っている非公開JSON問題バンクが読み込まれていることを確認し、Googleログインします。
2. 「端末全体をバックアップ」を押して、問題バンク・学習履歴を含むJSONを安全な場所へ保存します。画面にバックアップ済みと出てから「この端末から初回移行」を選びます。初回移行は既存クラウドデータを上書きせず、問題バンクの内容ハッシュと初期StudyStateスナップショットを登録します。
3. **PC**で同じGitHub Pages URLを開き、同じGoogleアカウントでログインします。PCに残っているローカルデータがあれば、先に端末全体バックアップを作成し、「クラウドからこの端末へ取得」を明示実行します。取得するとPCの問題バンク・学習状態を置き換えますが、問題バンクを混ぜず、取得中にローカルデータが変わった場合は保存を中止します。
4. 以降、オンライン時は学習イベントを自動同期します。必要なら「今すぐ同期」を押します。スマホ・PCのどちらでもオフライン学習は続けられ、再接続時に同期します。

学習イベントはUUIDをFirestoreドキュメントIDとして保存し、同じイベントの再送は冪等に処理します。クラウド同期時もStudyState全体を上書きせず、初回スナップショットへイベントを適用します。違う問題バンクのままでは同期せず、別バンクへ切り替える場合はバックアップ後に明示的なクラウド取得を行います。同じ問題の評価・苦手設定が別端末で競合したときは警告し、イベント履歴は保持します。

同期済み端末で別版の問題JSONを直接読み込む操作は、学習履歴を別バンクへ混ぜないため停止します。問題バンクを更新する場合は、同期成功を確認して未同期イベントをなくした後、右上の通常の「バックアップ」で学習データJSONを保存し、そのJSONを「復元」してクラウドとの端末紐付けを解除してから新しいJSONを読み込んでください（通常JSONの復元は現在の問題バンクを残したまま連携を解除します）。クラウド側の問題バンク版更新フローは後続対応です。

### 教材データについて

初回移行すると、非公開問題バンクJSONの内容全体がFirebase Storageへ送られます。Firestoreには問題バンクID・SHA-256・問題数・更新時刻と、初期移行時の学習状態、各学習イベントを保存します。Firebaseの管理者やプロジェクトへアクセス権を持つ人から教材データを秘匿する仕組みではありません。教材・出版社の利用条件、第三者への複製・クラウド保管の可否、データ保管地域、バックアップの保管方法を確認してから移行してください。問題バンクのJSONや教材原本は公開リポジトリへ登録しないでください。

教材PDFの初回取り込み確認（教材PDFはリポジトリ外に保管）:

```bash
pnpm pdf:intake "C:\\Users\\<ユーザー名>\\Downloads\\CIC教材.pdf" --verify-pages 1-5 --out "./pdf-intake-output/初回確認" --ocr auto
```

OCR対象を限定する場合は、元PDFのページ番号で指定します。教材全体をOCRせず、仕上げ範囲を段階的に確認できます。

```powershell
pnpm pdf:intake "C:\\Users\\<ユーザー名>\\Desktop\\CIC教材.pdf" --verify-pages 222-226 --ocr always --ocr-pages 222-226 --dpi 300 --out "./pdf-intake-output/仕上げ初回確認"
```

`verification.md`を原本PDFと目視照合するまで、問題データは登録しません。教材の問題文・正答・OCR結果を公開リポジトリへ追加しないでください。

全ページの受け入れOCRは2026-10-10に実施済みです。286ページ中286ページがOCR完了、失敗0ページでした。OCR成果物と確認用画像はリポジトリ外の作業フォルダーに保存しています。OCR完了は問題データの正確性を意味しないため、問題文・選択肢・数値・否定表現・正答を原画像と別根拠で確認してから、非公開問題バンクへ登録します。

## 実装済み

- ホームの学習状況ダッシュボード
- 今日の学習リスト
- 初回学習（解答・解説を先に表示し、正誤判定なし）
- 暗記確認（解答表示後に○・△・×を記録）
- 4択演習（選択後に正誤・解説を表示）
- 記述式暗記（出版社参考答案との自己確認、任意の必須キーワード照合、○△×記録。自動採点なし）
- 問題番号フィルター（記述式の問題2・3、4択の問題4などを指定して学習）
- 苦手問題の登録と一覧
- IndexedDBへの学習状況保存
- JSON形式のバックアップと復元
- 初回学習と暗記確認・4択・記述式の回数を分けた履歴、4択の正誤・連続正解・前回結果、次回復習日の保存
- 小さい画面に対応したレイアウト

## 学習履歴と既存データの移行

初回学習の完了日時・回数と、暗記確認・4択・記述式のテスト回数は別々に保存します。4択の正答数・不正解数・連続正解数・前回結果も記録し、○は7日後、△は3日後、×または4択不正解は翌日を次回復習日に設定します。初回学習は4択の正答率集計に含めません。

schemaVersion 1の既存データとバックアップは読み込めます。旧データの`attempts`は初回学習とテストが混在していて内訳を判別できないため、「旧記録」として合計回数の表示に残し、新しい分類別回数や4択正誤数には割り当てません。読み込み後はschemaVersion 2で保存します。不明な形式の保存データは上書きしません。

## サンプル問題について

`data/sample/questions.json` は「sample/AI作成練習問題」と明記した、画面動作確認用の仮データです。公式過去問・実際の教材の内容ではなく、実問題を推測して作成したものも含みません。実際の学習に使う前に、利用許諾と内容を確認した問題データへ差し替えてください。

学習データは利用中のブラウザー内に保存されます。ブラウザーのデータ消去や別端末への移行に備え、画面右上からJSONバックアップを保存できます。復元すると現在の学習データはバックアップの内容に置き換わります。

## 現時点の範囲

これは教材PDF受け入れと非公開問題バンク整備を進めるPhase 1です。仕上げの対象範囲は、基礎テキストがPDF 222〜232、過去問5-CがPDF 236〜259、解答・補足解説がPDF 262〜282です。現在の統合用非公開バンクは123問で、問題1が9問、問題2が8年度カード、問題3が30小問、問題4が33問、問題5-Cが43問です。内訳は4択70問、記述式53問です。

花園さんの確認により、CIC教材の参考答案を学習上の正答として採用しています。ただし、公式正答と混同しないよう、問題4・問題5-Cの一部旧年度4択は「出版社参考答案（学習上の正答）」として登録し、画面・データ上で公式正答と明確に区別します。問題4の令和4〜平成30年度は、教材の出題形式に合わせて記述式カードとして登録しています。推測による問題文・正答の補完は行いません。

ブラウザーの「問題読込」から、検証済みの非公開JSON問題バンクを読み込めます。読み込んだ教材由来データはIndexedDBへ保存されますが、問題文・OCR本文・答案例を公開GitHubへ追加しない運用です。記述式は問題文と出版社参考答案の出典ページを照合したうえで、4択と分けて記述式画面へ登録できます。ChatGPT分析用JSONの入出力、回答時間・メモの保存、分野別の自動チューニングは後続Phaseで検討します。

### 問題バンクの形式

`tools/question-bank.schema.json` はschemaVersion 1の4択・記述式混在バンクを定義します。4択問題は`answer`、4件の`choices`、`correctChoice`が必要で、正答根拠は`official_key_verified`（公式正答照合済み）または`publisher_reference_only`（出版社参考答案のみ）を明示します。記述式はそれらを持たず、`publisher_reference_answer`に答案本文、出版社名、資料名、答案の出典資料とページ引用を入れます。引用の役割は`publisher_reference_answer`、確認状態は`verified`にします。必要に応じて`requiredKeywords`へキーワードを登録できます。

問題本文の`source`と答案側の`publisher_reference_answer.source`は、それぞれ資料情報・ページ引用が必要です。すべての問題は`reviewStatus: "verified"`、`distribution: "private_only"`でなければ読み込めません。4択演習には4択だけ、記述式暗記には記述式だけを表示し、ホームなどの問題数・進捗は両方を集計します。キーワード照合は入力文に文字列が含まれるかの表示で、正誤や採点を行いません。
