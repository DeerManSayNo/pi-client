"use client";

import { useEffect, useState, useRef, useCallback, type ClipboardEvent, type FormEvent } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTheme } from "@/hooks/useTheme";
import { encodeFilePathForApi, getFileName, getRelativeFilePath, joinFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";

interface Props {
  filePath: string;
  cwd?: string;
}

interface FileData {
  content: string;
  language: string;
  size: number;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "ogv", "mov", "mkv"]);

function getPathExt(filePath: string): string {
  const withoutSuffix = filePath.split(/[?#]/, 1)[0];
  return getFileName(withoutSuffix).toLowerCase().split(".").pop() ?? "";
}

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTS.has(getPathExt(filePath));
}

function isAudioPath(filePath: string): boolean {
  return AUDIO_EXTS.has(getPathExt(filePath));
}

function isVideoPath(filePath: string): boolean {
  return VIDEO_EXTS.has(getPathExt(filePath));
}

function getDirectoryPath(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
}

function isExternalMarkdownResource(src: string): boolean {
  return /^(?:https?:|data:|blob:|mailto:|tel:|#|\/\/)/i.test(src);
}

function decodeResourcePath(resourcePath: string): string {
  try {
    return decodeURIComponent(resourcePath);
  } catch {
    return resourcePath;
  }
}

function resolveMarkdownResourcePath(src: string | undefined, markdownPath: string, cwd?: string): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  if (!trimmed || isExternalMarkdownResource(trimmed)) return trimmed;

  if (/^file:/i.test(trimmed)) {
    try {
      return decodeResourcePath(new URL(trimmed).pathname);
    } catch {
      return null;
    }
  }

  const pathPart = decodeResourcePath(trimmed.split(/[?#]/, 1)[0]);
  if (!pathPart) return null;
  if (pathPart.startsWith("/")) {
    return cwd ? joinFilePath(cwd, pathPart.slice(1)) : pathPart;
  }
  return joinFilePath(getDirectoryPath(markdownPath), pathPart);
}

function markdownResourceUrl(src: string | undefined, markdownPath: string, cwd?: string): string | undefined {
  const resolved = resolveMarkdownResourcePath(src, markdownPath, cwd);
  if (!resolved) return undefined;
  if (resolved === src && isExternalMarkdownResource(resolved)) return resolved;
  return `/api/files/${encodeFilePathForApi(resolved)}?type=read`;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function insertHtmlAtSelection(html: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();

  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);

  if (lastNode) {
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function normalizeEditableText(text: string): string {
  return text.replace(/\u00a0/g, " ");
}

function normalizeRenderedPlainText(text: string): string {
  const normalized = normalizeEditableText(text).replace(/\n{3,}/g, "\n\n").trimEnd();
  return normalized ? `${normalized}\n` : "";
}

function serializeInlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeEditableText(node.textContent ?? "");
  }
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "img") {
    const src = node.dataset.markdownSrc || node.getAttribute("src") || "";
    const alt = node.getAttribute("alt") || "";
    return src ? `![${alt}](${src})` : "";
  }
  if (tag === "a") {
    const href = node.dataset.markdownHref || node.getAttribute("href") || "";
    const text = Array.from(node.childNodes).map(serializeInlineMarkdown).join("").trim() || href;
    return href ? `[${text}](${href})` : text;
  }
  if (tag === "strong" || tag === "b") {
    return `**${Array.from(node.childNodes).map(serializeInlineMarkdown).join("")}**`;
  }
  if (tag === "em" || tag === "i") {
    return `*${Array.from(node.childNodes).map(serializeInlineMarkdown).join("")}*`;
  }
  if (tag === "code") {
    return `\`${normalizeEditableText(node.textContent ?? "")}\``;
  }
  return Array.from(node.childNodes).map(serializeInlineMarkdown).join("");
}

function serializeBlockMarkdown(node: Node, listDepth = 0, orderedIndex = 1): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeEditableText(node.textContent ?? "").trim();
  }
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
    const level = Number(tag.slice(1));
    return `${"#".repeat(level)} ${Array.from(node.childNodes).map(serializeInlineMarkdown).join("").trim()}`;
  }
  if (tag === "p" || tag === "div") {
    return Array.from(node.childNodes).map(serializeInlineMarkdown).join("").trim();
  }
  if (tag === "blockquote") {
    const body = Array.from(node.childNodes).map((child) => serializeBlockMarkdown(child, listDepth)).filter(Boolean).join("\n\n");
    return body.split("\n").map((line) => `> ${line}`).join("\n");
  }
  if (tag === "pre") {
    const code = node.querySelector("code")?.textContent ?? node.textContent ?? "";
    return `\`\`\`\n${code.replace(/\n$/, "")}\n\`\`\``;
  }
  if (tag === "ul" || tag === "ol") {
    const items = Array.from(node.children).filter((child) => child.tagName.toLowerCase() === "li");
    return items.map((item, index) => serializeBlockMarkdown(item, listDepth, index + 1)).join("\n");
  }
  if (tag === "li") {
    const prefix = node.parentElement?.tagName.toLowerCase() === "ol" ? `${orderedIndex}. ` : "- ";
    const indent = "  ".repeat(listDepth);
    const inlineParts: string[] = [];
    const nestedParts: string[] = [];
    Array.from(node.childNodes).forEach((child) => {
      if (child instanceof HTMLElement && ["ul", "ol"].includes(child.tagName.toLowerCase())) {
        nestedParts.push(serializeBlockMarkdown(child, listDepth + 1));
      } else {
        inlineParts.push(serializeInlineMarkdown(child));
      }
    });
    const firstLine = `${indent}${prefix}${inlineParts.join("").trim()}`;
    return [firstLine, ...nestedParts].filter(Boolean).join("\n");
  }
  if (tag === "hr") return "---";
  if (tag === "table") {
    return normalizeEditableText(node.innerText ?? "").trim();
  }

  return Array.from(node.childNodes).map((child) => serializeBlockMarkdown(child, listDepth)).filter(Boolean).join("\n\n");
}

