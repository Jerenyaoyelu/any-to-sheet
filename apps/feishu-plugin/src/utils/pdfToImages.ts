import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { HostAttachmentItem } from '@table-ai/core';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_CANVAS_EDGE = 2400;

export interface PdfConvertOptions {
  /** Max pages rendered per PDF to keep LLM latency & cost under control */
  maxPages?: number;
  /** Render scale (2.0 gives ~144-200 DPI crisp OCR quality for invoices/tables) */
  scale?: number;
  onProgress?: (text: string) => void;
}

export interface PreparedFilesResult {
  files: File[];
  skippedPdfPages: number;
}

export function isPdfFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/**
 * Renders every page of a PDF (including scanned invoices/contracts/resumes)
 * into high-resolution JPEG File objects directly in the browser.
 * Properly cleans up page & document resources to avoid WebView memory leaks.
 */
export async function convertPdfToImages(
  pdfFile: File,
  options: PdfConvertOptions = {}
): Promise<PreparedFilesResult> {
  const { maxPages = 5, scale = 2.0, onProgress } = options;
  const arrayBuffer = await pdfFile.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;

  const totalPages = Math.min(pdfDoc.numPages, maxPages);
  const skippedPdfPages = Math.max(0, pdfDoc.numPages - totalPages);
  const baseName = pdfFile.name.replace(/\.pdf$/i, '');
  const imageFiles: File[] = [];

  try {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      onProgress?.(`正在转换 PDF「${pdfFile.name}」第 ${pageNum}/${totalPages} 页...`);
      const page = await pdfDoc.getPage(pageNum);
      try {
        const baseViewport = page.getViewport({ scale: 1.0 });
        const maxSide = Math.max(baseViewport.width, baseViewport.height);
        const safeScale =
          maxSide * scale > MAX_CANVAS_EDGE ? MAX_CANVAS_EDGE / maxSide : scale;
        const viewport = page.getViewport({ scale: safeScale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('浏览器 Canvas 初始化失败，无法渲染 PDF');
        }

        // Fill white background so transparent PDFs don't turn black in JPEG
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        }).promise;

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('PDF 页面导出 JPEG 失败'))),
            'image/jpeg',
            0.9
          );
        });

        // Release canvas backing store immediately
        canvas.width = 0;
        canvas.height = 0;

        const pageName =
          totalPages === 1 ? `${baseName}.jpg` : `${baseName}_第${pageNum}页.jpg`;
        imageFiles.push(new File([blob], pageName, { type: 'image/jpeg' }));
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await pdfDoc.cleanup();
    await loadingTask.destroy();
  }

  return { files: imageFiles, skippedPdfPages };
}

/**
 * Downloads a Feishu temporary attachment URL via our backend CORS proxy
 * (or uses the local mock File directly in browser preview mode).
 */
export async function resolveAttachmentToFile(att: HostAttachmentItem): Promise<File> {
  if (att.file) return att.file;
  if (!att.url) {
    throw new Error(`附件「${att.fileName}」缺少可用下载地址`);
  }

  const res = await fetch('/api/fetch-attachment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: att.url }),
  });

  if (!res.ok) {
    let errMsg = `拉取附件失败 (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) errMsg = json.error;
    } catch {
      // ignore non-JSON error
    }
    throw new Error(errMsg);
  }

  const blob = await res.blob();
  const mime = att.mimeType || blob.type || 'application/octet-stream';
  return new File([blob], att.fileName, { type: mime });
}

/**
 * Normalizes a mixed list of images, PDFs, and text files:
 * PDFs are rendered page-by-page into HD JPEG images so Vision LLMs handle scanned documents cleanly.
 */
export async function prepareFilesForExtraction(
  inputFiles: File[],
  options: PdfConvertOptions = {}
): Promise<PreparedFilesResult> {
  const prepared: File[] = [];
  let skippedPdfPages = 0;
  for (const file of inputFiles) {
    if (isPdfFile(file)) {
      const res = await convertPdfToImages(file, options);
      prepared.push(...res.files);
      skippedPdfPages += res.skippedPdfPages;
    } else {
      prepared.push(file);
    }
  }
  return { files: prepared, skippedPdfPages };
}
