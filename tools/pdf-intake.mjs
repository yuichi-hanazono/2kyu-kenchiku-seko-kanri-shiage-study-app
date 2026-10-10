#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const TOOL_VERSION = '1.0.0';
const DEFAULT_MIN_TEXT_CHARS = 30;
const DEFAULT_TOC_SCAN_PAGES = 30;
const DEFAULT_OCR_DPI = 240;

function printHelp() {
  console.log([
    'PDF教材の受け入れ確認を行います。問題文や正答は生成しません。',
    '',
    'Usage:',
    '  node tools/pdf-intake.mjs <input.pdf> --verify-pages 1-5 [options]',
    '',
    'Options:',
    '  --verify-pages <pages>  目視照合するPDFページを5〜10ページ指定。例: 1-5 または 2,8,15,22,30',
    '  --ocr-pages <pages|all> OCR対象ページを追加で限定。例: 150-154、allは制限なし（元PDFの1始まり）',
    '  --out <directory>       出力先。省略時は ./pdf-intake-output/<PDF名>-<hash8>',
    '  --ocr <auto|always|off> 文字レイヤーが薄いページのOCR方法 (default: auto)',
    '  --lang <codes>          OCR言語 (default: jpn+eng)',
    '  --lang-path <URL>       言語データ配信元URL。末尾に / を付けない',
    '  --dpi <number>          OCR用画像の解像度 150〜600 (default: 240)',
    '  --min-text-chars <n>    OCR判定の文字数しきい値 (default: 30)',
    '  --toc-scan-pages <n>    目次候補を探す先頭ページ数 (default: 30)',
    '  --cache-dir <directory> Tesseract.jsの言語データキャッシュ先',
    '  --help                  この説明を表示',
    '',
    '出力はPDFページ番号（1始まり）を保持し、確認待ちとして記録されます。',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {
    input: null,
    verifyPagesSpec: null,
    ocrPageSelection: null,
    outDir: null,
    ocrMode: 'auto',
    languages: 'jpn+eng',
    langPath: null,
    dpi: DEFAULT_OCR_DPI,
    minTextChars: DEFAULT_MIN_TEXT_CHARS,
    tocScanPages: DEFAULT_TOC_SCAN_PAGES,
    cacheDir: path.join(os.tmpdir(), 'building-management-study-app-tesseract-cache'),
    help: false,
  };
  const valueOptions = new Set([
    '--verify-pages',
    '--ocr-pages',
    '--out',
    '--ocr',
    '--lang',
    '--lang-path',
    '--dpi',
    '--min-text-chars',
    '--toc-scan-pages',
    '--cache-dir',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      if (!valueOptions.has(arg)) {
        throw new Error('未対応のオプションです: ' + arg);
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('オプション ' + arg + ' の値を指定してください。');
      }
      index += 1;
      if (arg === '--verify-pages') options.verifyPagesSpec = value;
      if (arg === '--ocr-pages') options.ocrPageSelection = parseOcrPageSelection(value);
      if (arg === '--out') options.outDir = value;
      if (arg === '--ocr') options.ocrMode = value;
      if (arg === '--lang') options.languages = value;
      if (arg === '--lang-path') options.langPath = value;
      if (arg === '--dpi') options.dpi = Number(value);
      if (arg === '--min-text-chars') options.minTextChars = Number(value);
      if (arg === '--toc-scan-pages') options.tocScanPages = Number(value);
      if (arg === '--cache-dir') options.cacheDir = value;
      continue;
    }
    if (options.input) {
      throw new Error('入力PDFは1つだけ指定してください。');
    }
    options.input = arg;
  }

  if (options.help) return options;
  if (!options.input) throw new Error('入力PDFを指定してください。');
  if (!options.verifyPagesSpec) {
    throw new Error('--verify-pages で目視照合する5〜10ページを指定してください。');
  }
  if (!['auto', 'always', 'off'].includes(options.ocrMode)) {
    throw new Error('--ocr は auto、always、off のいずれかを指定してください。');
  }
  if (!Number.isInteger(options.dpi) || options.dpi < 150 || options.dpi > 600) {
    throw new Error('--dpi は150〜600の整数を指定してください。');
  }
  if (!Number.isInteger(options.minTextChars) || options.minTextChars < 0) {
    throw new Error('--min-text-chars は0以上の整数を指定してください。');
  }
  if (!Number.isInteger(options.tocScanPages) || options.tocScanPages < 1 || options.tocScanPages > 100) {
    throw new Error('--toc-scan-pages は1〜100の整数を指定してください。');
  }
  if (!/^[A-Za-z0-9_+-]+$/.test(options.languages)) {
    throw new Error('--lang は言語コードを + 区切りで指定してください。');
  }
  options.input = path.resolve(options.input);
  if (options.outDir) options.outDir = path.resolve(options.outDir);
  options.cacheDir = path.resolve(options.cacheDir);
  if (options.langPath && options.langPath.endsWith('/')) {
    throw new Error('--lang-path の末尾に / は付けないでください。');
  }
  return options;
}

function parsePageSelection(spec) {
  const pages = new Set();
  for (const rawPart of spec.split(/[、,]/u).map((part) => part.trim()).filter(Boolean)) {
    const rangeMatch = rawPart.match(/^(\d+)\s*-\s*(\d+)$/u);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new Error('ページ範囲が不正です: ' + rawPart);
      }
      if (end - start > 9) {
        throw new Error('--verify-pages は重複を除いて5〜10ページを指定してください。');
      }
      for (let page = start; page <= end; page += 1) {
        pages.add(page);
        if (pages.size > 10) {
          throw new Error('--verify-pages は重複を除いて5〜10ページを指定してください。');
        }
      }
      continue;
    }
    const pageNumber = Number(rawPart);
    if (!/^\d+$/u.test(rawPart) || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      throw new Error('ページ指定が不正です: ' + rawPart);
    }
    pages.add(pageNumber);
    if (pages.size > 10) {
      throw new Error('--verify-pages は重複を除いて5〜10ページを指定してください。');
    }
  }
  const result = [...pages].sort((a, b) => a - b);
  if (result.length < 5 || result.length > 10) {
    throw new Error('--verify-pages は重複を除いて5〜10ページを指定してください。');
  }
  return result;
}