function markdownFromEditableElement(root: HTMLElement): string {
  const blocks = Array.from(root.childNodes)
    .map((node) => serializeBlockMarkdown(node).trimEnd())
    .filter((block) => block.length > 0);
  const content = blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return content ? `${content}\n` : "";
}

function getImagesInSelection(root: HTMLElement): HTMLImageElement[] {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  return Array.from(root.querySelectorAll("img")).filter((img) => range.intersectsNode(img));
}

function selectImageElement(img: HTMLImageElement): void {
  const range = document.createRange();
  range.selectNode(img);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function imageElementToDataUrl(img: HTMLImageElement): string | null {
  if (!img.complete || img.naturalWidth === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function wrapHtmlClipboardFragment(html: string): string {
  return `<!DOCTYPE html><html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`;
}

function buildRichClipboardFromRange(root: HTMLElement, range: Range): { html: string; plainText: string } {
  const fragment = range.cloneContents();
  const container = document.createElement("div");
  container.appendChild(fragment);

  const dataUrlBySrc = new Map<string, string>();
  for (const img of getImagesInSelection(root)) {
    const dataUrl = imageElementToDataUrl(img);
    if (!dataUrl) continue;
    const currentSrc = img.currentSrc;
    const attrSrc = img.getAttribute("src") ?? "";
    const markdownSrc = img.dataset.markdownSrc ?? "";
    for (const src of [currentSrc, attrSrc, markdownSrc]) {
      if (src) dataUrlBySrc.set(src, dataUrl);
    }
  }

  container.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const dataUrl = dataUrlBySrc.get(src) || dataUrlBySrc.get(img.dataset.markdownSrc ?? "");
    if (dataUrl) {
      img.setAttribute("src", dataUrl);
      img.removeAttribute("data-markdown-src");
    }
  });

  return {
    html: wrapHtmlClipboardFragment(container.innerHTML),
    plainText: normalizeEditableText(container.innerText),
  };
}

async function readClipboardHtml(dataTransfer: DataTransfer): Promise<string> {
  const htmlItem = Array.from(dataTransfer.items).find((item) => item.type === "text/html");
  if (htmlItem) {
    return await new Promise<string>((resolve) => htmlItem.getAsString(resolve));
  }
  return dataTransfer.getData("text/html");
}

function dataUrlToFile(dataUrl: string, fileName: string): File | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const data = match[3];
  try {
    if (isBase64) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], fileName, { type: mime });
    }
    return new File([decodeURIComponent(data)], fileName, { type: mime });
  } catch {
    return null;
  }
}

