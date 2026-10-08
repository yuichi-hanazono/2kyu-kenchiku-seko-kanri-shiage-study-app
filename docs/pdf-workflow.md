# CIC教材PDFの取り込み手順

## 目的と安全策

PDF取り込みツールは、文書メタデータ、PDFページ数、ページごとのテキストレイヤー、PDFしおり、目次・章立ての候補を記録します。文字レイヤーが少ないページは、設定に応じて画像化しOCRを試します。

取り込み段階では問題文、選択肢、正答、解説を作成しません。抽出文字は原本の内容を示す候補にとどめ、指定した5〜10ページを原本PDFと照合した後に、人が問題データを登録します。OCR信頼度や文字数だけで抽出精度を合格判定する機能はありません。

## 前提環境

- Node.jsが使えること。
- PDF.jsのNodeパッケージ pdfjs-dist が、このスクリプトから解決できること。現在のworkspaceでは共通のnode_modulesから利用できます。package.jsonとsrcはこの取り込み基盤では変更しません。
- OCRを使う場合はPopplerの pdftoppm がPATHにあること。別の場所にある場合は環境変数 PDFTOPPM_BIN に実行ファイルの絶対パスを指定します。
- OCRはTesseract.jsを使用します。jpn+eng の学習データを初めて取得する際にネットワーク接続が必要です。保存先は既定でOSの一時フォルダ配下の building-management-study-app-tesseract-cache です。学習データの配信先を変える場合は --lang-path でURLを指定できます。
- OCR学習データは教材PDFとは別のデータです。教材PDFや抽出結果を外部送信する処理はありません。

この実装はPDF.jsの公式Nodeサンプルに沿ってメタデータとテキストレイヤーを取得し、PDFしおりを候補として記録します。OCRはTesseract.jsのworkerを再利用して画像ページを処理します。

## 実行例

building-management-study-app のルートで、PDFから離れた出力先を指定して実行します。ページ番号はPDF上の1始まりです。

~~~powershell
node .\tools\pdf-intake.mjs "C:\Users\yuichi-hanazono\Downloads\CIC教材.pdf" --verify-pages 1-5 --out ".\pdf-intake-output\CIC教材-初回" --ocr auto --lang jpn+eng
~~~

離れた範囲から選ぶ場合は、5〜10個の異なるページ番号を列挙します。

~~~powershell
node .\tools\pdf-intake.mjs ".\教材.pdf" --verify-pages 2,18,46,103,207,310
~~~

指定した出力先が空でない場合や、出力先自体がシンボリックリンクの場合は停止します。空の既存フォルダーは使えますが、生成する各ファイルも既存名を上書きしない方式で作成します。処理が途中で失敗して一部ファイルが残った場合は、そのフォルダーを確認し、再実行時は新しい出力先を指定してください。

### OCRオプション

- auto（既定）: 文字レイヤーの非空文字がしきい値未満のページだけOCRします。
- always: 全ページをOCRします。
- off: OCRせず、文字レイヤーの有無だけを記録します。
- lang は既定で jpn+eng です。教材が日本語のみの場合は jpn にできます。
- 既定のOCR解像度は240 DPIです。処理時間や文字の細かさに応じて --dpi で150〜600の範囲に調整できます。

## 出力ファイル

| ファイル | 内容 |
| --- | --- |
| intake-report.json | SHA-256、ファイル情報、PDFメタデータ、ページ数、文字レイヤー/OCR判定、しおり・目次・見出し候補、確認待ち状態 |
| page-text.jsonl | PDFページごとの元テキスト、OCRテキスト、採用テキスト、抽出方法、品質確認用の文字数 |
| verification.md | 指定した5〜10ページの抽出テキストと、原本照合・欠落記録欄 |
| question-candidates.json | statusがawaiting_human_confirmation、questionsが空配列の問題データ待ちファイル |

目次行のページ番号は印刷ページ番号の候補として保存し、PDFページ番号へ自動変換しません。しおりや見出しも候補であり、正式な章構成ではありません。候補には必ず原本での確認が必要です。

## 精度確認の進め方

1. verification.md に記録されたPDFページを原本で開き、文字の抜け・順序・誤認識を照合します。
2. 表、図、数式、二段組、縦書き、脚注があるページを選んだ場合は、文字列だけでなく画像上の配置も確認します。
3. OCR結果が空、またはOCR信頼度が低いページは、原本を見ながら手で転記し、OCR結果をそのまま問題文に流用しません。
4. 目次・見出し候補を教材の目次と照合し、採用・修正・却下を記録します。
5. 人が問題文・選択肢・正答・解説を確認して初めて問題レコードを作ります。出典には tools/question.schema.json 案に従い、ファイル名、SHA-256、PDFページ、教材上のページ表示、該当テキスト、抽出方法、確認状況を保存します。

question-candidates.json は現状常に空の配列です。将来問題レコードを作る際も、問題の意味や正答をOCRの欠落から推測して補う運用にはしません。

## JSONスキーマ案

tools/question.schema.json は個々の人手確認済み問題レコードの案です。出典は複数ページを保持でき、問題、選択肢、正答、解説、図表の根拠ページを別々に引用できます。PDFページ番号と教材に印刷されたページ表示は別フィールドです。確認待ちレコードでは内容を空のまま保留でき、verifiedへ変更する際は問題文が必須になります。

## 制限と未検証事項

- 教材PDFがまだないため、実際のCIC教材での抽出結果、しおり、目次構成、OCR精度は未検証です。
- PDFテキストレイヤーの存在から、文字がOCR由来か元からのデジタル文字かを厳密には区別できません。そのため「検索可能な文字あり」として記録します。
- 5〜10ページの精度確認は人が原本と照合するための記録です。正解テキストとの自動比較や精度スコアはありません。
- 図表内の文字、手書き、複雑な段組、数式、回転文字はOCRで崩れることがあります。
- Tesseract.jsの学習データ取得やCIC教材でのOCR実行は、PDF未提供のため未検証です。

## 公式参考資料

- [PDF.js Node.jsサンプル](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/)
- [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)
- [Tesseract.js Node.jsセットアップ](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)