function parseOcrPageSelection(spec) {
  if (spec.trim().toLowerCase() === 'all') return { all: true, ranges: [] };

  const parts = spec.split(/[、,]/u).map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !part)) {
    throw new Error('--ocr-pages は all またはPDFページ番号・範囲を指定してください。');
  }

  const ranges = [];
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/u);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new Error('--ocr-pages のページ範囲が不正です: ' + part);
      }
      ranges.push([start, end]);
      continue;
    }

    const pageNumber = Number(part);
    if (!/^\d+$/u.test(part) || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      throw new Error('--ocr-pages のページ指定が不正です: ' + part);
    }
    ranges.push([pageNumber, pageNumber]);
  }
  return { all: false, ranges };
}

function isOcrPageSelected(pdfPage, selection) {
  return !selection || selection.all || selection.ranges.some(([start, end]) => pdfPage >= start && pdfPage <= end);
}

function describeOcrPageSelection(selection) {
  if (!selection) return null;
  if (selection.all) return 'all';
  return selection.ranges.map(([start, end]) => start === end ? String(start) : start + '-' + end).join(',');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function safeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Array.isArray(value)) return value.map(safeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, safeValue(nested)]));
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return String(value);
}

function extractPageText(items) {
  const parts = [];
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    parts.push(item.str);
    if (item.hasEOL) parts.push('\n');
  }
  return parts.join('').replace(/\r\n?/gu, '\n').replace(/\u0000/gu, '').trimEnd();
}

function countVisibleChars(text) {
  return Array.from(text).filter((char) => !/\s/u.test(char)).length;
}

function getQualitySignals(text) {
  const visibleChars = countVisibleChars(text);
  const replacementChars = (text.match(/\uFFFD/gu) || []).length;
  const controlChars = (text.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/gu) || []).length;
  const lines = text.split('\n').filter((line) => line.trim().length > 0).length;
  return { visibleChars, replacementChars, controlChars, nonEmptyLines: lines };
}