async function replaceHtmlImagesWithUploadedUrls(
  html: string,
  uploadImage: (file: File) => Promise<{ markdownPath: string; url: string }>,
): Promise<string | null> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = Array.from(doc.body.querySelectorAll("img"));
  if (images.length === 0) return null;

  let imageIndex = 0;
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith("data:")) continue;
    const file = dataUrlToFile(src, `paste-${Date.now()}-${imageIndex++}.png`);
    if (!file) continue;
    const uploaded = await uploadImage(file);
    img.setAttribute("src", uploaded.url);
    img.setAttribute("data-markdown-src", uploaded.markdownPath);
    img.removeAttribute("style");
  }

  return doc.body.innerHTML;
}

function isVideoResourceSrc(src: string | undefined): boolean {
  return Boolean(src && !isExternalMarkdownResource(src.trim()) && isVideoPath(src));
}

type DiffLine =
  | { type: "unchanged"; text: string; lineNo: number }
  | { type: "removed"; text: string; lineNo: number }
  | { type: "added"; text: string; lineNo: number };

type MarkdownSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </svg>
  );
}

function PreviewIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function SourcePreviewToggle({
  previewMode,
  setPreviewMode,
  sourceLabel = "查看源码",
  previewLabel = "预览",
  onPreviewDoubleClick,
}: {
  previewMode: boolean;
  setPreviewMode: (preview: boolean) => void;
  sourceLabel?: string;
  previewLabel?: string;
  onPreviewDoubleClick?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexShrink: 0, borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
      <button
        onClick={() => setPreviewMode(false)}
        aria-label={sourceLabel}
        title="源码"
        style={{
          width: 28, height: 24, padding: 0, fontSize: 11, border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
          color: !previewMode ? "var(--text)" : "var(--text-muted)",
          fontWeight: !previewMode ? 600 : 400,
        }}
      >
        <CodeIcon />
      </button>
      <button
        onClick={() => setPreviewMode(true)}
        onDoubleClick={(e) => {
          e.preventDefault();
          onPreviewDoubleClick?.();
        }}
        aria-label={previewLabel}
        title="预览"
        style={{
          width: 28, height: 24, padding: 0, fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
          color: previewMode ? "var(--text)" : "var(--text-muted)",
          fontWeight: previewMode ? 600 : 400,
        }}
      >
        <PreviewIcon />
      </button>
    </div>
  );
}

function MiddleEllipsisPath({ path, title }: { path: string; title?: string }) {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const prefix = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;

  return (
    <span
      title={title ?? path}
      style={{
        display: "inline-flex",
        alignItems: "center",
        minWidth: 0,
        flex: "1 1 auto",
        overflow: "hidden",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-mono)",
      }}
    >
      {prefix && (
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {prefix}
        </span>
      )}
      <span style={{ flexShrink: 0 }}>{fileName}</span>
    </span>
  );
}

// Myers diff — returns line-level unified diff
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max];
      } else {
        x = v[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= m && y >= n) {
        // backtrack
        const result: DiffLine[] = [];
        let cx = m, cy = n;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd - 1];
          const pk = cx - cy;
          let prevK: number;
          if (pk === -dd || (pk !== dd && pv[pk - 1 + max] < pv[pk + 1 + max])) {
            prevK = pk + 1;
          } else {
            prevK = pk - 1;
          }
          const prevX = pv[prevK + max];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
          }
          if (dd > 0) {
            if (cx > prevX) {
              cx--;
              result.unshift({ type: "removed", text: oldLines[cx], lineNo: cx + 1 });
            } else {
              cy--;
              result.unshift({ type: "added", text: newLines[cy], lineNo: cy + 1 });
            }
          }
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
        }
        return result;
      }
    }
  }
  // Fallback: treat all as replaced
  return [
    ...oldLines.map((t, i) => ({ type: "removed" as const, text: t, lineNo: i + 1 })),
    ...newLines.map((t, i) => ({ type: "added" as const, text: t, lineNo: i + 1 })),
  ];
}

function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string; language: string }) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = diffLines(oldLines, newLines);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        无修改内容
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  // Track running line number for added/unchanged lines
  const newLineNos: number[] = [];
  let nlo = 1;
  for (const line of diff) {
    if (line.type === "removed") {
      newLineNos.push(0);
    } else {
      newLineNos.push(nlo++);
    }
  }

  let diffIdx = 0;

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.6 }}>
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              ... {seg.count} 行未修改的内容 ...
            </div>
          );
          diffIdx += seg.count;
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          const idx = diffIdx + li;
          const newLno = newLineNos[idx];
          const bg =
            line.type === "added"
              ? "rgba(0,200,80,0.12)"
              : line.type === "removed"
              ? "rgba(240,60,60,0.14)"
              : "transparent";
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "#4ade80" : line.type === "removed" ? "#f87171" : "var(--text-dim)";

          return (
            <div
              key={li}
              style={{
                display: "flex",
                background: bg,
                borderLeft: line.type === "added"
                  ? "3px solid #4ade80"
                  : line.type === "removed"
                  ? "3px solid #f87171"
                  : "3px solid transparent",
              }}
            >
              <span
                style={{
                  minWidth: 44,
                  padding: "0 8px 0 16px",
                  textAlign: "right",
                  color: "var(--text-dim)",
                  userSelect: "none",
                  fontSize: 11,
                  lineHeight: 1.6,
                  borderRight: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  flexShrink: 0,
                }}
              >
                {line.type === "removed" ? line.lineNo : newLno || ""}
              </span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                  fontWeight: 600,
                }}
              >
                {prefix}
              </span>
              <span
                style={{
                  flex: 1,
                  padding: "0 8px 0 0",
                  whiteSpace: "pre",
                  color: "var(--text)",
                  overflowX: "auto",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
        });
        diffIdx += seg.lines.length;
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