async function runFile(command, args, options = {}) {
  return execFile(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

async function resolveOutlinePage(pdfDocument, destination) {
  try {
    let resolved = destination;
    if (typeof resolved === 'string') resolved = await pdfDocument.getDestination(resolved);
    if (!Array.isArray(resolved) || !resolved[0]) return null;
    return (await pdfDocument.getPageIndex(resolved[0])) + 1;
  } catch {
    return null;
  }
}

async function collectOutline(pdfDocument) {
  const outline = await pdfDocument.getOutline();
  const candidates = [];
  async function walk(items, level) {
    for (const item of items || []) {
      const title = String(item.title || '').trim();
      if (title) {
        candidates.push({
          title,
          pdfPage: await resolveOutlinePage(pdfDocument, item.dest),
          level,
          source: 'pdf_outline',
          reviewStatus: 'awaiting_confirmation',
        });
      }
      if (item.items?.length) await walk(item.items, level + 1);
    }
  }
  await walk(outline, 1);
  return candidates;
}

function collectTextStructureCandidates(pageRecords, tocScanPages) {
  const scanLimit = Math.min(pageRecords.length, tocScanPages);
  const tocPageNumbers = new Set();
  const tocPageCandidates = [];
  const tocEntryCandidates = [];
  const sectionCandidates = [];
  const tocHeadingPattern = /(?:目\s*次|もくじ|table\s+of\s+contents|contents)/iu;
  const headingPattern = /^\s*((?:第[0-9０-９一二三四五六七八九十]+(?:章|節|編|部|項)|chapter\s+[0-9０-９]+|section\s+[0-9０-９]+(?:[.．][0-9０-９]+)*).{0,120})\s*$/iu;
  const tocLinePatterns = [
    /^\s*(.{2,120}?)\s*(?:\.{2,}|…{2,}|･{2,}|・{2,})\s*(?:p\.?\s*)?([0-9０-９]{1,4})\s*$/iu,
    /^\s*((?:第[0-9０-９一二三四五六七八九十]+(?:章|節|編|部)|[0-9０-９]+(?:[.．][0-9０-９]+){0,3})[ \t　]+.{2,100}?)[ \t　]+(?:p\.?\s*)?([0-9０-９]{1,4})\s*$/iu,
  ];

  for (const page of pageRecords.slice(0, scanLimit)) {
    if (tocHeadingPattern.test(page.selectedText)) {
      tocPageNumbers.add(page.pdfPage);
      tocPageCandidates.push({
        pdfPage: page.pdfPage,
        evidence: page.selectedText.match(tocHeadingPattern)?.[0] || '',
        source: 'text_heuristic',
        reviewStatus: 'awaiting_confirmation',
      });
    }
  }
  for (const pageNumber of [...tocPageNumbers]) {
    for (let offset = 1; offset <= 2 && pageNumber + offset <= pageRecords.length; offset += 1) {
      tocPageNumbers.add(pageNumber + offset);
    }
  }

  for (const page of pageRecords) {
    const lines = page.selectedText.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const heading = line.match(headingPattern);
      if (heading) {
        sectionCandidates.push({
          pdfPage: page.pdfPage,
          titleCandidate: heading[1].trim().slice(0, 200),
          source: 'explicit_heading_pattern',
          reviewStatus: 'awaiting_confirmation',
        });
      }
      if (!tocPageNumbers.has(page.pdfPage)) continue;
      for (const pattern of tocLinePatterns) {
        const match = line.match(pattern);
        if (!match) continue;
        tocEntryCandidates.push({
          sourcePdfPage: page.pdfPage,
          titleCandidate: match[1].trim().slice(0, 200),
          printedPageNumberCandidate: match[2].trim(),
          evidence: line.slice(0, 240),
          source: 'toc_line_heuristic',
          reviewStatus: 'awaiting_confirmation',
        });
        break;
      }
    }
  }
  return { tocPageCandidates, tocEntryCandidates, sectionCandidates };
}

function pageTextStatus(visibleChars, threshold) {
  if (visibleChars >= threshold) return 'searchable_text_present_ocr_origin_unknown';
  if (visibleChars > 0) return 'sparse_text_layer_possible_scan_or_graphic';
  return 'no_text_layer_possible_scan';
}

async function getTesseractWorker(options) {
  let library;
  try {
    library = await import('tesseract.js');
  } catch (error) {
    throw new Error('Tesseract.jsを読み込めません。OCRはスキップされます。詳細: ' + error.message);
  }
  await mkdir(options.cacheDir, { recursive: true });
  const workerOptions = {
    cachePath: options.cacheDir,
    cacheMethod: 'write',
    logger: (message) => {
      if (message.status === 'recognizing text' && Number.isFinite(message.progress)) {
        const percent = Math.round(message.progress * 100);
        process.stderr.write('  OCR進捗: ' + percent + '%\r');
      }
    },
  };
  if (options.langPath) workerOptions.langPath = options.langPath;
  const worker = await library.createWorker(options.languages.split('+'), 1, workerOptions);
  process.stderr.write('\n');
  return worker;
}

async function runOcrForPage({ page, inputPath, tempDir, options, workerState }) {
  if (!workerState.rendererAvailable) {
    return { status: 'not_run_missing_pdftoppm', text: '', confidence: null };
  }
  if (workerState.initializationError) {
    return { status: 'not_run_ocr_initialization_failed', text: '', confidence: null, error: workerState.initializationError };
  }
  if (!workerState.worker) {
    try {
      workerState.worker = await getTesseractWorker(options);
    } catch (error) {
      workerState.initializationError = error.message;
      return { status: 'not_run_ocr_initialization_failed', text: '', confidence: null, error: error.message };
    }
  }

  const outputPrefix = path.join(tempDir, 'pdf-page-' + String(page.pdfPage).padStart(5, '0'));
  const imagePath = outputPrefix + '.png';
  try {
    await runFile(process.env.PDFTOPPM_BIN || 'pdftoppm', [
      '-f',
      String(page.pdfPage),
      '-l',
      String(page.pdfPage),
      '-r',
      String(options.dpi),
      '-png',
      '-singlefile',
      inputPath,
      outputPrefix,
    ]);
    const image = await readFile(imagePath);
    const result = await workerState.worker.recognize(image);
    return {
      status: 'ocr_completed_needs_manual_review',
      text: String(result.data.text || '').replace(/\r\n?/gu, '\n').trimEnd(),
      confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : null,
    };
  } catch (error) {
    return { status: 'ocr_failed', text: '', confidence: null, error: error.message };
  } finally {
    await rm(imagePath, { force: true }).catch(() => {});
  }
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function buildVerificationMarkdown({ source, pages, pageRecords, candidates, options }) {
  const lines = [
    '# PDF抽出精度の目視確認',
    '',
    '- 原本: ' + source.fileName,
    '- SHA-256: ' + source.sha256,
    '- 対象PDFページ: ' + pages.join(', '),
    '- 状態: 確認待ち',
    '- 抽出文字数やOCR信頼度だけでは正確性を判定できません。原本PDFと各ページを照合してください。',
    '',
    '## 照合記録',
    '',
  ];
  for (const pageNumber of pages) {
    const page = pageRecords[pageNumber - 1];
    const confidence = page.ocr.confidence === null ? '—' : String(page.ocr.confidence);
    lines.push(
      '### PDFページ ' + page.pdfPage + (page.pageLabel ? '（ページ表示: ' + page.pageLabel + '）' : ''),
      '',
      '- 抽出方法: ' + page.selectedMethod,
      '- 文字レイヤー判定: ' + page.textLayerStatus,
      '- 非空文字数: ' + page.quality.visibleChars,
      '- OCR信頼度: ' + confidence,
      '- 原本と照合: [ ] 完了',
      '- 欠落・誤認識・表/図の問題: ',
      '- 確認者・確認日: ',
      '',
      '<details>',
      '<summary>このページの抽出テキスト</summary>',
      '',
      '<pre><code>' + htmlEscape(page.selectedText) + '</code></pre>',
      '',
      '</details>',
      '',
    );
  }

  lines.push(
    '## 目次・ページ構成の候補',
    '',
    '以下は文字列やPDFしおりから得た候補です。教材の正式な章立てとしては未確定です。',
    '',
    '### 目次ページ候補',
    '',
  );
  if (candidates.tocPageCandidates.length === 0) lines.push('- 候補なし');
  for (const item of candidates.tocPageCandidates) {
    lines.push('- PDFページ ' + item.pdfPage + ': ' + item.evidence);
  }
  lines.push('', '### PDFしおり候補', '');
  if (candidates.outlineCandidates.length === 0) lines.push('- 候補なし');
  for (const item of candidates.outlineCandidates) {
    lines.push('- ' + (item.pdfPage ? 'PDFページ ' + item.pdfPage + ' — ' : '') + item.title);
  }
  lines.push('', '### 目次行・章見出し候補', '');
  if (candidates.tocEntryCandidates.length === 0 && candidates.sectionCandidates.length === 0) {
    lines.push('- 候補なし');
  }
  for (const item of candidates.tocEntryCandidates) {
    lines.push('- 目次候補（PDFページ ' + item.sourcePdfPage + '）: ' + item.evidence);
  }
  for (const item of candidates.sectionCandidates) {
    lines.push('- 見出し候補（PDFページ ' + item.pdfPage + '）: ' + item.titleCandidate);
  }
  lines.push(
    '',
    '## 問題データ',
    '',
    'この取り込みでは問題文・選択肢・正答・解説を生成していません。問題候補の登録は人が原本を確認してから行ってください。',
    '',
    'OCR設定: ' + options.ocrMode + ' / 言語: ' + options.languages + ' / DPI: ' + options.dpi,
    '',
  );
  return lines.join('\n');
}

async function prepareOutputDirectory(outputDir) {
  let outputStat;
  try {
    outputStat = await lstat(outputDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(outputDir, { recursive: true });
    outputStat = await lstat(outputDir);
  }
  if (outputStat.isSymbolicLink()) {
    throw new Error('出力先にシンボリックリンクは指定できません: ' + outputDir);
  }
  if (!outputStat.isDirectory()) {
    throw new Error('出力先がフォルダーではありません: ' + outputDir);
  }
  const entries = await readdir(outputDir);
  if (entries.length > 0) {
    throw new Error('出力先が空ではありません。既存ファイルを保護するため別の --out を指定してください: ' + outputDir);
  }
}

async function writeNewOutputFile(outputDir, fileName, contents) {
  await writeFile(path.join(outputDir, fileName), contents, { encoding: 'utf8', flag: 'wx' });
}

async function run(options) {
  const selectedPages = parsePageSelection(options.verifyPagesSpec);
  const fileStat = await stat(options.input).catch(() => null);
  if (!fileStat?.isFile()) throw new Error('入力PDFが見つからないか、通常ファイルではありません: ' + options.input);
  if (path.extname(options.input).toLowerCase() !== '.pdf') {
    throw new Error('入力ファイルの拡張子がPDFではありません: ' + options.input);
  }

  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    throw new Error('pdfjs-dist を読み込めません。building-management-study-app から Node.js が参照できる場所に必要です。詳細: ' + error.message);
  }

  const pdfBytes = await readFile(options.input);
  if (pdfBytes.length < 5 || pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('PDFヘッダーを確認できません。破損または別形式のファイルの可能性があります。');
  }
  const sourceHash = await sha256File(options.input);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  let pdfDocument;
  let ocrWorker = null;
  let tempDir = null;
  try {
    pdfDocument = await loadingTask.promise;
    const pageCount = pdfDocument.numPages;
    if (selectedPages.some((page) => page > pageCount)) {
      throw new Error('照合指定ページがPDFページ数を超えています。PDFページ数: ' + pageCount);
    }
    if (options.ocrPageSelection && !options.ocrPageSelection.all &&
        options.ocrPageSelection.ranges.some(([, end]) => end > pageCount)) {
      throw new Error('OCR指定ページがPDFページ数を超えています。PDFページ数: ' + pageCount);
    }

    const metadataResult = await pdfDocument.getMetadata();
    const metadata = {
      info: safeValue(metadataResult.info || {}),
      xmp: metadataResult.metadata ? safeValue(Object.fromEntries(metadataResult.metadata)) : {},
      pdfjsFingerprint: pdfDocument.fingerprints?.[0] || null,
    };
    const pageLabels = (await pdfDocument.getPageLabels()) || [];
    const pageRecords = [];
    console.log('PDF情報とページテキストを取得しています: ' + pageCount + 'ページ');

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const nativeText = extractPageText(textContent.items);
      const quality = getQualitySignals(nativeText);
      pageRecords.push({
        pdfPage: pageNumber,
        pageLabel: pageLabels[pageNumber - 1] || null,
        sizePoints: { width: viewport.width, height: viewport.height },
        nativeText,
        selectedText: nativeText,
        selectedMethod: 'pdfjs_text_layer',
        textLayerStatus: pageTextStatus(quality.visibleChars, options.minTextChars),
        quality,
        ocr: { status: 'not_attempted', text: '', confidence: null },
      });
      page.cleanup();
      if (pageNumber % 50 === 0 || pageNumber === pageCount) {
        console.log('  ' + pageNumber + ' / ' + pageCount + 'ページ');
      }
    }

    const rendererAvailable = await runFile(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-v'])
      .then(() => true)
      .catch(() => false);
    const workerState = { worker: null, initializationError: null, rendererAvailable };
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'cic-pdf-intake-'));
    const needsOcr = pageRecords.filter((page) =>
      isOcrPageSelected(page.pdfPage, options.ocrPageSelection) && (
        options.ocrMode === 'always' ||
        (options.ocrMode === 'auto' && page.quality.visibleChars < options.minTextChars)
      ),
    );

    if (options.ocrMode === 'off') {
      for (const page of pageRecords) {
        page.ocr.status = isOcrPageSelected(page.pdfPage, options.ocrPageSelection)
          ? 'disabled_by_option'
          : 'skipped_outside_ocr_page_selection';
      }
    } else {
      for (const page of needsOcr) {
        console.log('OCRを試行します: PDFページ ' + page.pdfPage);
        page.ocr = await runOcrForPage({
          page,
          inputPath: options.input,
          tempDir,
          options,
          workerState,
        });
        if (page.ocr.status === 'ocr_completed_needs_manual_review' && page.ocr.text.trim()) {
          page.selectedText = page.ocr.text;
          page.selectedMethod = 'tesseract_js_ocr';
          page.quality = getQualitySignals(page.selectedText);
        }
        if (page.ocr.status === 'not_run_missing_pdftoppm') {
          page.ocr.error = 'Poppler pdftoppm が見つかりません。PDFページを画像にできないためOCRを実行していません。';
        }
      }
      for (const page of pageRecords) {
        if (page.ocr.status === 'not_attempted') {
          page.ocr.status = !isOcrPageSelected(page.pdfPage, options.ocrPageSelection)
            ? 'skipped_outside_ocr_page_selection'
            : options.ocrMode === 'auto'
              ? 'skipped_text_layer_present'
              : 'not_attempted';
        }
      }
    }
    ocrWorker = workerState.worker;

    for (const page of pageRecords) {
      if (page.ocr.status === 'ocr_completed_needs_manual_review') {
        page.textLayerStatus = page.nativeText.trim()
          ? 'native_text_and_ocr_available'
          : 'ocr_text_available_origin_not_verified';
      } else if (page.ocr.status.startsWith('not_run') || page.ocr.status === 'ocr_failed') {
        page.textLayerStatus = page.textLayerStatus + '_ocr_review_needed';
      }
    }

    const outlineCandidates = await collectOutline(pdfDocument);
    const textCandidates = collectTextStructureCandidates(pageRecords, options.tocScanPages);
    const source = {
      fileName: path.basename(options.input),
      absolutePath: options.input,
      fileSizeBytes: fileStat.size,
      sha256: sourceHash,
      pdfPageCount: pageCount,
      pdfMetadata: metadata,
    };
    const verificationCandidates = {
      outlineCandidates,
      ...textCandidates,
    };
    const outputDir = options.outDir || path.resolve(
      'pdf-intake-output',
      path.parse(options.input).name.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_') + '-' + sourceHash.slice(0, 8),
    );
    await prepareOutputDirectory(outputDir);

    const report = {
      schemaVersion: '1.0.0',
      toolVersion: TOOL_VERSION,
      generatedAt: new Date().toISOString(),
      status: 'awaiting_human_confirmation',
      source,
      extraction: {
        engine: 'pdfjs-dist',
        ocrMode: options.ocrMode,
        ocrPageSelection: describeOcrPageSelection(options.ocrPageSelection),
        ocrPageNumbering: 'original_pdf_1_based',
        ocrLanguages: options.languages,
        ocrDpi: options.dpi,
        minTextChars: options.minTextChars,
        tocScanPages: options.tocScanPages,
        textLayerPageCounts: {
          searchableTextPresent: pageRecords.filter((page) => page.quality.visibleChars >= options.minTextChars).length,
          sparseTextLayer: pageRecords.filter((page) => page.quality.visibleChars > 0 && page.quality.visibleChars < options.minTextChars).length,
          noTextLayer: pageRecords.filter((page) => page.quality.visibleChars === 0).length,
        },
        ocrPageCounts: {
          attempted: needsOcr.length,
          completed: pageRecords.filter((page) => page.ocr.status === 'ocr_completed_needs_manual_review').length,
          failed: pageRecords.filter((page) => page.ocr.status === 'ocr_failed').length,
          notRun: pageRecords.filter((page) => page.ocr.status.startsWith('not_run')).length,
          skippedByPageSelection: pageRecords.filter((page) => page.ocr.status === 'skipped_outside_ocr_page_selection').length,
        },
        pageSummaries: pageRecords.map((page) => ({
          pdfPage: page.pdfPage,
          pageLabel: page.pageLabel,
          sizePoints: page.sizePoints,
          selectedMethod: page.selectedMethod,
          textLayerStatus: page.textLayerStatus,
          quality: page.quality,
          ocr: {
            status: page.ocr.status,
            confidence: page.ocr.confidence,
            error: page.ocr.error || null,
          },
        })),
      },
      candidates: verificationCandidates,
      verification: {
        selectedPdfPages: selectedPages,
        status: 'awaiting_manual_comparison_with_original_pdf',
        automaticAccuracyClaim: false,
      },
      questionImport: {
        status: 'awaiting_human_confirmation',
        generatedQuestionCount: 0,
        questions: [],
        note: 'この取り込み処理は問題文、選択肢、正答、解説を推測・生成しません。原本確認後に人が登録してください。',
      },
      outputFiles: [
        'intake-report.json',
        'page-text.jsonl',
        'question-candidates.json',
        'verification.md',
      ],
    };
    const pendingQuestions = {
      schemaVersion: '1.0.0',
      status: 'awaiting_human_confirmation',
      sourceDocumentSha256: sourceHash,
      manualReviewRequired: true,
      questions: [],
      note: '問題候補は未生成です。教材PDFの記載を確認するまで問題データを作成しないでください。',
    };

    await writeNewOutputFile(
      outputDir,
      'page-text.jsonl',
      pageRecords.map((page) => JSON.stringify({
        pdfPage: page.pdfPage,
        printedPageLabel: page.pageLabel,
        extractionMethod: page.selectedMethod,
        textLayerStatus: page.textLayerStatus,
        nativeText: page.nativeText,
        ocrText: page.ocr.text,
        selectedText: page.selectedText,
        quality: page.quality,
        ocr: { status: page.ocr.status, confidence: page.ocr.confidence, error: page.ocr.error || null },
      })).join('\n') + '\n',
    );
    await writeNewOutputFile(outputDir, 'intake-report.json', JSON.stringify(report, null, 2) + '\n');
    await writeNewOutputFile(outputDir, 'question-candidates.json', JSON.stringify(pendingQuestions, null, 2) + '\n');
    await writeNewOutputFile(
      outputDir,
      'verification.md',
      buildVerificationMarkdown({
        source,
        pages: selectedPages,
        pageRecords,
        candidates: { outlineCandidates, ...textCandidates },
        options,
      }),
    );

    console.log('');
    console.log('取り込み確認用ファイルを作成しました: ' + outputDir);
    console.log('  PDFページ数: ' + pageCount);
    console.log('  目視確認ページ: ' + selectedPages.join(', '));
    console.log('  OCR実行ページ: ' + report.extraction.ocrPageCounts.completed + ' / ' + needsOcr.length + ' 成功');
    console.log('  問題データ: 0件（確認待ち）');
    console.log('  原本照合: verification.md を確認してください。');
  } finally {
    if (ocrWorker) await ocrWorker.terminate().catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (pdfDocument) await pdfDocument.destroy().catch(() => {});
    else await loadingTask.destroy().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await run(options);
}

main().catch((error) => {
  console.error('PDF取り込みを完了できませんでした: ' + error.message);
  process.exitCode = 1;
});