function EditableMarkdownPreview({
  content,
  filePath,
  cwd,
  onChange,
  uploadImage,
  previewRootRef,
}: {
  content: string;
  filePath: string;
  cwd?: string;
  onChange: (content: string) => void;
  uploadImage: (file: File) => Promise<{ markdownPath: string; url: string }>;
  previewRootRef?: { current: HTMLDivElement | null };
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const setRootElement = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    if (previewRootRef) {
      previewRootRef.current = element;
    }
  }, [previewRootRef]);

  const emitChange = useCallback(() => {
    if (!rootRef.current) return;
    onChange(markdownFromEditableElement(rootRef.current));
  }, [onChange]);

  const handleInput = useCallback((event: FormEvent<HTMLDivElement>) => {
    event.currentTarget.querySelectorAll("img").forEach((img) => {
      if (!img.dataset.markdownSrc && img.getAttribute("src")) {
        img.dataset.markdownSrc = img.getAttribute("src") ?? "";
      }
    });
    emitChange();
  }, [emitChange]);

  const handlePaste = useCallback(async (event: ClipboardEvent<HTMLDivElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    const html = await readClipboardHtml(event.clipboardData);

    if (imageFiles.length === 0 && html.includes("<img")) {
      event.preventDefault();
      try {
        const processedHtml = await replaceHtmlImagesWithUploadedUrls(html, uploadImage);
        if (processedHtml) {
          insertHtmlAtSelection(processedHtml);
          emitChange();
          return;
        }
      } catch {
        // Fall through to default paste when rich HTML cannot be processed.
      }
    }

    if (imageFiles.length === 0) return;

    event.preventDefault();
    for (const file of imageFiles) {
      const uploaded = await uploadImage(file);
      insertHtmlAtSelection(
        `<img src="${escapeHtmlAttr(uploaded.url)}" alt="" data-markdown-src="${escapeHtmlAttr(uploaded.markdownPath)}" style="max-width:100%;height:auto;border-radius:6px;margin:8px 0;" />`
      );
    }
    emitChange();
  }, [emitChange, uploadImage]);

  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;

    const payload = buildRichClipboardFromRange(root, range);
    if (!payload.html.includes("<img") && !payload.plainText) return;

    event.preventDefault();
    event.clipboardData.setData("text/html", payload.html);
    event.clipboardData.setData("text/plain", payload.plainText || selection.toString());
  }, []);

  return (
    <div
      ref={setRootElement}
      className="markdown-body markdown-file-preview markdown-editable-preview"
      contentEditable
      suppressContentEditableWarning
      spellCheck
      tabIndex={0}
      onInput={handleInput}
      onPaste={handlePaste}
      onCopy={handleCopy}
      style={{
        padding: "24px 32px",
        maxWidth: 800,
        minHeight: "100%",
        outline: "none",
        cursor: "text",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const srcText = typeof src === "string" ? src : undefined;
            const mediaSrc = markdownResourceUrl(srcText, filePath, cwd);
            if (isVideoResourceSrc(srcText)) {
              return (
                <video
                  controls
                  preload="metadata"
                  src={mediaSrc}
                  title={alt ?? srcText}
                  style={{ maxWidth: "100%", borderRadius: 8, background: "#000", margin: "8px 0" }}
                />
              );
            }
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mediaSrc}
                alt={alt ?? ""}
                data-markdown-src={srcText ?? ""}
                onClick={(event) => {
                  event.preventDefault();
                  selectImageElement(event.currentTarget);
                }}
                style={{ maxWidth: "100%", height: "auto", borderRadius: 6, margin: "8px 0", cursor: "pointer" }}
              />
            );
          },
          a: ({ href, children }) => {
            const mediaSrc = markdownResourceUrl(href, filePath, cwd);
            if (isVideoResourceSrc(href)) {
              return (
                <video
                  controls
                  preload="metadata"
                  src={mediaSrc}
                  title={typeof children === "string" ? children : href}
                  style={{ display: "block", maxWidth: "100%", borderRadius: 8, background: "#000", margin: "8px 0" }}
                />
              );
            }
            return <a href={href} data-markdown-href={href}>{children}</a>;
          },
          ul: ({ children }) => (
            <ul style={{ listStyleType: "disc", listStylePosition: "outside", paddingLeft: 24, margin: "4px 0 12px" }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol style={{ listStyleType: "decimal", listStylePosition: "outside", paddingLeft: 24, margin: "4px 0 12px" }}>
              {children}
            </ol>
          ),
          li: ({ children }) => <li style={{ display: "list-item", margin: "3px 0" }}>{children}</li>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function ImageViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath]);

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <MiddleEllipsisPath path={getRelativeFilePath(filePath, cwd)} title={filePath} />
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>{ext || "image"}</span>
        {naturalSize && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{formatSizeStr}</span>}
        <span
          title={watching ? "实时同步已启用" : "未监听"}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "实时" : "静态"}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError("图片加载失败")}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath]);

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <MiddleEllipsisPath path={getRelativeFilePath(filePath, cwd)} title={filePath} />
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>{ext || "audio"}</span>
        {duration != null && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{formatDuration(duration)}</span>}
        {size != null && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{formatSize(size)}</span>}
        <span
          title={watching ? "实时同步已启用" : "未监听"}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "实时" : "静态"}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("音频加载失败")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function VideoViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath]);

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <MiddleEllipsisPath path={getRelativeFilePath(filePath, cwd)} title={filePath} />
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>{ext || "video"}</span>
        {duration != null && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{formatDuration(duration)}</span>}
        {size != null && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{formatSize(size)}</span>}
        <span
          title={watching ? "实时同步已启用" : "未监听"}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "实时" : "静态"}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          background: "var(--bg-panel)",
          overflow: "auto",
        }}
      >
        <div style={{ width: "min(960px, 100%)" }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <video
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("视频加载失败")}
            style={{
              width: "100%",
              maxHeight: "calc(100vh - 160px)",
              background: "#000",
              borderRadius: 8,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function FileViewer({ filePath, cwd }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} />;
  }
  if (isVideoPath(filePath)) {
    return <VideoViewer filePath={filePath} cwd={cwd} />;
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} />;
}

function TextFileViewer({ filePath, cwd }: Props) {
  const { isDark } = useTheme();
  const [data, setData] = useState<FileData | null>(null);
  const [prevContent, setPrevContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [viewMode, setViewMode] = useState<"source" | "diff">("source");
  const [watching, setWatching] = useState(false);
  const [changeCount, setChangeCount] = useState(0);
  const [copiedFullText, setCopiedFullText] = useState(false);
  const [saveState, setSaveState] = useState<MarkdownSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContentRef = useRef("");
  const markdownPreviewRootRef = useRef<HTMLDivElement | null>(null);
  const htmlPreviewFrameRef = useRef<HTMLIFrameElement | null>(null);

  const fetchContent = useCallback((filePath: string, isRefresh = false) => {
    const encoded = encodeFilePathForApi(filePath);
    return fetch(`/api/files/${encoded}?type=read`)
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (d.error) {
          setError(d.error);
          return null;
        }
        if (isRefresh) {
          setData((prev) => {
            if (prev && d.content === latestContentRef.current) {
              return { ...prev, language: d.language, size: d.size };
            }
            if (prev) setPrevContent(prev.content);
            return d;
          });
          setChangeCount((c) => c + 1);
        } else {
          setData(d);
        }
        latestContentRef.current = d.content;
        return d;
      })
      .catch((e) => {
        setError(String(e));
        return null;
      });
  }, []);

  const copyFullText = useCallback(async () => {
    if (!data) return;
    try {
      const renderedText =
        data.language === "markdown" && previewMode && markdownPreviewRootRef.current
          ? normalizeRenderedPlainText(markdownPreviewRootRef.current.innerText)
          : data.language === "html" && previewMode
          ? normalizeRenderedPlainText(htmlPreviewFrameRef.current?.contentDocument?.body?.innerText ?? "")
          : "";
      await navigator.clipboard.writeText(renderedText || latestContentRef.current || data.content);
      setCopiedFullText(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedFullText(false), 1500);
    } catch {
      // Clipboard can be unavailable outside secure contexts.
    }
  }, [data]);

  const saveMarkdownContent = useCallback(async (content: string) => {
    const encoded = encodeFilePathForApi(filePath);
    setSaveState("saving");
    setSaveError(null);
    try {
      const response = await fetch(`/api/files/${encoded}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; size?: number };
      if (!response.ok || result.error) {
        throw new Error(result.error ?? `保存失败 (${response.status})`);
      }
      setSaveState("saved");
      setData((prev) => prev ? { ...prev, size: result.size ?? new Blob([content]).size } : prev);
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }, [filePath]);

  const scheduleMarkdownSave = useCallback((content: string) => {
    latestContentRef.current = content;
    setSaveState("dirty");
    setSaveError(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveMarkdownContent(content);
    }, 700);
  }, [saveMarkdownContent]);

  const uploadMarkdownImage = useCallback(async (file: File) => {
    const encoded = encodeFilePathForApi(filePath);
    const form = new FormData();
    form.append("image", file);
    const response = await fetch(`/api/files/${encoded}?type=upload-markdown-image`, {
      method: "POST",
      body: form,
    });
    const result = await response.json().catch(() => ({})) as { error?: string; markdownPath?: string };
    if (!response.ok || result.error || !result.markdownPath) {
      const message = result.error ?? `图片上传失败 (${response.status})`;
      setSaveState("error");
      setSaveError(message);
      throw new Error(message);
    }
    return {
      markdownPath: result.markdownPath,
      url: markdownResourceUrl(result.markdownPath, filePath, cwd) ?? result.markdownPath,
    };
  }, [cwd, filePath]);

  // Initial load + SSE watch setup
  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setPrevContent(null);
    setPreviewMode(false);
    setViewMode("source");
    setChangeCount(0);
    setCopiedFullText(false);
    setSaveState("idle");
    setSaveError(null);
    latestContentRef.current = "";
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    fetchContent(filePath).then((d) => {
      if (d?.language === "markdown" || d?.language === "html") setPreviewMode(true);
    }).finally(() => setLoading(false));

    // Set up SSE watch
    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
    });

    es.addEventListener("change", () => {
      fetchContent(filePath, true);
    });

    es.addEventListener("error", () => {
      setWatching(false);
    });

    es.onerror = () => {
      setWatching(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, fetchContent]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!data) return null;

  const isHtml = data.language === "html";
  const isMarkdown = data.language === "markdown";
  const sourceContent = isMarkdown ? (latestContentRef.current || data.content) : data.content;
  const lines = sourceContent.split("\n");
  const hasDiff = prevContent !== null && prevContent !== sourceContent;
  const saveLabel =
    saveState === "dirty" ? "未保存"
    : saveState === "saving" ? "保存中..."
    : saveState === "saved" ? "已保存"
    : saveState === "error" ? "保存失败"
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <MiddleEllipsisPath path={getRelativeFilePath(filePath, cwd)} title={filePath} />
        <span style={{ marginLeft: "auto", flexShrink: 0 }}>{data.language}</span>
        {viewMode === "source" && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{lines.length} 行</span>}
        <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{formatSize(data.size)}</span>
        {isMarkdown && saveLabel && (
          <span
            title={saveError ?? undefined}
            style={{
              flexShrink: 0,
              whiteSpace: "nowrap",
              color: saveState === "error" ? "#f87171" : saveState === "saved" ? "#4ade80" : "var(--text-dim)",
            }}
          >
            {saveLabel}
          </span>
        )}

        {/* Live watch indicator */}
        <span
          title={watching ? "实时同步已启用" : "未监听"}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "实时" : "静态"}
        </span>

        {/* Diff / Source toggle — shown only when there are changes */}
        {hasDiff && (
          <div style={{ display: "flex", flexShrink: 0, borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              onClick={() => setViewMode("source")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                background: viewMode === "source" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "source" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "source" ? 600 : 400,
              }}
            >
              源码
            </button>
            <button
              onClick={() => setViewMode("diff")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                background: viewMode === "diff" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "diff" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "diff" ? 600 : 400,
              }}
            >
              对比 {changeCount > 0 && <span style={{ color: "#4ade80", marginLeft: 2 }}>+{changeCount}</span>}
            </button>
          </div>
        )}

        {/* Source / Preview toggle */}
        {(isHtml || isMarkdown) && viewMode === "source" && (
          <SourcePreviewToggle
            previewMode={previewMode}
            setPreviewMode={setPreviewMode}
            sourceLabel={isHtml ? "查看 HTML 源码" : "查看 Markdown 源码"}
            previewLabel={isHtml ? "预览 HTML" : "预览 Markdown"}
            onPreviewDoubleClick={copyFullText}
          />
        )}
      </div>

      {copiedFullText && (
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            top: 48,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          已复制全文
        </div>
      )}

      {/* Content area */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
        {viewMode === "diff" && hasDiff ? (
          <DiffView oldContent={prevContent!} newContent={sourceContent} language={data.language} />
        ) : isHtml && previewMode ? (
          <iframe
            ref={htmlPreviewFrameRef}
            srcDoc={data.content}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
            title="HTML 预览"
          />
        ) : isMarkdown && previewMode ? (
          <EditableMarkdownPreview
            content={data.content}
            filePath={filePath}
            cwd={cwd}
            onChange={scheduleMarkdownSave}
            uploadImage={uploadMarkdownImage}
            previewRootRef={markdownPreviewRootRef}
          />
        ) : (
          <SyntaxHighlighter
            language={data.language === "text" ? "plaintext" : data.language}
            style={isDark ? vscDarkPlus : vs}
            showLineNumbers
            lineNumberStyle={{
              color: "var(--text-dim)",
              fontStyle: "normal",
              minWidth: "3em",
              paddingRight: "1em",
            }}
            customStyle={{
              margin: 0,
              padding: "12px 0",
              background: "var(--bg)",
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily: "var(--font-mono)",
              minHeight: "100%",
            }}
            codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
            wrapLongLines={false}
          >
            {sourceContent}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
